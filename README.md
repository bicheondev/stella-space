# STELLA SPACE

Twitch 팝업 형태의 비로그인 X Space 공개 메시지 뷰어.

## 실행

Node.js 22 이상과 curl 설치 후 `node preview.mjs` → http://127.0.0.1:4173
로컬 프리뷰는 X가 Node 기본 전송을 거부하는 문제를 피하기 위해 curl로 공개 HTTP 요청을 전송합니다. 배포 코드는 Cloudflare Worker의 fetch를 사용합니다.

## 기능

- 스텔라이브 14명, 4개 기수 드롭다운 / 프로필 / 방송 중·오프라인·확인 불가
- Space URL 및 Space 공유 게시물 URL 해석
- 공개 메시지/반응, 음성 자막 구분, 중복 제거와 기록 페이지 처리
- 팝업 / 시간 표시 / 글자 크기 / 자동 스크롤
- 유료 API 및 X 사용자 로그인 불필요

## 실제 검증 및 제한

테스트 게시물 https://x.com/hanayohiyori/status/2112891916077687250 에서 Space 1qKVmyYgzgLxB (스페하나요히요리, Ended)를 확인했습니다. 공개 게스트 API로 메타데이터와 채팅 토큰을 받아 실제 음성 자막 및 반응 기록을 불러왔습니다. **게시물 아래의 답글을 가져오는 기능은 구현되지 않았습니다.** Space 메시지 API는 공유 게시물 답글과 다릅니다.

13명의 X 프로필 조회를 검증했습니다. 제공된 ShizukiToa 계정은 조회되지 않았습니다. 자동 Space 검색은 현재 공개 API에서 404를 반환하여 URL 미연결 멤버는 '확인 불가'로 표시합니다. 조회 실패를 오프라인으로 표시하지 않습니다. 직접 연결한 Space의 상태는 확인 가능합니다.

X의 비공식 공개 API는 변경·차단될 수 있으며 모든 환경에서의 지속적인 무로그인 접근을 보장하지 않습니다. 게스트/채팅 토큰은 서버 메모리에만 보관합니다.

## 검증

`node --check worker/index.js`
`bash scripts/build.sh`
`node scripts/validate-artifact.mjs`
