# STELLA SPACE

Twitch 팝업 형태의 스텔라이브 Space 공유 게시물 답글 뷰어입니다.

## 실행

Node.js 22 이상과 curl 설치 후:

```sh
node preview.mjs
```

http://127.0.0.1:4173 에 접속합니다. 설정(⚙)에서 수집 경로를 선택할 수 있습니다.

## 답글 수집 경로

| 경로 | 테스트 결과 | 제한 |
|---|---|---|
| X 공개 페이지 직접 조회 (기본) | 비로그인 HTML의 hydration 데이터에서 직접 답글 3개 추출 | 일부 인기 답글만 보일 수 있음. `sort_replies=recency`가 요청에 반영돼도 테스트 결과 목록은 같았음. 전체·실시간 수집 보장 없음 |
| FxTwitter 공개 API (선택) | `/2/conversation/2112891916077687250?ranking_mode=recency`에서 직접 답글 28개 수집 | 다음 페이지 커서는 반환됐지만 실제 다음 페이지 요청은 code 404. 최신순 첫 페이지를 주기적으로 확인하는 방식 |
| Nitter | XCancel은 HTTP 451 서비스 중단, Poast는 DNS 실패 | Nitter 자체 서버 구현은 OAuth/계정 쿠키 세션 사용. 완전 비로그인 자체 수집 경로로 간주할 수 없음 |

FxTwitter의 구형 `/:handle/status/:id`는 답글 수만 반환하지만 **v2 conversation API는 답글 목록을 반환**합니다. API에 사용자 계정·유료 키를 보내지 않습니다. 다만 제공자 내부에서 X 계정 세션을 사용하는지는 보장할 수 없습니다. 제3자 서버까지 계정 미사용 조건이라면 기본 직접 조회만 사용해야 합니다.

두 경로 모두 15초마다 최신 응답을 조회하고 게시물 ID로 중복을 제거합니다. 서버는 경로/게시물별로 15초 캐시와 진행 중 요청 공유를 적용합니다. 화면은 일부 답글임을 표시하며, 오류 시 이전 답글을 유지하고 조회 실패를 알립니다. 답글 내용은 HTML로 실행하지 않고 텍스트로 표시합니다. 직접 답글만 포함하며 부모 글·인용 글·대댓글을 섞지 않습니다. 추가 페이지 수집 기능은 검증되지 않아 자동 실행하지 않습니다.

테스트 게시물: https://x.com/hanayohiyori/status/2112891916077687250
Space: 1qKVmyYgzgLxB, 스페하나요히요리 (종료됨)

## 기능과 남은 한계

- 4개 기수 14명, 프로필 드롭다운. 토아 계정은 `ShizukiToa_`로 수정하고 이미지 확인 완료.
- Space 공유 게시물 URL 해석, 팝업, 시간 표시, 글자 크기, 자동 스크롤.
- Space 링크만으로는 공유 게시물 ID를 알 수 없어 답글 조회에 공유 게시물 URL 필요.
- 전체 멤버 자동 방송 검색은 현재 조회 제한. 확인 실패를 오프라인으로 표시하지 않음.
- 과거 Space 종료를 현재 멤버 오프라인으로 단정하지 않음.
- X 음성 자막은 답글 대신 표시하지 않음.
- 배포 사이트는 현재 소유자 전용으로 ChatGPT 로그인이 필요함. 로컬 페이지와 X 데이터 요청에는 사용자 로그인 불필요.

## 검증

```sh
node --test tests/replies.test.mjs
node --check worker/index.js
bash scripts/build.sh
node scripts/validate-artifact.mjs
```

공개 API 응답 검증 및 브라우저에서 실제 답글 표시를 확인합니다. 로컬 preview는 X의 Node 기본 전송 제한을 피하려고 curl을 사용하며 배포 코드는 Cloudflare Worker fetch를 사용합니다.

## 조사 근거

- https://docs.fxembed.com/api/twitter/operations/2conversationid/
- https://docs.fxembed.com/deployment/credentials/
- https://github.com/zedeus/nitter/blob/master/src/apiutils.nim
- X 비로그인 게시물 HTML 및 현재 공개 클라이언트 번들 직접 검사
