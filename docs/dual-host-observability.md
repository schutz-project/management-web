# 서비스·모니터링 서버 자원 표시 변경안

## 동작

기존 `resources.items` 계약은 유지하며 `host_id`, `server_role`, `server_name`, `expected`, `last_collected_at` 필드를 추가합니다. 역할은 `up{job="ec2-node"}`의 `server_role` 라벨로만 식별합니다. 라벨 없는 기존 호스트는 `unknown`으로 보존하며 서비스 서버라고 추측하지 않습니다.

`service` 또는 `monitoring` 역할의 데이터가 없으면 숫자를 만들지 않고 `no_data` 항목을 표시합니다. Prometheus 자원 원본 조회가 실패하면 `unavailable`로 표시합니다. `last_collected_at`은 호스트 메모리 원본의 실제 표본 시각이며 전체 서버 상태의 정상 판정을 의미하지 않습니다. 과거 기간 조회에서는 선택 종료 시점의 표본입니다. 역할 정보는 현재 target 라벨 기준이므로 역할 변경 이력까지 재구성하지는 않습니다.

요약 화면은 각 호스트의 CPU·메모리·디스크·수집 상태를 카드로 표시합니다. 카드를 선택하면 아래 그래프가 해당 서버로 전환되고 상세 링크에도 같은 host_id가 유지됩니다. 새로고침 시 서버 순서가 바뀌어도 상세 화면은 선택한 host_id를 사용합니다.

수집 전까지 모니터링 역할은 미수집으로 남는 것이 맞습니다. Web 변경만으로 호스트 지표가 수집되지는 않습니다.

## 검증

- Node UI 회귀 68개 통과: 두 서버 선택 후 상세 이동, 미수집을 0%·정상으로 표시하지 않는 경우 포함.
- 관측 API 회귀 10개 통과: 기간·과거 조회·stale·캐시 등.
- 서버 inventory 처리 6개 통과: 역할 순서, 누락 역할, 설정 후 표본 없음, 조회 실패, 라벨 없는 호스트.
- JavaScript 구문 및 git diff --check 통과.
- 실제 브라우저 시각 검수와 서버 수집 확인은 미실행.

후보 CI에 두 서버 Python 회귀와 Playwright loopback 검수를 추가했습니다. 아직 원격 CI는 실행되지 않았으며, 로컬에는 Chromium 실행 파일이 없어 브라우저 결과를 성공으로 기재하지 않습니다.

## 범위

LOAD-01 발생기는 다른 개발자가 담당합니다. 이번 변경은 발생기·인증·요청 상한을 수정하지 않으며 부하를 발생시키지 않습니다. main 병합·원격 push·운영 배포도 하지 않았습니다.

## v0.2 독립 검토 대응

`NODE_SOURCE_QUERY`는 `max by (instance) (timestamp(node_memory_MemTotal_bytes{job="ec2-node"}))`입니다. 따라서 value[1]은 바이트 값이 아니라 원본 timestamp이고 value[0]은 평가 시각입니다. [0]으로 변경하지 않습니다. 원본 시각 800·평가 시각 1000의 stale 회귀와 과거 조회·유효하지 않은 시각 방어 테스트를 추가했습니다. 근거: https://prometheus.io/docs/prometheus/latest/querying/functions/#timestamp

`resources.source_status`, `metadata_status`, `metric_status`를 추가했습니다. 원본 시각 조회·role metadata 조회·CPU 등 개별 자원 조회의 실패를 구분합니다. 전체 상태 partial은 일부 조회 실패/자원 미제공을 뜻합니다. 역할 조회 실패 시 기존 정상 수치는 보존하되 역할 미지정·역할 조회 실패를 표시하고, 예상 역할을 no_data라고 단정하지 않습니다. 사용자 지정 기간의 시작·종료 UTC 시각은 API 요청뿐 아니라 주소의 `start`·`end`에도 저장해 새로고침과 이동 뒤 같은 범위를 복원합니다.

이 API는 화면 조회용이다. `timestamp(node_memory_MemTotal_bytes)`의 `value[1]`에서 산출한 `last_collected_at`은 메모리 원본 표본 시각이며 CPU·디스크 원본 표본 시각을 대신하지 않는다. `max by(instance)` 등의 집계는 중복 원본 시계열을 숨길 수 있다. LOAD-01 v7의 `dual-host-health/v0.2-candidate` 입력을 이 API 결과에서 바로 만들어 신뢰 가능한 공급자로 사용하지 않는다. 별도 공급자는 role/instance 중복, 두 서버의 각 지표별 원본 시각과 조회 실패를 독립 검증해야 한다.

호스트 시각·자원·history·inventory metadata의 20/30개 조용한 절단을 제거했습니다. 일반 수집 대상 표는 기존 30개 표시 상한을 유지하며 role inventory는 그 표의 절단 전에 전체 응답을 사용합니다. 대규모 환경의 응답 크기 제한·페이지 처리는 별도 과제이며 이번 후보는 두 서버 환경 기준입니다.

새 통합 회귀 6개와 inventory 회귀 6개를 별도로 실행했습니다. UI는 DOM 모의 회귀이며 실제 Chromium 검수를 대신하지 않습니다. Playwright 라이브러리는 있으나 Chromium 실행 파일이 없어 실제 브라우저 검수 시도는 실행 전 실패했습니다. 시각 검수·원격 CI·실제 서버는 미확인입니다.
