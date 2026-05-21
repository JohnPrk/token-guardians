# 토큰 판다 (Token Panda)

> 데스크톱 한구석에서 너의 Claude 토큰 잔량을 지켜봐주는 작은 판다.

[![Download .dmg](https://img.shields.io/badge/Download-.dmg%20v1.85.0-6b4cff?style=for-the-badge&logo=apple)](https://github.com/JohnPrk/token-panda-v2/releases/latest/download/token-panda_1.85.0_arm64.dmg)
[![Download Windows](https://img.shields.io/badge/Download-Windows%20v1.85.0-0078d4?style=for-the-badge&logo=windows)](https://github.com/JohnPrk/token-panda-v2/releases/latest/download/token-panda_1.85.0_x64-setup.exe)
[![platforms](https://img.shields.io/badge/platform-macOS%2011%2B%20%C2%B7%20Windows%2010%2B-lightgrey?style=for-the-badge)](#한계)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](#라이선스)

<br>

<p align="center">
  <img width="400" height="401" alt="화면 기록 2026-05-04 오후 10 49 22" src="https://github.com/user-attachments/assets/42ef49ac-fa56-4017-bb0e-937d0f1a0faa" />
</p>

<br>

## 왜 만들었나

### **💡 똑똑한 토큰 관리, 판다에게 맡기세요!**

* Claude의 유일한 단점은 `토큰 한도`입니다. 
* 질문에 대한 답변을 받고 5분 이내에 다음 대화를 이어가면, 클로드는 기존 내용을 기억(캐시)해두었다가 토큰 소모량을 획기적으로 아껴줍니다.
* 하지만 다른 업무를 하다 보면 이 짧은 '골든타임'을 놓치기 쉬운데, 이제 화면 속 작은 판다가 그 타이밍을 놓치지 않게 신호를 보내드립니다.

> [!TIP]
> 마지막 요청에서 5분 안에 다음 요청을 보내면 그 직전까지의 컨텍스트가 캐시 히트로 처리돼 토큰 사용량이 `1/10`로 줄어듭니다!

<br>

### **핵심 기능**
- 📊 **메뉴바 연동:** 5시간/주간 토큰 잔량을 메뉴바에 라이브로 표시
- ⏰ **타이머 알림:** 질문을 던지는 순간 5분 캐시 카운트다운이 시작되며, 만료 전 캐릭터가 흔들리며 신호
- 🔢 **캐시 수치 추적:** 매 응답마다 발생한 캐시 Hit/Miss 수치를 직접 확인하여 토큰 절약 효율을 관리
- 🖱️ **자유로운 배치:** 화면을 가리지 않고 클릭 앤 드래그로 이동 가능

<br>

### **다이내믹 캐릭터 애니메이션**
* 잔량 기반 8단계 상태 변화: 5시간 토큰 잔량에 따라 Full부터 Sleepy까지 7단계의 외형과 감정 표현 변화
* 에너지 수준별 고유 액션: 토큰이 여유로우면 구르거나 점프하는 등 활발하게 움직이고, 부족해질수록 동작이 눈에 띄게 둔화
* 캐시 결과 시각화 (Hit & Miss): 캐시 성공 시 노란 폭죽 이펙트가 터지고, 만료 시에는 푸른 비가 내리며 판다가 시무룩해지는 연출
* 연결 상태 직관적 표시: 네트워크 오류나 쿠키 만료 시 판다가 직접 '연결 실패' 표지판을 들고 등장하여 즉각적인 인지 가능

<br>


<img width="400" height="371" alt="화면 기록 2026-05-04 오후 11 55 33" src="https://github.com/user-attachments/assets/4b175568-edab-4fa1-bbc1-7ad2771d9d6d" />


<br>
<br>

## 다운로드 / 설치


### 가장 빠른 방법: 빌드된 .dmg

위쪽 **`Download .dmg`** 배지를 눌러 최신 `.dmg`를 받고, 열어서 `Applications` 폴더로 드래그하세요.

#### 처음 열 때 macOS 차단 우회 (Gatekeeper)

이 앱은 아직 Apple Developer ID 서명을 안 받은 상태라 처음 실행 시 macOS가 차단합니다. 표시되는 메시지에 따라 두 가지 케이스가 있고, 한 번만 풀어두면 다음부터는 평범하게 더블클릭으로 열립니다.

**케이스 A: "‘토큰 판다’은(는) 손상되었기 때문에 열 수 없습니다. 해당 항목을 휴지통으로 이동해야 합니다." 다이얼로그**

<br>

<img width="520" height="560" alt="image" src="https://github.com/user-attachments/assets/93a83203-5960-43cd-b2a0-06c0d3bb62fe" />

<br>

실제로 파일이 깨진 게 아니라, 서명/공증 안 된 앱에 macOS가 quarantine 속성(`com.apple.quarantine`)을 붙여서 차단하는 것입니다. 우클릭 → 열기로도 안 뚫리니 quarantine 속성 자체를 제거해야 합니다. 터미널을 열어 아래 한 줄을 입력하세요.

```bash
xattr -cr /Applications/TokenPanda.app
```

이후 다시 더블클릭하면 열립니다. (한 번만 하면 되고, 다음 실행부터는 그냥 클릭으로 실행 가능)

> 파일시스템상의 번들 이름은 `TokenPanda.app` 입니다(위 터미널 경로에 그대로 사용). Finder·메뉴바에는 여전히 "토큰 판다" 로 보이는데, 표시 이름만 `CFBundleDisplayName` 으로 한글로 띄우고 실제 파일명은 ASCII 로 둔 것입니다.

<br>

**케이스 B: "확인되지 않은 개발자" 경고**

1. `Applications`에서 **토큰 판다.app** 더블클릭 → "확인되지 않은 개발자" 경고가 뜨고 차단됨
2. **시스템 설정 → 개인정보 보호 및 보안** 열기
3. 화면을 끝까지 아래로 스크롤하면 *"토큰 판다.app은(는) 신원 미상의 개발자가 배포했기 때문에…"* 라는 메시지가 보임
4. 그 옆의 **`그래도 열기`** 클릭 → 한 번 더 확인 다이얼로그 → `열기`
5. 이후엔 그냥 더블클릭으로 실행 가능

> [!NOTE]
>  정식 코드 서명은 Apple Developer Program ($99/년) 가입과 공증(notarization) 셋업이 필요해서 보류 중입니다. 그 전까지는 이 우회 단계로 사용해 주세요.

<br>

### Windows 설치 (NSIS .exe)

위쪽 **`Download Windows`** 배지를 눌러 최신 Releases 페이지로 이동한 뒤, `*_x64-setup.exe`를 받아 실행하세요. 설치는 **현재 사용자 범위**(`%LOCALAPPDATA%`)로 들어가므로 **관리자 권한이 필요 없습니다.**

> [!NOTE]
> 현재 Windows 빌드는 코드 서명(EV / OV 코드 서명 인증서)이 안 된 상태라 처음 실행 시 **SmartScreen** 경고가 뜰 수 있습니다. `자세히 → 실행`을 한 번만 누르면 다음부터는 바로 실행됩니다. 차단이 너무 강한 환경(회사 PC, 그룹 정책)에서는 IT 담당자에게 예외 처리를 요청하거나 직접 빌드하세요.

설치 후 동작 차이:

- **트레이 위치**: macOS는 화면 상단 메뉴바, Windows는 우측 하단 작업 표시줄 시스템 트레이. 메뉴 항목·기능은 동일합니다.
- **펫 창**: 양 OS 모두 `frameless / transparent / always-on-top`이지만 Windows에서는 가상 데스크톱(`Win+Tab` 새 데스크톱)에서 자동으로 따라오지는 않습니다 (macOS 의 "모든 Space" 동작과 다름).
- **알림**: Windows의 native toast 권한은 OS 차원에서 한 번만 허용하면 됩니다 (`설정 → 시스템 → 알림 → 토큰 판다`).
- **데이터 저장 위치**: `%APPDATA%\token-panda\` (macOS는 `~/Library/Application Support/com.tnew.clauddeskpet/`). "연동 해제" 시 즉시 삭제되는 건 동일.

<br>

### 직접 빌드해서 쓰기

```bash
git clone https://github.com/JohnPrk/token-panda-v2.git
cd token-panda-v2
npm install

# macOS: .dmg 빌드
npm run dist:mac
# → release/token-panda_<version>_arm64.dmg

# Windows: NSIS .exe 빌드
npm run dist:win
# → release/token-panda_<version>_x64-setup.exe
```

개발 중 빠른 iteration 은 Electron 러너로 (Tauri 빌드 우회, 양 OS 동일):

```bash
npm run electron:dev   # vite + electron 동시 기동, HMR
```

빌드 시 필요한 도구:

- macOS 11+ **또는** Windows 10+ (x64)
- Node 18+ (Electron 33 + electron-builder 26 빌드. Rust toolchain 불필요 — Tauri 파이프라인에서 이전됨)

<br><br>

## 어떻게 사용하나

### 1. 처음 실행

별도의 **시작하기** 창이 뜹니다. 두 단계로 진행됩니다.

1. **캐릭터 고르기**: 데스크톱 모서리에 앉을 친구를 고릅니다. 나중에 `설정`에서 언제든 변경 가능.
2. **claude.ai 연동**: Org ID + 세션 쿠키를 한 번만 등록하면 끝. 자세한 절차는 창 안에 단계별로 적혀 있습니다.

(연동을 나중에 하고 싶으면 "건너뛰고 시작"을 눌러도 됩니다. 메뉴바 → `설정...`에서 다시 입력할 수 있어요.)

<br>

### 2. 메뉴바 / 펫 창

| 위치 | 보이는 것 | 조작 |
| --- | --- | --- |
| 메뉴바 | 잔량 % + 대나무 아이콘 (75% 이상 4줄기 / 50% 이상 3줄기 / 25% 이상 2줄기 / 25% 미만 1줄기) | 클릭으로 메뉴 열기 |
| 메뉴바 메뉴 | 버전 표시, `펫 보이기/숨기기`, `지금 새로고침`, `설정...`, `종료` | 펫을 일시적으로 숨기거나 쿠키 갱신 시 |
| 펫 창 | 5h / 주간 잔량 % + 캐시 타이머 + 캐릭터 모션 | 클릭 앤 드래그로 위치 이동, 우클릭으로 즉시 새로고침 |

<br>

### 3. 잔량을 어떻게 가져오는가

**claude.ai의 `/api/.../usage`** 를 직접 조회해 정확한 사용량 %를 가져옵니다. Org ID + 세션 쿠키만 한 번 등록하면 30초 폴링으로 자동 갱신됩니다.

자세한 추출 방법은 시작하기 / 설정 창 안에 단계별로 안내됩니다. 핵심만 말하면:

- **Org ID**: [claude.ai/settings/account](https://claude.ai/settings/account) → "조직 ID"
- **세션 쿠키**: [claude.ai/settings/usage](https://claude.ai/settings/usage)에서 ⌘⌥I → Network 탭 → `usage` 요청 → Request Headers의 `cookie:` 줄 통째로 복사

쿠키 줄에서 실제로 사용하는 키는 5개뿐(`sessionKey`, `cf_clearance`, `__cf_bm`, `_cfuvid`, `routingHint`)이고 나머지는 무시됩니다.

<br><br>

## 동작 원리

### 데이터 소스

```
GET https://claude.ai/api/organizations/<org-id>/usage
  Cookie: sessionKey=...; cf_clearance=...; __cf_bm=...; _cfuvid=...; routingHint=...
  → Anthropic 공식 utilization% 그대로
  → 30초마다 폴링
```

이 엔드포인트는 claude.ai 웹 UI가 직접 호출하는 **내부 API**입니다. 공식 문서에는 명시되지 않았지만 결과는 페이지에서 보는 값과 동일합니다.

<br>

### org + 쿠키 만으로 모든 API 요청을 보낼 수 있나?

**아니요.** Anthropic 환경에는 사실상 3개의 분리된 API가 있고 각각 인증이 다릅니다.

| 시스템 | 인증 | 권한 |
|---|---|---|
| **claude.ai 내부 API** (토큰 판다가 쓰는 곳) | 세션 쿠키 (`sessionKey` 등) | 본인 claude.ai 구독의 사용량 % 조회 |
| Anthropic API (`api.anthropic.com`) | `x-api-key: sk-ant-api-...` | 모델 호출 (`/v1/messages` 등), 토큰 단위 과금 |
| Admin API | `x-api-key: sk-ant-admin-...` | 조직 사용량/비용/멤버 관리 |

org + 쿠키로는 **claude.ai 구독의 quota 조회만 됩니다.** 모델 호출이나 결제 정보 같은 건 API 키가 따로 필요하므로 토큰 판다가 가져갈 수도, 가져갈 필요도 없습니다.

> [!CAUTION]
>  그래도 쿠키 자체는 본인 claude.ai 세션 권한이 있어서 노출되면 다른 사람이 본인 계정의 사용량을 조회·소모할 수 있습니다. **너무 위험하진 않지만, 외부에 흘리지 않게 조심하세요.**

<br>


### 쿠키 (세션·Cloudflare)

캐시(5분 TTL)와는 별개의 개념입니다. 쿠키는 claude.ai로 요청을 보낼 때 본인임을 증명하는 토큰이에요.

- **세션 쿠키** (`sessionKey`, `routingHint`): 보통 약 30일 정도 유지.
- **Cloudflare 쿠키** (`__cf_bm`, `cf_clearance`, `_cfuvid`): 짧으면 30분 ~ 길면 수 시간. claude.ai 탭을 자주 열어두면 자동으로 갱신됩니다.

쿠키가 만료되면 폴링이 HTTP 401·403·404를 받습니다. 토큰 판다가 이걸 자동으로 감지하고:

1. 캐릭터를 **`disconnected` 상태로 즉시 전환**해서 시각적으로 알리고,
2. **설정 창을 자동으로 다시 열어** 새 쿠키를 요청합니다.

claude.ai에 다시 들어가 쿠키 줄을 복사해 붙여넣고 `저장`만 누르면 메뉴바 잔량이 곧바로 다시 흐르기 시작합니다.

<br>
<br>

## 한계

- **지원 OS:** macOS 11+ (Apple Silicon, .dmg) · Windows 10+ x64 (NSIS .exe, MVP). Linux 빌드는 현재 없습니다.
- **Windows 빌드는 MVP 단계입니다.** 흰 화면·트레이 누락·시작하기 데드락 등 초기 회귀를 v1.74.1~v1.74.8 에 걸쳐 잡았지만, macOS 만큼의 완성도는 아닙니다 — 가상 데스크톱 핀닝, HiDPI 트레이 아이콘 미세 조정, 코드 서명이 아직 미해결입니다.
- **claude.ai의 비공식 내부 엔드포인트**(`/api/organizations/<org>/usage`)에 의존합니다. Anthropic이 스키마를 바꾸면 깨질 수 있어요. 발견 즉시 패치 예정.
- **현재 캐릭터 모션은 정적 PNG + CSS 애니메이션**입니다. 1.0 마일스톤 이후 GIF 기반 랜덤 모션을 추가할 예정.
- **메뉴바 트레이 아이콘 사이즈**는 macOS 표준에 맞춰 `22×22` (1×) / `44×44` (2×) 템플릿 이미지로 동작합니다. 마스터 아이콘은 `src-tauri/icons/icon.png` (1024×1024) 한 장에서 자동 생성됩니다.

<br><br>

## 보안 / 프라이버시

- ✅ **로컬에서만 동작합니다.** Org ID와 쿠키는 이 컴퓨터 안 (macOS: `~/Library/Application Support/com.tnew.clauddeskpet/` · Windows: `%APPDATA%\token-panda\`)에만 저장되고, 앱이 직접 `claude.ai`로만 요청을 보냅니다. **외부 서버·분석 도구·텔레메트리 어디에도 전송하지 않습니다.** "연동 해제"를 누르면 즉시 삭제.
- ⚠️ **Org ID와 세션 쿠키는 사실상 본인의 Claude 계정 자격증명**입니다. 가져간 사람이 본인 계정으로 사용량을 조회·소모할 수 있어요. 너무 위험한 권한은 아니지만 (모델 호출이나 결제 정보 접근은 안 됨) **공유하지 마세요.** 화면 녹화·캡쳐·디스코드/슬랙에 붙여넣기 등으로 노출되지 않도록 조심하세요.
- 쿠키가 의심스러우면 [claude.ai/settings/account](https://claude.ai/settings/account) → "활성 세션"에서 해당 세션을 로그아웃하면 즉시 무효화됩니다.
- ⚠️ 현재 dmg는 **미서명**입니다. 처음 실행 시 macOS Gatekeeper가 경고를 띄울 수 있어요. `시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기`로 한 번 허용하면 다음부터 바로 실행됩니다. 향후 Apple Developer ID 서명·공증을 통해 이 경고를 제거할 예정.
- 🔔 **알림 권한**: 처음 실행 시 macOS가 알림 권한을 묻습니다. 허용해야 5h 잔량 30·10·0% 임계 알림이 뜹니다. 거부했어도 메뉴바 % 만으로 잔량 추적은 가능하고, 나중에 `시스템 설정 → 알림 → 토큰 판다`에서 다시 켤 수 있습니다.

<br><br>

## 버전

> 산식: 1.0 출시 이후 dev-cycle 번호와 semver 를 정렬했습니다 (`X.Y` ↔ `X.Y.0`). 같은 dev-cycle 안의 fix 는 `X.Y.Z` patch 로 들어갑니다. 현재 안정: **v1.85.0** (2026-05-22).
>
> 전체 릴리스 산출물은 [GitHub Releases](https://github.com/JohnPrk/token-panda-v2/releases) 에서 받을 수 있습니다.

| 버전 | 날짜 | 주요 변경 |
| --- | --- | --- |
| **1.85.0** | 2026-05-22 | **Electron 배포 파이프라인 이전 (Tauri → Electron, NSPanel 회귀 #11 일소).** CI 가 `tauri-action` 대신 `electron-builder` 로 .dmg/.exe 빌드. NSPanel 클래스 스왑이 사라져 설정창 텍스트 입력·창 포커스 회귀 해결. src-tauri/ 폴더 + @tauri-apps/* 의존성 통째 제거 (Rust 코드 4244 줄). bundle 이름이 `/Applications/토큰 판다.app` → `/Applications/TokenPanda.app` 으로 변경(BEHAVIOR CHANGE) — 옛 dock 단축 아이콘 제거 후 새 .app 끌어다 놓기 필요. 메뉴바/Finder 표시 이름은 여전히 "토큰 판다" (CFBundleDisplayName override) |
| **1.75.0** | 2026-05-21 | **자동 설치 흐름 복원** — 트레이 "🆕 v.. 설치" 클릭 시 백그라운드 자동 다운로드 + 옛 프로세스 종료 + 사일런트 설치 + 새 앱 실행. macOS 는 구 Tauri bash 흐름(`hdiutil` mount → `cp` → `xattr -cr` → `open`) 그대로, Windows 는 신규 PowerShell 흐름(NSIS `/S` + registry InstallLocation 으로 새 exe 찾아 백그라운드 실행). 부수: CI 의 자산 이름 ASCII 정규화 (`rename-release-assets` post-job) — `_1.74.8_aarch64.dmg` 처럼 GitHub 가 한글 prefix 잘라먹던 회귀 차단 |
| **1.74.1 ~ 1.74.8** | 2026-05-21 | **Windows 지원 (MVP).** Electron 으로 dev/runtime 마이그레이션, Tauri 기반 NSIS .exe 릴리스 파이프라인은 유지. 초기 회귀 다수 수정 — 트레이 항목 누락(`1.74.1`), 흰 화면 #1~#3 (hash 라우팅 → Tauri 윈도우 라벨 라우팅 → PetApp store init hang 분리, `1.74.2~4`), 시작하기 데드락 (블로킹 HTTP → async + spawn_blocking, `1.74.5`), 시작하기·설정 창 라벨 주입 레이스 (`1.74.6`), 최종 wrap-up + Electron 마이그레이션 정리 (`1.74.8`) |
| **1.74** | 2026-05-19 | prepaid cents 휴리스틱 임계 폐기로 $963.00 오인 해석 수정 |
| **1.70 ~ 1.73** | 2026-05-18 | 트레이/UX 폴리시 — 펫 크기 조정 + resize handle + 테스트 커버리지 확장 (`1.70`), resize 핸들 드래그 속도 둔감화 `PX_PER_UNIT 200→600` (`1.71`), 트레이 메뉴 헤더에 업데이트 폴링 상태·시각 인라인 표시 (`1.72`), "지금 새로고침" 라벨에 ↻ 글리프 (`1.73`) |
| **1.50 ~ 1.51** | 2026-05-18 | prepaid 음수 sentinel 방어 + platform UUID/Cookie 분리 입력 (`1.50`), 트레이 "지금 새로고침"에서 GitHub Releases 도 즉시 폴링 (`1.51`) |
| **1.49** | 2026-05-17 | API prepaid 잔액 표시 + 펫 윈도우 동적 resize |
| **1.47** | 2026-05-16 | orgId/쿠키 paste 자동 캡처 + Windows release 파이프라인 Phase 1 (release workflow contents:write 권한 추가 포함) |
| **1.24 ~ 1.26** | 2026-05-16 | 자동 업데이트 + 싱글 인스턴스 + 회귀 방지 인프라 (`1.24`), 트레이 표시 모드 선택 + 테스트 보강 (`1.25`), **세션 stack** — 멀티 Claude Code 세션 prompt cache 카운트다운 카드 (`1.26`) |
| **1.23** | 2026-05-09 | 펫 윈도우 빈 공간 mouse passthrough (캐릭터/대나무 외 클릭이 뒤 창으로 통과) |
| **1.22** | 2026-05-09 | **멀티 계정 시스템.** 계정 여러 개 등록·전환·편집·삭제. 트레이 메뉴에 "계정 전환 ▸" 서브메뉴, 활성 계정의 캐릭터로 트레이 아이콘 자동 swap (캐릭터 추가 시 PNG만 더하면 동작). 카드 본체 클릭이 활성 카드면 편집, 비활성이면 활성 전환 |
| **1.17** | 2026-05-03 | 외부 신뢰성 + 회귀 안전장치 묶음 — 단위 테스트 도입(vitest), dmg 파일명 ASCII 통일(한글 prefix 404 수정), disconnected 알림 가드, Gatekeeper 우회 가이드, 트레이 버전 라벨 |
| **1.0** 🎉 | 2026-05-02 | **출시 마일스톤.** disconnected 상태 표지판, flash-hit 노란 폭죽, flash-miss 푸른 비, idle 액션 속도 조정, 대나무 그림자. 직후 `1.01~1.06` 에서 sign positioning/sleepy bamboo/tray 버전 라벨 폴리시 |
| 0.9 | 2026-05-02 | idle 액션 시스템 완성 — wobble·squish 추가로 6종. jump 그림자·squish 임팩트 링. 출시 직전 폴리시 |
| 0.8 | 2026-05-01 | Settings·onboarding 별도 윈도우, 캐릭터 picker, disconnected 상태, 앱 아이콘 개편, "토큰 판다" rebrand |
| 0.7 | ~ | claude.ai live usage API 연동, 30초 폴링, 쿠키 sanitize, Cloudflare 통과 |
| 0.6 | ~ | macOS 윈도우 핀닝, 모든 Space에서 표시, Dock 아이콘 숨김 |
| 0.5 | ~ | 트레이 + 임계치 알림 (30·10·0%) |
| 0.4 | ~ | 캐시 분석, thinking 감지, hit/miss 플래시 이펙트 |
| 0.3 | ~ | 토큰 사용량 디스플레이, 배터리 스타일 5h·주간, 리셋 카운트다운 |
| 0.2 | ~ | 판다 캐릭터 시스템, 에너지별 idle 액션, flash 이펙트 |
| 0.1 | ~ | 프로젝트 기반 셋업, Tauri 2 + React 19 + TS + Vite |

<br>
<br>

## 라이선스

MIT. 자유롭게 포크/수정/재배포하세요. 자세한 내용은 [`LICENSE`](LICENSE) 참고.

<br>
<br>

## 감사의 말
프로젝트는 [clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) 프로젝트에서 영감을 받아 제작되었습니다.

<br>
<br>

## 연락

버그를 발견했거나 기능 추가가 필요하면 편하게 연락주세요. 프로젝트가 도움이 되셨다면 우측 상단의 ⭐️ **Star**를 눌러주시면 감사하겠습니다! 큰 힘이 됩니다.

- 📧 [johnprk1993@gmail.com](mailto:johnprk1993@gmail.com)
- 🐛 [Issues](https://github.com/JohnPrk/token-panda-v2/issues)
- 💬 [Discussions](https://github.com/JohnPrk/token-panda-v2/discussions)
