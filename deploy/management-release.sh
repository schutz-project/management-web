#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:?CHECK or DEPLOY required}"
WEB_TAG="${2:?web image tag required}"
WORKER_TAG="${3:?worker image tag required}"
ROLLBACK_TEST="${4:-NO}"
rollback_test_triggered=0
case "$ROLLBACK_TEST" in
  NO) ;;
  YES) [[ "$MODE" == DEPLOY ]] || { echo INVALID_ROLLBACK_TEST_MODE; exit 2; } ;;
  *) echo INVALID_ROLLBACK_TEST; exit 2 ;;
esac

case "$MODE" in CHECK|DEPLOY) ;; *) echo 'INVALID_MODE'; exit 2 ;; esac
for tag in "$WEB_TAG" "$WORKER_TAG"; do
  [[ "$tag" =~ ^sha-[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || { echo 'INVALID_IMAGE_TAG'; exit 2; }
done

cd /opt/schutz-monitoring
umask 077
exec 9>.management-release.lock
flock -w 120 9 || { echo MANAGEMENT_RELEASE_LOCK_TIMEOUT; exit 1; }
project=schutz-monitoring
web_container=schutz-monitoring-management-web-1
worker_container=schutz-monitoring-management-worker-1
db_container=schutz-monitoring-management-db-1

wait_healthy() {
  local deadline=$((SECONDS + 180)) passes=0 logs
  while (( SECONDS < deadline )); do
    if [[ $(docker inspect "$web_container" --format '{{.State.Running}}' 2>/dev/null) == true &&
          $(docker inspect "$worker_container" --format '{{.State.Running}}' 2>/dev/null) == true &&
          $(docker inspect "$web_container" --format '{{.RestartCount}}' 2>/dev/null) == 0 &&
          $(docker inspect "$worker_container" --format '{{.RestartCount}}' 2>/dev/null) == 0 &&
          $(docker inspect "$db_container" --format '{{.State.Health.Status}}' 2>/dev/null) == healthy ]] &&
       docker exec "$web_container" python -c 'import urllib.request; assert urllib.request.urlopen("http://127.0.0.1:8000/health",timeout=5).status == 200' >/dev/null 2>&1; then
      logs=$(docker logs --since 180s "$worker_container" 2>&1) || logs=''
      if [[ "$logs" == *'probe collection complete'* &&
            "$logs" == *'login event collection complete'* &&
            "$logs" != *'unavailable'* ]]; then
        passes=$((passes + 1))
        if (( passes >= 3 )); then return 0; fi
      else
        passes=0
      fi
    else
      passes=0
    fi
    sleep 5
  done
  return 1
}

# The running Web container records the complete ordered deployment stack.
config_files=$(docker inspect schutz-monitoring-management-web-1 \
  --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')
validated_files=$(python3 - "$config_files" <<'COMPOSE_FILES_PY'
import sys
from pathlib import Path

root = "/opt/schutz-monitoring/"
required = {
    root + "compose.management-ec2.yaml",
    root + "updates/incident-drafts/compose.incident-drafts.yaml",
    root + "compose.loki-only.yaml",
    root + "compose.otel-only.yaml",
    root + "compose.prometheus-only.yaml",
    root + "compose.blackbox-only.yaml",
    root + "compose.grafana-only.yaml",
    root + "compose.ecr.yaml",
}
https = root + "compose.management-https.yaml"
files = sys.argv[1].split(",")
if len(files) != len(set(files)):
    raise SystemExit("COMPOSE_FILES_DUPLICATED")
if not required <= set(files) or set(files) - required - {https}:
    raise SystemExit("COMPOSE_FILE_SET_MISMATCH")
if https in files and files[-1] != https:
    raise SystemExit("HTTPS_OVERRIDE_MUST_BE_LAST")
if not all(Path(name).is_file() for name in files):
    raise SystemExit("COMPOSE_FILE_MISSING")
print("\n".join(files))
COMPOSE_FILES_PY
)
mapfile -t files <<< "$validated_files"

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
if [[ "$MODE" == DEPLOY ]]; then
  wait_healthy || { echo BASELINE_UNHEALTHY_NO_DEPLOYMENT; exit 1; }
  auth_dir=$(mktemp -d)
  trap 'rm -rf "$auth_dir"' EXIT
  aws ecr get-login-password --region ap-northeast-2 |
    docker --config "$auth_dir" login --username AWS --password-stdin "$registry" >/dev/null
  timeout 180 docker --config "$auth_dir" pull "$new_web" >/dev/null
  timeout 180 docker --config "$auth_dir" pull "$new_worker" >/dev/null
  rm -rf "$auth_dir"
  trap - EXIT
fi
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
  echo 'MANAGEMENT_SAME_IMAGES_REDEPLOY_REQUESTED'
fi

export SCHUTZ_OLD_WEB="$old_web" SCHUTZ_OLD_WORKER="$old_worker"
docker compose -p "$project" "${args[@]}" config --format json | python3 -c '
import json,os,sys
s=json.load(sys.stdin)["services"]
assert s["management-web"]["image"] == os.environ["SCHUTZ_OLD_WEB"]
assert s["management-worker"]["image"] == os.environ["SCHUTZ_OLD_WORKER"]
'
[[ $(docker image inspect "$old_web" --format '{{.Id}}') == $(docker inspect "$web_container" --format '{{.Image}}') ]]
[[ $(docker image inspect "$old_worker" --format '{{.Id}}') == $(docker inspect "$worker_container" --format '{{.Image}}') ]]
before_web_id=$(docker inspect "$web_container" --format '{{.Id}}')
before_worker_id=$(docker inspect "$worker_container" --format '{{.Id}}')
before_db_id=$(docker inspect "$db_container" --format '{{.Id}}')
old_web_image_id=$(docker inspect "$web_container" --format '{{.Image}}')
old_worker_image_id=$(docker inspect "$worker_container" --format '{{.Image}}')
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
  rc="${1:-$?}"
  trap - ERR INT TERM
  echo 'MANAGEMENT_DEPLOY_FAILED_ROLLBACK_START'
  cp -p "$backup_dir/compose.ecr.yaml" compose.ecr.yaml
  if docker compose -p "$project" "${args[@]}" up -d --no-deps --no-build --pull never --force-recreate management-web management-worker; then
    actual_web=$(docker inspect "$web_container" --format '{{.Config.Image}}' || true)
    actual_worker=$(docker inspect "$worker_container" --format '{{.Config.Image}}' || true)
    if [[ "$actual_web" == "$old_web" && "$actual_worker" == "$old_worker" ]] && wait_healthy; then
      echo 'MANAGEMENT_ROLLBACK_HEALTHY'
      if [[ "$rollback_test_triggered" == 1 ]]; then
        if [[ $(docker inspect "$db_container" --format '{{.Id}}') == "$before_db_id" &&
              $(docker inspect "$web_container" --format '{{.Image}}') == "$old_web_image_id" &&
              $(docker inspect "$worker_container" --format '{{.Image}}') == "$old_worker_image_id" &&
              $(docker inspect "$web_container" --format '{{.Id}}') != "$test_web_id" &&
              $(docker inspect "$worker_container" --format '{{.Id}}') != "$test_worker_id" ]] &&
           cmp -s "$backup_dir/compose.ecr.yaml" compose.ecr.yaml; then
          echo 'MANAGEMENT_ROLLBACK_TEST_SUCCESS'
          exit 0
        else
          echo 'MANAGEMENT_ROLLBACK_TEST_VERIFY_FAILED'
          exit 1
        fi
      fi
    else
      echo 'MANAGEMENT_ROLLBACK_VERIFY_FAILED'
    fi
  else
    echo 'MANAGEMENT_ROLLBACK_COMMAND_FAILED'
  fi
  exit "$rc"
}
trap rollback ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

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
docker compose -p "$project" "${args[@]}" up -d --no-deps --no-build --pull never --force-recreate management-web management-worker
sleep 10
[[ $(docker inspect "$web_container" --format '{{.State.Running}}') == true ]]
[[ $(docker inspect "$worker_container" --format '{{.State.Running}}') == true ]]
[[ $(docker inspect "$web_container" --format '{{.Config.Image}}') == "$new_web" ]]
[[ $(docker inspect "$worker_container" --format '{{.Config.Image}}') == "$new_worker" ]]
[[ $(docker inspect "$db_container" --format '{{.State.Health.Status}}') == healthy ]]
docker exec "$web_container" python -c 'import urllib.request; assert urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5).status == 200'
[[ $(docker inspect "$web_container" --format '{{.Id}}') != "$before_web_id" ]]
[[ $(docker inspect "$worker_container" --format '{{.Id}}') != "$before_worker_id" ]]
[[ $(docker inspect "$db_container" --format '{{.Id}}') == "$before_db_id" ]]
wait_healthy
if [[ "$ROLLBACK_TEST" == YES ]]; then
  test_web_id=$(docker inspect "$web_container" --format '{{.Id}}')
  test_worker_id=$(docker inspect "$worker_container" --format '{{.Id}}')
  rollback_test_triggered=1
  echo 'MANAGEMENT_ROLLBACK_TEST_TRIGGERED'
  false
fi
trap - ERR INT TERM
echo 'MANAGEMENT_CONTAINERS_RECREATED'
echo 'MANAGEMENT_WORKER_COLLECTION_OK'
echo 'MANAGEMENT_RELEASE_SUCCESS'
