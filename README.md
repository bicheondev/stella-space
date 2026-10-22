# STELLA SPACE

X Space 공유 게시물의 공개 답글을 채팅처럼 표시하는 스텔라이브 팬 도구입니다. X 로그인·유료 X API 키를 사용하지 않습니다. FxTwitter 제공자의 내부 인증 방식은 별개이며, 최신 일부 답글만 반환하므로 전체 답글 무누락을 보장하지 않습니다.

## 실행 구조

- Vercel Node 함수: UI, 멤버 탐색, 답글 수집 API
- Turso/libSQL: 공유 수집 잠금, 호출 예산, 방송별 수집 답글 보관
- GitHub Actions: 5분마다 최대 270초 동안 `/api/heartbeat`를 반복 요청. 방문자가 없어도 실행하며, 라이브 방은 자동 간격으로 수집하고 오프라인 때는 5초마다 멤버를 확인합니다.
- 방문 브라우저도 모든 라이브 방을 수집합니다. 게시물별·전체 배치 잠금으로 외부 중복 호출을 합칩니다.

Actions 스케줄에는 지연·실행 공백이 있을 수 있어 완전한 무중단 상시 수집은 아닙니다. 비공개 저장소의 Actions는 실행 시간 쿼터를 소모합니다. Vercel·Turso·GitHub 무료 플랜 할당량을 확인하세요. Sites 및 D1은 새 런타임에서 사용하지 않습니다.

## 배포

1. Vercel에서 Turso **Starter ($0/month)** 데이터베이스를 연결합니다.
2. Vercel production 환경 변수: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `COLLECTOR_SECRET`.
3. GitHub Actions 저장소 secret에 동일한 `COLLECTOR_SECRET`을 등록합니다.
4. `scripts/heartbeat.mjs`, `.github/workflows/collector.yml`의 사이트 주소를 실제 Vercel 주소로 설정합니다.
5. `npm ci`, `npm test`, `vercel deploy --prod`.
6. 인증된 heartbeat를 실행하고 `/api/members`, `/api/collect-live`의 checkedAt과 답글 저장을 확인한 뒤 Actions를 시작합니다.

스키마는 DB 첫 사용 시 생성합니다. API는 DB 미연결 시 503을 반환하며 로컬 메모리·임시 파일 저장소로 조용히 대체하지 않습니다. DB 토큰과 수집 secret은 Git에 넣지 않습니다. 로그에도 secret을 출력하지 않습니다.

## 동작

멤버별 주소는 `/GANGZIIII`, `/ShirayukiHina_` 형식입니다. 기본 주소는 강지를 먼저 표시한 뒤 목록 순서상 첫 온라인 멤버로 이동합니다. 모두 오프라인이면 강지입니다. 최근 본인 게시물 5개에 Space 링크가 없으면 오프라인으로 표시합니다. 종료가 확인된 방은 답글 수집을 멈추고 기존 기록만 표시합니다.

FxTwitter 호출은 분당 900회를 목표로 공통 67ms 슬롯을 예약합니다. 15명 프로필 조회의 분당 180회를 제외한 720회가 답글 예산입니다. 답글 간격은 방 수에 비례하며 응답 시간 때문에 실제 속도는 더 느릴 수 있습니다.

상단 +/−는 글자 크기를 조절합니다. 위로 스크롤하면 따라가기를 멈추고 맨 아래에서 재개합니다. 사진은 최대 120×90px 썸네일로 표시합니다. Pretendard JP 및 ss05를 적용합니다.

기존 Sites용 파일은 이전 배포 참고용이며 Vercel 배포에서는 `.openai`, Sites 빌드·저장소 도구를 호출하지 않습니다.

방송 시작부터 수집한 답글은 별도 메시지 테이블에 중복 없이 누적하며 500개 제한으로 삭제하지 않습니다. 응답은 500개씩 커서로 읽어 화면에 순차 표시합니다. 방종 후에는 마지막 방송을 멤버별로 유지하고, 다음 방송 시작이 확인되면 새 방송 기록으로 전환합니다. 새 Space가 예정·미확인인 동안은 이전 방송을 유지합니다. 기존의 과거 500개 캐시는 새 기록으로 옮기지만 이미 삭제된 예전 답글은 복구되지 않습니다.
