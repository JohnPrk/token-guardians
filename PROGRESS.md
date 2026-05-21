# PROGRESS — token-panda v2 인계용 진행상황

> 다른 PC / 다른 계정에서 이어서 작업할 때 첫 번째로 읽을 문서.
> 이 파일 자체는 git 추적 (인계 흔적 보존). 마지막 갱신: 2026-05-21.

---

## 0. 작업 컨텍스트 (지금이 어디인가)

- **레포**: https://github.com/JohnPrk/token-panda-v2 (public, default branch `main`)
- **원본 레포** (Releases 폴링 대상): https://github.com/JohnPrk/token-panda
- **현재 코드 버전**: `1.74.8` (`package.json`)
- **CI**: `.github/workflows/release.yml` 이 `v*.*.*` 태그 push 시 macOS + Windows 양 OS 빌드 → **Latest** Release 자동 생성 (`releaseDraft: false`)
- **렌더링 라벨러**: `electron/main.cjs` 가 단일 메인 프로세스, `electron/preload.cjs` 가 `window.__TP__` 노출, `src/tauri-shim/*` 가 프론트엔드 측 Tauri API 호환 shim
- **세션이 끝났을 때 토큰 즉시 폐기 필수**: 어떤 토큰도 이 repo / 채팅 transcript 에 평문으로 남기지 마세요

## 1. 다른 계정에서 이어 받을 때 (반드시 먼저)

이 repo 의 `.git/config` 에는 다음 author 가 박혀 있습니다 (PC owner 의 global config 와 분리해서, repo-local 만 덮어둠):

```
user.name  = JohnPrk
user.email = 88137420+JohnPrk@users.noreply.github.com   ← GitHub 의 noreply
```

새 PC / 새 계정에서 clone 한 후 본인 정체성으로 바꾸려면 **repo-local** 만 수정 (global 건드리지 말기):

```bash
git config --local user.name  "<your name>"
git config --local user.email "<your-id>+<your-login>@users.noreply.github.com"
```

GitHub 의 `{ID}+{login}@users.noreply.github.com` 포맷 사용 추천 — 실제 이메일 노출 없이도 프로필 attribution 됨. ID 는 `https://api.github.com/users/<login>` 의 `id` 필드.

## 2. 테스트 정책 (중요)

**기존 테스트는 freeze 상태.** 새 기능 추가하다 기존 테스트가 깨지면 *기능을 고쳐서* 통과시키지, 테스트를 손봐선 안 됩니다.

규칙:

- ✅ **새 테스트 추가** — 새 분기/필드/엣지케이스가 생기면 *덧붙이는 건* 자유
- ✅ **테스트 안에서 기존 케이스 옆에 새 케이스 추가** — describe/it 새로 추가 OK
- ❌ **기존 케이스 수정/삭제** — 새 기능 PR 안에서 절대 금지
- ⚠️ **정당하게 기존 동작이 바뀌어야 할 때만** — PR 본문에 "BEHAVIOR CHANGE: <왜>" 명시하고 별도 commit 으로 테스트 변경 (그 commit 은 기능 commit 과 분리)

각 테스트 파일 헤더에 `🔒 FROZEN CONTRACT` 주석으로 명시돼 있습니다 ([electron/helpers.test.mjs](electron/helpers.test.mjs), [electron/updater.test.mjs](electron/updater.test.mjs), [electron/claudeApi.test.mjs](electron/claudeApi.test.mjs)).

테스트 실행:

```bash
npm test          # vitest run (CI 와 동일)
npm run test:watch  # 로컬 개발용
```

현재 통과 케이스 수: **159** (frontend 112 + electron 47).

## 3. v1.74.8 시점에서 한 일

### 3.1 출시 인프라

- README 에 Windows 설치/빌드/`%APPDATA%\token-panda\` 데이터 경로 섹션 추가
- 버전 테이블을 v1.22 ~ v1.74.8 전 구간으로 재정리 ("산식: 대기능=+0.1" 옛 규칙 → "dev-cycle↔semver `X.Y ↔ X.Y.0`" 정렬)
- 다운로드 배지 v1.74.6 → v1.74.8 동기화
- `.github/workflows/release.yml`: `releaseDraft: false` 로 변경 → 태그 push 시 즉시 Latest Release 생성

### 3.2 Electron MVP 회귀 복원 (6/11)

| # | 회귀 | 복원 commit | 비고 |
|---|---|---|---|
| #10 | macOS Dock 아이콘 / Cmd+Tab 숨김 | `app.dock.hide()` in whenReady | macOS 실기 미검증 |
| #9  | 쿠키 만료 시 설정창 자동 popup | one-shot latch (`authPopupShown`) | `isAuthFailure` helper 테스트됨 |
| #4  | platform.claude.com prepaid 잔액 폴링 | `fetchPrepaid` + `parsePrepaidCredits` + `coerceDollars` | v1.74 cents 휴리스틱 (integer = cents) 포함, 18 테스트 |
| #6  | 1h 주기 GitHub Releases 폴링 + 트레이 "🆕 설치" | `electron/updater.cjs` 신설 | Tauri updater.rs 의 순수 헬퍼만 포팅, 자동 dmg 설치는 후속 |
| #7  | 트레이 메뉴 헤더 폴링 상태/시각 라벨 | `formatUpdateCheckLabel(lastCheck, info)` | 5 케이스 |
| #8  | "지금 새로고침"에서 Releases 도 즉시 폴링 | menu click → `pollOnce()` + `checkLatestRelease()` 동시 | 트레이 헤더 timestamp 갱신이 시각 신호 |

### 3.3 정체성/attribution 정리

- repo-local git config 를 `JohnPrk <88137420+JohnPrk@users.noreply.github.com>` 로 변경
- 이전 commit 9개 (`jjason0904@cau.ac.kr` 로 들어간 PC owner 흔적) 의 author 를 history rewrite 로 noreply 통일
- main 을 force-push 로 갱신

## 4. 아직 남은 회귀 (큰 작업)

| # | 회귀 | 도입 버전 | 작업 규모 | 차단 이유 |
|---|---|---|---|---|
| #1 | Claude Code 세션 stack | v1.26 | 대 | `src-tauri/src/usage.rs` (971 줄) JS 포팅 — `~/.claude/projects/*.jsonl` 파싱 |
| #2 | 캐시 hit/miss 폭죽·푸른 비·콤보·캐릭터 흔들기 | v0.2 ~ v0.4 | 대 | #1 과 같은 파일에 같이 들어있음, 함께 포팅 |
| #3 | 5분 캐시 카운트다운 타이머 | v0.2 | 대 | 위와 동일 |
| #5 | 30/10/0% 임계 알림 | v0.5 | 소 (#2/#3 위에 얹힘) | snapshot 잔량 필드가 살아야 트리거 가능 |
| #11 | macOS 모든 Space 따라다님 (NSPanel) | v0.6 | 대 (불가능에 가까움) | Tauri 는 SkyLight 비공개 프레임워크 + objc2 사용. Electron 에선 native node addon 필요 |

#1~#3 은 `electron/usage.cjs` (가칭) 한 파일로 분리해서 포팅하는 게 깔끔. #5 는 #2/#3 가 살아나면 `notifier.ts` (이미 Electron Web Notification 으로 작동) 와 자동 연결.

## 5. 릴리스 흐름 (현재)

1. 코드 변경 → commit (author 가 자기 정체성인지 확인)
2. `package.json` 의 `version` 과 `src-tauri/tauri.conf.json` 의 `version` 을 다음 버전으로 bump
3. README 의 다운로드 배지 + 버전 테이블에 새 행 추가 (`docs:` commit)
4. `git tag v<X.Y.Z>` → `git push origin v<X.Y.Z>`
5. GitHub Actions 가 양 OS 빌드 → **Latest** Release 자동 생성 (NSIS .exe + .dmg 첨부)
6. Releases 페이지에서 확인 — draft 아니므로 published 됨

태그 재발행이 필요한 경우 (CI 가 첫 실행에서 실패했을 때):

```bash
git push origin :v<X.Y.Z>    # 원격 태그 삭제
git push origin v<X.Y.Z>     # 다시 push → CI 재실행
```

## 6. 디렉토리 가이드

```
electron/
  main.cjs              # Electron 메인 프로세스 (단일 인스턴스, 트레이, 폴러)
  preload.cjs           # 렌더러에 window.__TP__ 노출
  store.cjs             # @tauri-apps/plugin-store 호환 file-backed store
  claudeApi.cjs         # claude.ai usage + platform.claude.com prepaid fetcher
  updater.cjs           # GitHub Releases 폴링 (1h)
  helpers.cjs           # 순수 함수 (isAuthFailure, formatUpdateCheckLabel)
  *.test.mjs            # vitest — 🔒 FROZEN CONTRACT

src/                    # React 렌더러 (Vite 빌드)
  tauri-shim/*          # @tauri-apps/* → window.__TP__ 호환 레이어
  *.test.ts             # frontend 단위 테스트

src-tauri/              # 구 Tauri 코드. 빌드 파이프라인 (CI) 은 여전히 이걸 사용.
                        # MVP 회귀 분석할 때 reference 로 본다.
                        # 향후 모두 Electron 으로 옮기면 제거 후보.
```

## 7. 향후 작업 시 권장 흐름

1. 이 PROGRESS.md 먼저 읽기
2. `git log --oneline -15` 로 최신 흐름 파악
3. `npm test` 로 baseline 통과 확인
4. 기능 개발 → 새 테스트 추가 (기존 테스트 수정 X)
5. `npm test` 다시 통과 확인
6. commit (작은 단위로) → push
7. 릴리스 준비되면 §5 흐름
