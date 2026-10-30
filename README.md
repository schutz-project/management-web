# SCHUTZ Management Web

서버 상태와 관측 지표를 조회하고, 사건의 근거·AI 결과·알림 이력을 확인해 관리자가 접수·조치·종료하는 FastAPI 관리 웹입니다. 이 저장소에는 웹 코드, 공통 인증·DB 모듈, 정적 화면, Dockerfile과 CI/CD가 포함되어 있습니다.

## 코드와 실행 진입점

| 경로 | 역할 |
|---|---|
| `management/web.py` | `management.web:create_app` 앱 팩토리와 관리자 API |
| `management/incident_list.py` | 사건 목록 검색·필터·집계 |
| `management/observability.py` | 지표·로그 조회와 관측 상태 처리 |
| `management/domain.py`, `management/models.py` | 사건 처리 정책과 DB 모델 |
| `portal/` | 웹 앱이 참조하는 인증·세션·DB 등 공통 모듈 |
| `static/` | 관리 화면·세션 복원·사건 초안 및 UI 구성 요소 |
| `Dockerfile`, `requirements.txt` | 이미지 빌드와 Python 의존성 |
| `deploy/` | 기존 자동·수동 배포와 복구 스크립트 |

이미지 빌드는 저장소 루트에서 수행합니다.

```bash
docker build -t schutz-management-web:ci .
```

이미지 기본 명령은 `management.web:create_app`을 Uvicorn factory로 실행하며 포트는 8001입니다. 기존 관리 서버 Compose는 포트·HTTPS 인증서·환경 설정을 덮어쓸 수 있으므로 Dockerfile만으로 서버 실행 설정을 판단하지 않습니다. 실제 환경값은 저장소에 포함하지 않습니다.

## 문서 안내

각 문서는 해당 변경의 범위·검증·복구 이력입니다. 문서에 적힌 테스트 수나 배포 대기는 작성 시점 기록이며 현재 운영 상태를 자동으로 증명하지 않습니다.

| 주제 | 문서 |
|---|---|
| 서비스 상태 화면 기준 | [서비스 상태 설계](docs/service-state-final-design.md) |
| 모니터링 변경 이력 | [1차 개선](docs/monitoring-upgrade-stage1.md), [화면 피드백](docs/monitoring-ui-feedback.md) |
| 자원 화면 변경 이력 | [그래프 가독성](docs/resource-graph-readability.md), [현황·상세 분리](docs/resource-layout-review.md), [사용자 지정 기간](docs/resource-polish-custom-range.md) |
| 사건 UI와 관리자 처리 | [접수·조치·종료와 경보 구분](docs/incident-actions-and-alerts.md), [v3.1 검수](docs/incident-ui-v31-verification.md) |
| AI 입력 표시 | [현재 근거·과거 조치·AI 설명 구분](docs/ai-history-incident-ui.md) |
| Web·Worker 공통 경보 계약 | [Worker 저장소의 경보 통합 문서](https://github.com/schutz-project/management-worker/blob/main/docs/worker-alert-integration.md) |

공통 경보 통합 문서는 Worker 저장소에서 관리합니다. Web 쪽 변경과 검수 이력은 위 Web 전용 문서에 기록합니다.

## 검증과 배포

`.github/workflows/ci.yml`은 Node UI 회귀 시험, 격리된 브라우저 검수, 배포 검사, 이미지 빌드·import 및 Python 검증을 정의합니다. 필수 검사 이름은 `Docker build and import check`입니다.

기존 CI에는 main push 또는 수동 실행에서 조건에 따라 ECR 게시·EC2 배포를 수행하는 job이 있습니다. PR 검증과 main 병합 후 실행은 구분해야 합니다. 문서만 수정해도 해당 실행 조건을 확인해야 합니다. 배포 스크립트나 실제 Compose 파일을 이 README 정리를 이유로 제거하지 않습니다.

## 관련 저장소와 비밀정보

- [management-worker](https://github.com/schutz-project/management-worker): 수집·탐지·AI·알림 처리
- [fast-api](https://github.com/schutz-project/fast-api): 관측 대상 직원 포털
- [infra](https://github.com/schutz-project/infra): Compose·모니터링·Terraform 및 운영 기록

`.env`, 인증서 개인키, 비밀번호, API 키, 세션 토큰과 Webhook 원문을 커밋하거나 검수 로그에 남기지 않습니다.
