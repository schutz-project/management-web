# SCHUTZ Management Web

SCHUTZ 프로젝트의 **장애 사건 관리 웹 서비스**를 위한 저장소입니다.

> 현재 이 저장소에는 README만 등록되어 있습니다. 실제 관리 웹 애플리케이션 소스는 아직 이 저장소에서 확인되지 않았습니다. 아래 설명은 `infra` 저장소의 관리 서비스 Docker Compose 설정과 프로젝트에서 공유된 운영 흐름을 기준으로 정리했습니다.

## 역할

테스트용 직원 포털에서 발생한 장애를 운영자가 확인하고 처리하는 관리 화면을 제공합니다.

예정/기존 시연 흐름:
1. 모니터링 시스템이 서비스 상태를 점검합니다.
2. 장애가 감지되면 관리 시스템에 사건(Incident)이 기록됩니다.
3. 운영자가 관리 화면에서 사건 상세 및 관련 근거를 확인합니다.
4. AI 분석 결과와 조치 초안을 검토하고 실제 조치 내용을 기록합니다.
5. 복구를 확인한 뒤 사건을 종료하고 이력을 조회합니다.

위 전체 흐름이 **이 저장소에서 독립적으로 실행되는지는 아직 검증되지 않았습니다.**

## 관련 시스템

| 구성 요소 | 역할 |
| --- | --- |
| Management Web | 운영자용 사건 확인·조치·종료 화면 |
| Management Worker | Prometheus/Loki 조회, 사건 관련 백그라운드 작업, AI/Slack 작업 |
| Management DB (PostgreSQL) | 사건 및 관리 데이터 저장 |
| Prometheus | 상태·메트릭 조회 |
| Loki | 로그 조회 |
| Slack | 사건 알림 |

## 기존 인프라에서 확인한 실행 설정

`infra/monitoring/compose.management-ec2.yaml`에는 다음 서비스가 정의되어 있습니다.

- `management-db`: PostgreSQL 16
- `management-init`: 데이터베이스 초기화
- `management-web`: Uvicorn을 사용해 `management.web:create_app` 실행
- `management-worker`: `python -m management.worker` 실행

해당 Compose에서는 관리 웹 컨테이너의 8000 포트를 EC2의 로컬 `127.0.0.1:8001`에 바인딩하도록 정의합니다. 이는 실제 외부 접속 설정이나 현재 가동 여부를 증명하지 않습니다.

## 코드 이관 전 확인할 사항

- [ ] 현재 AWS에서 실행 중인 관리 웹 소스 위치 확인
- [ ] `management.web:create_app` 구현 파일 및 의존 모듈 확보
- [ ] Worker와 공유하는 데이터베이스 모델/설정의 경계 결정
- [ ] Dockerfile, 의존성 목록, 환경변수 예시 준비
- [ ] 로컬 또는 테스트 환경에서 웹 실행 검증
- [ ] 로그인 및 사건 조회·조치·종료 기능 검증
- [ ] GitHub Actions 배포 방식 협의

## 보안

- `.env`, 실제 비밀번호, Slack Webhook, AI API 키를 GitHub에 올리지 않습니다.
- 관리자 인증정보는 소스 코드에 하드코딩하지 않습니다.
- 실제 AWS에 자동 배포하기 전 테스트 환경에서 검증합니다.

## 관련 저장소

- [infra](https://github.com/schutz-project/infra)
- [management-worker](https://github.com/schutz-project/management-worker)
- [fast-api](https://github.com/schutz-project/fast-api)

---

**현재 상태:** 문서화 단계. 실제 Management Web 소스 코드 이관 및 단독 실행 검증 필요.
