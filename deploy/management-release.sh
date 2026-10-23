#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:?CHECK or DEPLOY required}"
WEB_TAG="${2:?web image tag required}"
WORKER_TAG="${3:?worker image tag required}"

case "$MODE" in CHECK|DEPLOY) ;; *) echo 'INVALID_MODE'; exit 2 ;; esac
for tag in "$WEB_TAG" "$WORKER_TAG"; do
  [[ "$tag" =~ ^sha-[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || { echo 'INVALID_IMAGE_TAG'; exit 2; }
done

cd /opt/schutz-monitoring
project=schutz-monitoring
web_container=schutz-monitoring-management-web-1
worker_container=schutz-monitoring-management-worker-1
db_container=schutz-monitoring-management-db-1

mapfile -t files < <(docker compose ls --format json | python3 -c '
import json,sys
for item in json.load(sys.stdin):
    if item.get("Name") == "schutz-monitoring":
        print("\n".join(item["ConfigFiles"].split(",")))
')
[[ ${#files[@]} -eq 8 ]] || { echo 'COMPOSE_FILE_COUNT_MISMATCH'; exit 1; }
args=()
for f in "${files[@]}"; do
  [[ -f "$f" ]] || { echo 'COMPOSE_FILE_MISSING'; exit 1; }
  args+=(-f "$f")
done

old_web=$(docker inspect "$web_container" --format '{{.Config.Image}}')
old_worker=$(docker inspect "$worker_container" --format '{{.Config.Image}}')
[[ $(docker inspect "$db_container" --format '{{.State.Health.Status}}') == healthy ]] || { echo 'MANAGEMENT_DB_NOT_HEALTHY'; exit 1; }

account=$(aws sts get-caller-identity --query Account --output text)
registry="${account}.dkr.ecr.ap-northeast-2.amazonaws.com"
new_web="${registry}/schutz/management-web:${WEB_TAG}"
new_worker="${registry}/schutz/management-worker:${WORKER_TAG}"
docker image inspect "$new_web" >/dev/null
docker image inspect "$new_worker" >/dev/null

export SCHUTZ_WEB_IMAGE="$new_web" SCHUTZ_WORKER_IMAGE="$new_worker"
# Validate the override against all eight active files WITHOUT modifying the originals.
temp_override=$(mktemp ./compose.cd-check.XXXXXXXX.yaml)
trap 'rm -f "$temp_override"' EXIT
python3 - "$temp_override" <<'PY'
from pathlib import Path
import os, sys
Path(sys.argv[1]).write_text('services:\n  management-web:\n    image: '+os.environ['SCHUTZ_WEB_IMAGE']+'\n  management-worker:\n    image: '+os.environ['SCHUTZ_WORKER_IMAGE']+'\n')
PY
docker compose -p "$project" "${args[@]}" -f "$temp_override" config -q

docker compose -p "$project" "${args[@]}" -f "$temp_override" config --format json | python3 -c '
import json, os, sys
s=json.load(sys.stdin)["services"]
assert s["management-web"]["image"] == os.environ["SCHUTZ_WEB_IMAGE"]
assert s["management-worker"]["image"] == os.environ["SCHUTZ_WORKER_IMAGE"]
'
echo 'MANAGEMENT_PREFLIGHT_OK'

if [[ "$MODE" == CHECK ]]; then
  echo 'MANAGEMENT_CHECK_ONLY_SUCCESS'
  echo 'CONTAINERS_UNCHANGED'
  exit 0
fi
if [[ "$old_web" == "$new_web" && "$old_worker" == "$new_worker" ]]; then
  echo 'MANAGEMENT_ALREADY_DEPLOYED'
  exit 0
fi

umask 077
backup_root=/opt/schutz-monitoring/.release-backups
mkdir -p "$backup_root"
chmod 700 "$backup_root"
backup_dir=$(mktemp -d "$backup_root/management-cd-XXXXXXXX")
cp -p compose.ecr.yaml "$backup_dir/compose.ecr.yaml"
printf '%s\n' "$old_web" > "$backup_dir/web-image.txt"
printf '%s\n' "$old_worker" > "$backup_dir/worker-image.txt"
echo 'MANAGEMENT_ROLLBACK_BACKUP_OK'

rollback() {
  rc=$?
  trap - ERR
  echo 'MANAGEMENT_DEPLOY_FAILED_ROLLBACK_START'
  cp -p "$backup_dir/compose.ecr.yaml" compose.ecr.yaml
  if docker compose -p "$project" "${args[@]}" up -d --no-deps --no-build --force-recreate management-web management-worker; then
    actual_web=$(docker inspect "$web_container" --format '{{.Config.Image}}' || true)
    actual_worker=$(docker inspect "$worker_container" --format '{{.Config.Image}}' || true)
    if [[ "$actual_web" == "$old_web" && "$actual_worker" == "$old_worker" ]]; then
      echo 'MANAGEMENT_ROLLBACK_IMAGE_RESTORED'
    else
      echo 'MANAGEMENT_ROLLBACK_VERIFY_FAILED'
    fi
  else
    echo 'MANAGEMENT_ROLLBACK_COMMAND_FAILED'
  fi
  exit "$rc"
}
trap rollback ERR

python3 <<'PY'
from pathlib import Path
import os,re
p=Path('compose.ecr.yaml')
lines=p.read_text().splitlines(keepends=True)
images={'management-web':os.environ['SCHUTZ_WEB_IMAGE'], 'management-worker':os.environ['SCHUTZ_WORKER_IMAGE']}
counts={s:0 for s in images}
service=None
for i,line in enumerate(lines):
    m=re.match(r'^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$',line)
    if m:
        service=m.group(1)
        continue
    if service in images and re.match(r'^    image:\s*',line):
        newline='\n' if line.endswith('\n') else ''
        lines[i]='    image: '+images[service]+newline
        counts[service]+=1
if any(v!=1 for v in counts.values()):
    raise SystemExit('COMPOSE_IMAGE_REPLACEMENT_COUNT_MISMATCH')
p.write_text(''.join(lines))
PY

docker compose -p "$project" "${args[@]}" config -q
docker compose -p "$project" "${args[@]}" up -d --no-deps --no-build --force-recreate management-web management-worker
sleep 10
[[ $(docker inspect "$web_container" --format '{{.State.Running}}') == true ]]
[[ $(docker inspect "$worker_container" --format '{{.State.Running}}') == true ]]
[[ $(docker inspect "$web_container" --format '{{.Config.Image}}') == "$new_web" ]]
[[ $(docker inspect "$worker_container" --format '{{.Config.Image}}') == "$new_worker" ]]
[[ $(docker inspect "$db_container" --format '{{.State.Health.Status}}') == healthy ]]
docker exec "$web_container" python -c 'import urllib.request; assert urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5).status == 200'
trap - ERR
echo 'MANAGEMENT_RELEASE_SUCCESS'
