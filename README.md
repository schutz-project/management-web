# SCHUTZ Management Web

기존 AWS 모니터링 EC2의 `schutz-monitoring-management-web-1` 컨테이너에서 추출한 관리 웹 소스입니다.

## 파일
- `management/web.py`: FastAPI 관리 웹 라우트 (대시보드, 관측 지표, 사건 조회/접수/조치/종료)
- `static/manage.html`, `manage.js`, `manage.css`: 관리 웹 UI
- `static/manage-drafts.js`: 관리 웹 초안 스크립트

## 실행 시 주의사항
이 저장소는 **관리 웹 구성요소의 코드 백업**입니다. 단독 실행 가능하도록 완성된 애플리케이션이 아닙니다.
`management/web.py`는 `portal.main`, `portal.models`, `management.models`, `management.domain`을 참조합니다.
기존 Docker 이미지에는 해당 의존 모듈이 함께 들어 있었으므로, 배포 전 의존성 공유 방식과 Docker 빌드 컨텍스트를 정해야 합니다.

기존 실행 진입점: `management.web:create_app` (Uvicorn factory).
기존 AWS 컨테이너와 실제 배포 설정은 변경하지 않았습니다.

## 보안
실제 `.env`, 인증정보, API 키, Webhook URL은 업로드하지 마세요.
GitHub에 등록한 소스는 실제 AWS 서버에 자동 반영되지 않습니다.

## 확인 사항
- [ ] 관리 웹과 Worker가 공유하는 Python 모듈 분리 또는 패키지화
- [ ] 의존성 파일 및 Dockerfile 확정
- [ ] 로그인·대시보드·사건 조치·종료 기능 테스트
- [ ] 배포 방식 및 GitHub Actions 설정
