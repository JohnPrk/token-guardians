# 회귀 방지 체크리스트 (token-panda)

새 버전 빌드 후 사용자가 직접 훑는 수동 스모크 시나리오. panda 워크플로우 규칙 9 — 코드 변경을 동반한 작업이 끝나고 8-B(앱 갈아끼움)까지 마친 직후, **변경과 관련된 카테고리만** 골라서 확인한다. 전체를 매번 다 돌릴 필요는 없다.

체크 방식: 각 항목 직접 시도해보고, 이상하면 메모하고, 정상이면 다음으로. 항목 본문이 한 줄짜리여도 실제 동작을 *눈으로* 확인하는 게 목적이다.

---

## 1. 메뉴바·트레이

- [ ] 메뉴바에 대나무 아이콘 + 5h 잔량 % 가 표시된다
- [ ] 5h % 가 75/50/25/0 경계를 넘을 때 트레이 아이콘이 4단계(tray-100/75/50/25.png)로 swap 된다
- [ ] 트레이 우클릭 메뉴 맨 위에 `토큰 판다 v{버전}` 비활성 라벨이 떠있고, 빌드 버전과 일치한다
- [ ] 트레이 메뉴: 펫 보이기/숨기기, 지금 새로고침, 설정, 종료 모두 동작
- [ ] 계정이 2개 이상일 때 "계정 전환 ▸" 서브메뉴에 라벨 목록이 뜬다
- [ ] **(v1.25+) 표시 모드 토글**: 메뉴 "표시 모드 ▸ ● 5h만 / ○ 5h + 주간 / ○ 5h + 주간 + $" 서브메뉴에서 토글하면 라디오 표시(●/○)가 즉시 바뀌고, 트레이 텍스트가 `76%` ↔ `76% · 주 54%` ↔ `76% · 주 54% · $12.34`로 즉시 갱신
- [ ] **(v1.25+) 표시 모드 영속**: 모드를 바꾼 후 앱을 종료/재실행해도 마지막에 선택한 모드로 라벨이 표시됨 (PlanConfig.trayMode가 store에 저장)

## 2. 펫 본체 (윈도우)

- [ ] 펫이 화면에 떠있고 데스크톱 위에서 잘 보인다
- [ ] 펫 본체 드래그로 위치 이동 가능
- [ ] 펫 주변 빈 공간(보이지 않는 윈도우 영역) 클릭하면 데스크톱 / 뒤쪽 앱으로 통과 (v1.23 mouse passthrough)
- [ ] **(v1.49+)** 거품·세션 카드 *사이*, 세션 카드 *위쪽* 빈 공간 클릭도 데스크톱으로 통과. v1.49부터 펫 윈도우가 `.pet-content` 크기에 맞춰 동적 resize되어 OS NSPanel hit-test가 잡을 빈 영역 자체가 없음. (CSS pointer-events: none 만으론 OS level dead zone 못 막아 v1.23~v1.26 시도가 모두 실패함이 확인됨)
- [ ] **(v1.49+)** 카드 stack 변동(0~5장) 시 펫 발끝 화면 위치 유지. 새 카드가 등장해도 펫이 위로 밀려나지 않고 같은 y에 머문다 (`compute_anchored_y`로 window bottom 보존, top y만 위로 이동). 카드가 사라지면 윈도우가 아래로 줄면서 발끝은 그대로
- [ ] 거품(말풍선)·캐릭터 본체 위 클릭은 펫 윈도우가 받음
- [ ] 모든 Space에서 펫이 보인다 (Mission Control 좌우 이동, 새 데스크톱 추가 후 확인)
- [ ] 다른 앱을 풀스크린 했다가 빠져나와도 펫이 사라지지 않음

## 3. idle 액션 / 시각 효과

- [ ] 일정 시간 두면 idle 액션 4종이 랜덤하게 재생 (roll / jump / run / scratch)
- [ ] wobble, squish 등 보강 액션도 재생됨
- [ ] sleepy 상태에서 scratch 대나무 잔재가 머리 위에 남지 않는다 (v1.13)
- [ ] jump 때 발 아래 그림자가 점프 높이에 맞춰 작아지고 흐려진다
- [ ] squish 때 바닥 임팩트 링 표시

## 4. 캐시 hit/miss flash

- [ ] Claude 응답이 캐시 hit이면 ✨ 노란 펄스 + 폭죽이 캐릭터 뒤에서 분사
- [ ] cache miss면 💨 viewport 바닥까지 비 (16개 분포)
- [ ] last_request_at 기준 4분 경과부터 캐시 nudge 표시 (소프트 알림)
- [ ] 5분 초과하면 nudge / 카운트다운 사라짐

## 5. 에너지 상태 전환

- [ ] full (90%~) → high → good → mid → low → tired → sleepy 각 티어에 해당하는 PNG가 잡혀 표시됨
- [ ] weekly 0% 도달 시 dead 표시 (5h가 멀쩡해도 우선)
- [ ] API stale / 연동 해제 / 폴링 실패 시 disconnected 표시
- [ ] disconnected 상태에선 dead.png 위에 "연결 실패" 나무 표지판 오버레이가 캐릭터 앞 z:100에 뜨고 좌우로 흔들림
- [ ] disconnected 상태에서 트레이 % 는 `0%`, 트레이 아이콘은 25% 티어로 떨어진다

## 6. 임계치 알림

- [ ] 5h 잔량 30%, 10%, 0% 진입 시 macOS 시스템 알림 발사
- [ ] 같은 임계치는 한 번만 발사 (래치)
- [ ] 5h가 reset되면 래치 풀려 다음 사이클에서 다시 발사 가능
- [ ] disconnected 상태에선 알림 발사되지 않는다 (v1.15 가드)

## 7. 설정 윈도우

- [ ] 트레이 메뉴 → "설정..." 누르면 별도 윈도우로 열림 (메인 펫 윈도우와 분리)
- [ ] Org ID / 쿠키 입력 필드에 텍스트 입력 가능 (freeze 없음)
- [ ] macOS 다크모드에서도 입력 텍스트가 검정으로 또렷이 보임 (v1.11)
- [ ] 한국어 줄바꿈이 자연스럽게 됨 (`word-break: keep-all`)
- [ ] 💬 도움말 버튼 → 팝업에 처리 방식 + 세션 권한 경고 안내
- [ ] 인증 실패(401/403/404) 시 설정 창이 자동 팝업 (한 번만)

## 8. 계정 시스템 (멀티 계정)

- [ ] 설정에서 "+ 새 계정" 카드로 계정 추가 가능
- [ ] 계정 카드에 캐릭터 썸네일 + 라벨 + orgId 끝 4자리 + 활성 배지 표시
- [ ] 활성 카드 클릭 = 편집 펼침, 비활성 카드 클릭 = 활성 전환
- [ ] **편집 폼이 열린 상태에서 다른 계정 카드로 편집 대상을 바꾸면, 아래 편집 폼의 라벨/skin/orgId·쿠키/provider 가 클릭한 계정 값으로 즉시 교체** (옛 계정 값이 남아 있으면 회귀 — AccountForm `key={target.id}` 미적용 시 useState 가 재초기화 안 되던 버그)
- [ ] 카드 hover ✎ 보조 버튼으로 편집 모드 진입
- [ ] 활성 계정 전환 시 트레이 % / 펫 캐릭터 / 폴링 자격증명이 한 트랜잭션으로 동기화
- [ ] 활성 계정 자격증명·skin 변경 시 메인 펫과 트레이 아이콘 즉시 반영
- [ ] 단일 계정만 있는 기존 환경 → 자동 변환되어 첫 계정으로 등록 (legacy migration)

## 9. 폴링·연결

- [ ] 정상 쿠키로 30초마다 `claude.ai/api/.../usage` 폴링
- [ ] 응답 스키마 변종 처리 (`five_hour` / `seven_day` 키 + 0–1 / 0–100 모두)
- [ ] 쿠키 만료되면 다음 폴링에서 disconnected 진입
- [ ] 쿠키 재입력 후 다음 폴링 사이클에 자동 복구

## 10. 빌드·배포

- [ ] `npm run tauri:build` 성공
- [ ] dmg 파일명이 `token-panda_X.Y.Z_aarch64.dmg` 형식 (ASCII, rename-dmg.mjs 실행됨)
- [ ] `package.json` / `Cargo.toml` / `tauri.conf.json` 버전이 모두 일치
- [ ] README 배지의 버전 + dmg 링크가 새 버전으로 갱신됨
- [ ] `npm test` 전체 통과
- [ ] `cargo test` (src-tauri 안에서) 전체 통과
- [ ] `/Applications/<앱>.app` 교체 후 메뉴바에 새 판다 1개만 떠 있음 (트레이 중복 없음)

## 11. 자동 업데이트 (v1.24+)

- [ ] **부팅 직후 (3초 후)** GitHub Releases API 1회 호출 — 네트워크 끊겨도 앱은 정상 동작 (트레이 평소 모습 유지)
- [ ] **GitHub 최신 = 현재 버전**일 때: 트레이 메뉴 헤더가 `토큰 판다 vX.Y.Z` (인라인 마커 없음), 메뉴에 `🆕 새 버전 설치` 아이템 없음
- [ ] **GitHub 최신 > 현재 버전**일 때: 헤더가 `토큰 판다 vX.Y.Z · 🆕 vA.B.C 있음`, 헤더 바로 아래에 `🆕 새 버전 vA.B.C 설치` 활성 아이템 추가
- [ ] **GitHub 최신 < 현재 버전**(로컬에서 미리 빌드)일 때: 평소 모습 유지 (다운그레이드 안 함)
- [ ] **설치 클릭** → macOS 알림 "토큰 판다 업데이트 / 새 버전 다운로드 중" 1회
- [ ] 다운로드 완료 → 현재 앱 자동 종료
- [ ] `/Applications/토큰 판다.app`이 새 버전으로 교체됨 (메뉴바에 새 판다 1개만, 트레이 중복 없음)
- [ ] 새 앱 자동 실행 → 메뉴바에 새 버전이 다시 등록되고 헤더가 새 버전으로 표시
- [ ] 백업 `토큰 판다.app.bak` 파일은 3초 후 자동 삭제 (`ls /Applications/ | grep panda` 로 확인)
- [ ] **연타 방지**: 사용자가 설치를 누른 직후 메뉴를 다시 펴서 다시 눌러도 한 번만 진행
- [ ] **새 앱 미기동 시 fallback**: 만약 새 앱이 안 뜨면 `.bak`이 자동으로 원래 자리로 복구
- [ ] **rate limit**: 1시간에 1번만 폴링 (`/tmp/panda-update.log` 또는 Console.app에서 fetch 로그 빈도 확인)
- [ ] **싱글 인스턴스 강제**: 이미 떠있는 상태에서 `open /Applications/토큰 판다.app` 또는 binary 직접 실행 두 번째 시도해도 두 번째 인스턴스 안 뜨고, 기존 메인 윈도우만 show + focus 됨

## 12. 세션 stack (v1.26+)

여러 Claude Code 세션 동시에 굴릴 때 펫 위쪽에 카드 stack으로 prompt cache 5분 카운트다운 표시.

- [ ] **세션 1개 활성** (Claude Code 1개 터미널에서 응답 받은 직후): 펫 위쪽에 카드 1장이 뜸 (사용자 명시: 1개여도 stack 표시)
- [ ] **세션 2~3개 동시 활성**: 카드 stack에 최신순(desc)으로 위에서 아래로 쌓임
- [ ] **세션 5개 초과**: 최신 5개만 보임 (그 이상은 stack에서 빠짐)
- [ ] **카드 내용**: 최근 user prompt 요약(한 줄, 최대 40자, 초과 시 `…`) + 우측에 `M:SS` 카운트다운
- [ ] **하단 진행 바**: 5분 시작 시 카드 너비 full, 시간 가면서 width 100%→0%로 줄어듦 (좌측 고정, 우측이 비어가는 형태)
- [ ] **세션 색상 분배**: 카드마다 hue가 미묘하게 다름 (session uuid 해시 → 0~359 hue). 같은 세션은 항상 같은 색
- [ ] **5분 만료**: assistant 응답 후 5분 지나면 카드가 자동으로 stack에서 빠짐
- [ ] **카드 클릭 무동작**: 카드 클릭해도 아무 일 안 일어나고 클릭이 데스크톱으로 통과 (v1.23 mouse passthrough 일관성)
- [ ] **펫 윈도우 높이**: 카드가 위쪽에 쌓여도 펫 본체 위치는 그대로 (윈도우 height가 v1.26에서 460으로 늘어남, 빈 공간은 passthrough라 사용자 눈에 안 보임)
- [ ] **활성 세션 없음**: stack 자체가 안 그려져야 함 (빈 공간이라도 발자국 없음)

**검증 시나리오:**
1. 별도 터미널에서 `claude` 두세 개 띄움. 각각 짧은 prompt → 응답 받음
2. 펫 윈도우 위쪽에 카드 2~3장이 쌓이는지 확인
3. 30초~1분 기다리면 진행 바 width가 줄어드는 게 보임
4. 5분 지나면 카드가 자동으로 사라짐

---

## 14. API prepaid 잔액 (v1.48+)

표시 모드 `5h + 주간 + $` 선택 시 트레이/펫 카드에 platform.claude.com 의 prepaid 잔액(달러)이 추가 노출된다. usage 호출과 같은 30s poller cycle에서 별도 endpoint(`/api/organizations/{org}/prepaid/credits`)로 가져온다. trayMode가 `fivehour`/`both`인 동안은 호출만 되고 화면엔 안 보임.

- [ ] **표시 모드 토글로 진입**: 트레이 메뉴 "표시 모드 ▸"에서 `5h + 주간 + $` 선택 → 라디오 ● 표시가 그쪽으로 이동
- [ ] **트레이 라벨**: 모드 진입 후 다음 폴링 사이클(최대 30s) 안에 트레이 텍스트가 `76% · 주 54% · $12.34` 형식으로 갱신
- [ ] **펫 카드**: 펫 윈도우 5h/주간 줄 아래에 세 번째 줄 `$  $12.34  prepaid` 등장
- [ ] **prepaid 값 없음 폴백**: 모드가 `all`이지만 prepaid가 아직 안 들어왔거나 endpoint가 실패한 경우, 트레이는 `76% · 주 54%`까지만 (라벨 깜빡임 방지), 펫 카드의 세 번째 줄도 안 뜸
- [ ] **disconnected 가드**: 쿠키 만료/연동 해제 시 트레이 라벨은 `0% · 주 0%`로 떨어지고, prepaid는 그 동안 표시하지 않음
- [ ] **모드 영속**: `all` 선택 후 앱 종료/재실행해도 모드 유지 (PlanConfig.trayMode === "all" 저장)
- [ ] **연동 해제 시 reset**: 활성 계정 삭제 또는 모든 계정 비움 → 다음 폴링부터 prepaid 슬롯 비워짐 + 펫 카드 세 번째 줄 사라짐
- [ ] **format 정확도**: $0.00 ~ $9999.99 범위에서 항상 `$X.XX` (소수점 둘째자리 2자리 강제)
- [ ] **(v1.74+) cents 매핑 정확도**: Anthropic Console 의 prepaid 잔액과 펫 트레이의 `$X.XX` 가 정확히 같다. 특히 $10 미만 (raw 3자리 cents, 예 963 → $9.63) 에서 `$963.00` 같은 dollars 오인 해석이 일어나지 않는다. v1.73 까지 `coerce_dollars` 가 raw `>= 1000` 일 때만 cents 로 보던 임계 휴리스틱을 폐기한 회귀 게이트.
- [ ] **계정 전환 시 prepaid 갱신**: 두 번째 계정으로 전환 직후 그 계정의 prepaid 잔액으로 트레이/카드가 갱신됨 (이전 계정 값이 남아있으면 안 됨)
- [ ] **rate**: prepaid 호출이 usage 호출과 같은 30s cycle에서 1회만 (Network 탭에서 1분에 2회 확인)

---

## 18. 이번 달 API 키별 비용 (트레이 "월별 API 사용량" 전용 창, v2.22+)

트레이 메뉴 "계정 전환" 바로 밑 **"월별 API 사용량"** 항목 → 전용 창이 뜨고, platform.claude.com 콘솔의 키별 "비용" 컬럼을 합산해 보여준다. **폴링 안 함 — 창이 열릴 때(컴포넌트 마운트) IPC `fetch_api_key_costs` 1회만**. 총합 한 줄은 상시, 키별 $ 상세는 마우스 호버 시 펼침. org 는 공유 쿠키로 platform `/api/organizations` 에서 API(콘솔) 조직 uuid 를 자동 발견(platformOrgId 가 있으면 그걸 우선).

- [ ] **메뉴 항목 위치**: 트레이 메뉴에서 "계정 전환" 바로 아래(구분선 위)에 "월별 API 사용량" 항목이 보임
- [ ] **창 등장**: 항목 클릭 → "토큰 판다 — 월별 API 사용량" 전용 창 + "이번 달 API 사용량" 헤더 + "YYYY. MM" 라벨. 처음엔 "불러오는 중…" → 곧 결과로 교체. 다시 클릭하면 같은 창 재사용(중복 안 뜸)
- [ ] **총합 표시**: `$X.XX` 큰 글씨 + "키 N개 · 올리면 상세" 힌트. 콘솔 비용 컬럼 합과 일치(예: 콘솔 키들 $1.78+$0.53+…=총합)
- [ ] **호버 상세**: 총합 박스에 마우스를 올리면 키별 목록(`키 이름 …… $X.XX`, 달러 내림차순)이 아래로 펼쳐지고, 마우스를 떼면 접힘. 맨 아래 "합계" 줄
- [ ] **키 이름 조인**: 각 행이 콘솔의 키 이름(api_keys 의 name)으로 표시. 목록에 없는 의사키("console")는 "콘솔 직접 사용"
- [ ] **단위 정확도**: 각 키 $ 가 콘솔 "비용" 컬럼 값과 1:1 일치(total 센트÷100). 총합은 센트 합산 후 반올림(개별 반올림 누적 아님)
- [ ] **권한 없음(403) 안내**: claude.ai 채팅 세션만 있는 계정(콘솔 미설정 API org)은 "이 계정의 claude.ai 세션으로는 콘솔 비용을 읽을 권한이 없어요 … 'Platform 쿠키'에 콘솔 세션 쿠키를 넣어주세요" 안내. 계정 편집의 platformCookie 에 콘솔 세션을 넣으면 그 콘솔 비용이 보임
- [ ] **gemini/계정없음 폴백**: 활성 계정이 Gemini → "Claude 계정만 가능" / 계정 0개 → "계정을 추가하면…" 안내 문구
- [ ] **rate**: "월별 API 사용량" 창을 열 때만 요청(폴링 아님). 한 번 열면 organizations 1 + usage_cost 1 + api_keys 1 = 최대 3 요청, 그 뒤로 추가 호출 없음

---

## 15. 펫 크기 조정 — resize handle (v1.70+)

펫 윈도우 우하단(= 캐릭터 발 옆) 의 ↘ 핸들을 드래그해서 펫 + UsageBubble + 세션 stack 전체 zoom 조정. PlanConfig.petScale 영속. 0.6 ~ 1.5 범위. v1.49 동적 윈도우 resize 흐름과 통합 (`compute_anchored_y` bottom anchor 유지) + v1.70 화면 cap (`cap_window_top` / `cap_window_right`) 으로 메뉴바·우측 경계 밖으로 안 빠짐.

**핵심 검증 — 5분 안 훑기:**

- [ ] **핸들 시각 표시**: 캐릭터 발 옆 우하단에 ↘ 아이콘이 담긴 작은 라운드 카드(흰색 배경 + 둥근 보더 + 살짝 그림자). hover 시 강조
- [ ] **드래그 = scale 변화**: 핸들에 mousedown → 마우스 우/하로 드래그 = 펫 + 카드 같이 커짐 / 좌/상 드래그 = 작아짐. 200px 드래그 ≈ 0.5 단위 변화
- [ ] **scale 범위 clamp**: 더 작게 끌어도 0.6 미만 안 됨, 더 크게 끌어도 1.5 초과 안 됨 (PET_SCALE_MIN/MAX)
- [ ] **scale 영속**: 드래그 끝나면(pointerup) PlanConfig.petScale 저장. 앱 종료/재실행 후 마지막 scale 그대로 복원
- [ ] **핸들 크기 일정**: 펫이 커지든 작아지든 *핸들 자체 크기는 22px 고정*. counter-scale(`transform: scale(1/scale)` + `transformOrigin: 'bottom right'`) 로 inner 의 transform: scale 효과 정확히 상쇄
- [ ] **핸들 위치 = 발 옆**: 핸들이 .pet-content-inner 우하단 = 캐릭터 발 옆 근처에 *딱 붙음*. 펫이 커지면 그에 따라 핸들도 시각 위치 이동 (펫과 분리 안 됨)
- [ ] **윈도우 크기 동적 갱신**: scale 변화 시 윈도우 자체 크기(`set_size`) 도 같이 변화 → 콘텐츠가 윈도우 안에 정확히 fit, 잘림 없음. ResizeObserver 가 `.pet-content-inner` 의 `offsetWidth/offsetHeight` (transform 적용 *전* layout box) 측정 + scale 곱한 값으로 invoke
- [ ] **bottom anchor 유지 (1.0 ↔ 1.5)**: scale 변경 후 펫 발끝의 화면 y 위치가 *대체로* 유지 (메뉴바 cap 에 걸리면 양보)
- [ ] **메뉴바 cap (top)**: scale max(1.5) 에서 윈도우 top 이 화면 메뉴바(약 24px) 위로 안 빠짐. 카드 stack 윗부분이 잘리지 않고 메뉴바 아래에서 시작 (`cap_window_top` 적용)
- [ ] **우측 cap (right)**: 펫이 화면 우측 끝에 있을 때 scale 키워도 윈도우 우측이 모니터 우측 경계(- 8px inset) 넘지 않음 → 펫 + 핸들이 자동으로 좌측으로 살짝 이동 (`cap_window_right` 적용)
- [ ] **scale=1 기본값**: 첫 실행 또는 PlanConfig.petScale 누락 시 1.0 으로 시작 (`PET_SCALE_DEFAULT`)
- [ ] **passthrough 유지**: scale 변경해도 펫 윈도우 빈 영역(카드와 펫 사이 등) 클릭은 데스크톱으로 통과. 핸들 클릭만 잡힘
- [ ] **idle 액션 정상**: scale=1.5 에서도 roll / jump / run / scratch / wobble / squish 액션 정상 재생 (transform scale 과 idle CSS 충돌 없음)
- [ ] **flash hit/miss 정상**: scale 변경 상태에서 캐시 hit ✨ / miss 💨 효과 정상 표시 (이펙트가 펫 박스에 묶여 같이 scaled)

**검증 시나리오:**
1. 펫을 화면 *우측 끝*으로 드래그
2. 핸들을 잡고 우/하로 max 까지 드래그
3. 카드 / 핸들 / 펫 모두 화면 안에 보이고 잘림 없는지 확인
4. ⌘Q 종료 → 다시 실행 → 마지막 scale 그대로 떠있는지

---

## 13. orgId/쿠키 자동 캡처 — paste 방식 (v1.27+)

설정 wizard "자동으로 가져오기" → 시스템 Chrome으로 claude.ai/settings/usage 열림 → wizard의 paste 박스에 cookie 한 줄 붙여넣기 → orgId + 쿠키 자동 채움.

**(임베디드 webview 방식은 폐기됨: claude.ai가 magic link 인증만 보내고, 그 링크는 시스템 기본 브라우저에서 열리므로 임베디드 webview에 cookie가 박힐 수 없음.)**

- [ ] **온보딩 첫 진입**: 1단계 캐릭터 선택 후 2단계로 가면 ① 안내 위쪽에 보라색 "자동으로 가져오기" 버튼이 뜬다
- [ ] **계정 폼**: 설정 → "+ 새 계정" 또는 활성 계정 편집 → 폼 하단 액션 줄에 "자동으로 가져오기" 버튼
- [ ] **버튼 클릭 시 동작**: 시스템 기본 브라우저(Chrome)로 `claude.ai/settings/usage` 페이지가 새 탭에 열리고, wizard 안에는 **paste 박스**가 등장 (3단계 안내 + textarea)
- [ ] **paste 박스 닫기**: 우측 상단 ✕ 버튼으로 paste 모드 취소 가능. textarea 비워지고 상태 메시지도 사라짐
- [ ] **cookie 붙여넣기**: Chrome 페이지에서 ⌘⌥I → Network → `usage` 요청 → Headers → `cookie:` 헤더 한 줄 복사 → wizard의 textarea에 ⌘V
- [ ] **자동 처리**: paste 즉시 `sessionKey=` 패턴 감지 → "Cookie 분석 중…" 상태 표시 → 성공 시 paste 박스 사라지고 Org ID + 세션 쿠키 필드가 자동 채워짐
- [ ] **성공 메시지**: 상태 줄에 "자동으로 가져왔어요" (온보딩) / "자동으로 가져왔어요." (계정 폼) 표시
- [ ] **테스트 검증**: 채워진 값으로 "연결 테스트" 누르면 `5h X% · 주간 X%` 정상 응답 (이모지 없이)
- [ ] **5종만 추리기**: paste한 cookie에 다른 잡쿠키(`_ga`, `_pendo_*` 등) 섞여 있어도, 폼에 채워진 cookie는 `sessionKey; cf_clearance; __cf_bm; _cfuvid; routingHint` 5종만 (parse_raw_cookie_header + build_cookie_header)
- [ ] **에러 경로 — sessionKey 없음**: 잡쿠키만 paste → "sessionKey 쿠키가 보이지 않아요" 메시지 + paste 모드 유지 (다시 시도 가능)
- [ ] **에러 경로 — 만료된 cookie**: 만료된 cookie paste → "/api/organizations HTTP 401" 또는 비슷한 메시지 + paste 모드 유지
- [ ] **수동 입력 fallback**: 자동 가져오기 안 써도 ①② 안내대로 직접 붙여넣기 여전히 동작 (기존 Organization ID + 세션 쿠키 필드 그대로 사용)
- [ ] **Chrome이 기본 브라우저가 아닌 경우**: macOS 기본 브라우저가 Safari/Firefox/Arc면 그쪽에서 열림. 사용자 환경에 맞게 동작

## 17. Provider 분리 — Gemini 추가 (v2.18+)

`Account` 가 discriminated union(`provider: "claude" | "gemini"`) 으로 분기. 옛 단일 Claude 가정에서 멀티 provider 로 옮겨졌다. 검증 포커스는 (a) legacy claude 계정이 손실 없이 그대로 도는지 (b) Gemini 한 계정으로 추가/전환 시 사용량이 라이브로 뜨는지 (c) 두 provider 가 트레이/UsageBubble 양쪽에 같은 모양으로 그려지는지.

- [ ] **Legacy claude 계정 자동 인식**: 옛 store(`provider` 필드 없음) 그대로 부팅하면 메뉴바 라벨에 5h%/주간% 가 종전대로 표시되고 펫 표정이 normal. 마이그레이션 메시지나 onboarding 다시 안 뜸
- [ ] **Gemini 계정 추가**: 설정 → 새 계정 추가 → 상단 "Gemini" 탭 클릭 → "자동으로 가져오기" 누르면 `gemini.google.com/usage` 가 Chrome 에 열림 → DevTools Network → cookie 한 줄 복사 → 붙여넣기 칸에 paste → cookie 필드에 그대로 옮겨짐
- [ ] **Gemini 테스트 버튼**: 테스트 누르면 한 줄에 `5h XX% · 주간 XX% · PRO` (또는 ULTRA/PLUS) 표시. tier 가 비어 있어도 5h/주간 두 값은 항상 표시
- [ ] **Gemini 활성 시 트레이**: Gemini 를 활성 계정으로 두면 트레이 라벨에 Gemini 의 5h%/주간% 가 동일 포맷으로 표시 (panda v1.96+ 대나무 tier 아이콘도 같이 동작)
- [ ] **Provider 전환**: 트레이 메뉴 "계정" 서브메뉴에서 Claude ↔ Gemini 전환 시 한 번의 polling cycle(30s 이내) 안에 트레이 라벨이 새 provider 값으로 갱신, 펫 표정도 새 잔량 % 기준으로 재계산
- [ ] **Provider별 paste hint**: paste capture 박스 안의 안내문이 provider 에 맞게 바뀜 — Claude 는 `usage` 요청, Gemini 는 `batchexecute` 요청을 가리킴
- [ ] **편집 모드 provider 토글 비노출**: 기존 계정 편집 시 provider 탭은 안 뜸 (자료 손실 위험 방지)
- [ ] **WIZ scrape 실패 메시지**: Gemini 쿠키가 만료됐거나 SID 만 빠진 채로 저장하면 설정창 status 가 "쿠키 만료 또는 Google 로그아웃 상태" 류 한 줄로 표시 (응답 빈 페이지가 그대로 튀어나오지 않음)
- [ ] **prepaid 미지원 가드**: Gemini 활성 계정 + trayMode="all"(5h+주간+$) 라도 prepaid 호출은 일어나지 않고 `$` 부분은 자동으로 빠짐 (provider.capabilities.prepaid=false 분기)
- [ ] **테스트 회귀 없음**: `npm test` 의 frozen 케이스(claudeApi.test.mjs 12건, store.test.ts 13건) 가 모두 통과. 새 케이스 +45 (providers/gemini.test.mjs 29 + providers/index.test.mjs 10 + store.test.ts 신규 6)
- [ ] **Gemini 쿠키 회전 자동 갱신 (v2.20+)**: Gemini 계정을 활성으로 두고 앱을 *오래 켜둬도*(수십 분~몇 시간) "SNlM0e 비어있음/로그아웃" 에러로 끊기지 않음. 매 폴링(30s)마다 응답 `Set-Cookie` 의 회전 토큰(`__Secure-1PSIDTS`/`SIDCC` 계열)이 저장 쿠키에 머지됨. 앱 재시작 후에도 직전 갱신된 쿠키로 곧장 연결(store write-back). 단, 앱을 수 시간 완전히 꺼두면 SIDTS 만료로 재-paste 필요(정상)

## 16. 업데이트 일지 + 업데이트 팝업 (v2.26+)

큰 작업만 큐레이션한 일지(`src/changelog.ts`). 트레이 메뉴 "업데이트 일지" → 전체 목록. 새 버전으로 올라가면 부팅 시 "방금 업데이트됨" 팝업(직전 본 버전 이후 항목만).

- [ ] **트레이 메뉴 항목**: 트레이 메뉴 "설정..." 바로 아래에 "업데이트 일지" 항목이 있고, 클릭하면 일지 창이 뜬다
- [ ] **전체 목록(메뉴 진입)**: 메뉴로 열면 모든 항목이 최신순(맨 위가 최신)으로 보이고, 상단 헤더는 "업데이트 일지", "방금 업데이트됨" 배지 없음
- [ ] **창 재사용**: 일지 창이 이미 떠 있을 때 메뉴를 다시 누르면 새 창이 또 안 뜨고 기존 창이 앞으로 온다
- [ ] **닫기**: "닫기" 버튼으로 창이 닫히고, 다시 열 수 있다
- [ ] **업데이트 팝업**: 더 낮은 버전을 `changelogLastSeenVersion`(config.json)으로 저장한 상태에서 실행하면 부팅 1.5초 뒤 "방금 업데이트됨" 배지 + "이번 업데이트에서 바뀐 점" 헤더로 팝업, 직전 버전 이후 항목만 노출
- [ ] **재실행 시 안 뜸**: 팝업을 한 번 본 뒤(또는 같은 버전 재실행) 다시 실행하면 팝업이 안 뜬다 (baseline이 현재 버전으로 갱신됨)
- [ ] **신규 설치 무팝업**: `changelogLastSeenVersion`이 없는 첫 실행에는 팝업이 안 뜨고 baseline만 조용히 기록된다

---

**다운그레이드 검증 시나리오** (자동 업데이트 흐름을 처음 검증할 때):
1. Cargo.toml + tauri.conf.json + package.json 버전을 임시로 낮은 버전(예: `1.20.0`)으로 낮춰서 `npm run tauri:build`
2. 빌드된 dmg를 `/Applications`에 설치 후 실행 → 메뉴 열기 → 헤더에 `🆕 v1.23.0 있음` 마커 + `🆕 새 버전 v1.23.0 설치` 아이템 등장 (GitHub 최신이 v1.23이므로)
3. 설치 클릭 → 알림 → 자동 종료 → 새 v1.23 앱이 실행되고 헤더가 `토큰 판다 v1.23.0`으로 복귀
4. 확인 후 Cargo.toml/tauri.conf.json/package.json을 다시 v1.24.0으로 되돌리고 정식 빌드

---

## 사용 메모

- panda 워크플로우 규칙 9가 이 파일을 가리킨다. 검증 단계에서 Claude가 변경된 카테고리 번호를 짚어줄 것.
- 항목이 회귀되어 깨졌다면 그 자체가 새 [소] 항목 후보 — features.md "진행 중"에 등록.
- 새 기능을 추가하면 이 체크리스트에 해당 항목을 *같이* 추가한다. 체크리스트는 코드와 함께 성장한다.
