// 업데이트 일지(체인지로그) — 큰 작업/사용자에게 보이는 변화만 손으로 큐레이션.
// version.md(내부 기술 기록)와 분리: 여기 들어가는 문장은 사용자가 읽을 짧은 요약.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ 새 항목 추가하는 법 (여기만 고치면 됩니다)                                 │
// ├─────────────────────────────────────────────────────────────────────────┤
// │ 아래 CHANGELOG 배열 맨 위에 한 덩어리를 새로 넣으세요(최신이 맨 앞).        │
// │                                                                           │
// │   {                                                                       │
// │     version: "2.30.0",        // package.json 과 같은 X.Y.0 표기           │
// │     date: "2026-06-01",                                                    │
// │     title: "한 줄 제목",       // 접혀 있을 때 보이는 제목                  │
// │     body: `                    // 펼치면 보이는 본문 (마크다운)            │
// │ 여기에 마크다운을 씁니다.                                                  │
// │                                                                           │
// │ - 불릿                                                                    │
// │ - **굵게**, *기울임*, [링크](https://...)                                 │
// │                                                                           │
// │ ![이미지 설명](changelog-media/foo.png)   ← 이미지                        │
// │                                                                           │
// │ <video src="changelog-media/foo.mp4" controls></video>  ← 동영상          │
// │ `,                                                                        │
// │   },                                                                      │
// │                                                                           │
// │ ■ 이미지/동영상 파일 두는 곳                                              │
// │   public/changelog-media/ 폴더에 파일을 넣고, 본문에서                     │
// │   `changelog-media/파일이름` 으로 참조하면 앱에 같이 번들됩니다(오프라인   │
// │   에서도 보임). 원격 주소(https://...)를 그대로 써도 됩니다.               │
// │   ※ 동영상을 번들하면 앱 용량이 그만큼 커집니다. 큰 영상은 원격 URL 권장.  │
// └─────────────────────────────────────────────────────────────────────────┘
//
// 동작:
//   - 트레이 "업데이트 일지" 클릭 → 전체 목록(접힌 상태, 제목만)
//   - 앱이 새 버전으로 업데이트되면 부팅 시 자동 팝업 → 직전에 본 버전 이후의
//     항목만, 펼쳐진 상태로 노출

export interface ChangelogEntry {
  version: string; // "2.15.0" — package.json semver 와 동일 표기
  date: string; // "2026-05-24"
  title: string; // 접힘 상태에서 보이는 한 줄 제목
  body: string; // 펼치면 보이는 본문 (마크다운). 이미지·동영상 포함 가능.
}

// 최신이 맨 앞.
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "2.17.0",
    date: "2026-05-26",
    title: "새 판다·고양이 + 칙칙해지지 않는 펫",
    body: `
- 새 캐릭터 두 친구를 추가했어요. 정통 판다(**panda-v4**, 새 기본 스킨) 와 회색·크림 고양이(**cat-v2**). 둘 다 앉기·옆으로 자기 포즈가 들어있어요.
- 토큰 잔량이 줄어도 캐릭터가 어둡거나 칙칙해지지 않게 정리했어요. 움직임이 느려지는 표현은 그대로 유지.
- 정리한 옛 스킨: panda-v3 / cat-v1 / penguin-v1 / penguin-v2. 옛 스킨을 쓰던 분은 자동으로 panda-v4 로 전환됩니다.
`,
  },
  {
    version: "2.15.0",
    date: "2026-05-24",
    title: "새 캐릭터 친구들",
    body: `
- 새 판다 캐릭터(**panda-v3**)와 고양이 캐릭터(**cat-v1**)를 추가했어요. 설정에서 골라보세요.
- 오래된 캐릭터 셋은 정리했습니다.
`,
  },
  {
    version: "2.12.0",
    date: "2026-05-22",
    title: "펫이 처음 놓은 자리에 머물러요",
    body: `
- 데스크탑(Space)을 좌우로 넘길 때 펫이 두 마리로 보이던 문제를 고쳤어요.
- 이제 펫은 처음 놓은 데스크탑에만 살고, 다른 데스크탑에선 보이지 않습니다.
`,
  },
  {
    version: "2.11.0",
    date: "2026-05-22",
    title: "화면 끝 드래그가 매끄러워졌어요",
    body: `
- 펫을 화면 왼쪽/위쪽 끝으로 끌면 가운데로 튕기던 현상을 수정했어요.
- 끝으로 갈 때 잿빛 사각형이 잠깐 보이던 잔상도 사라졌습니다.
- 듀얼 모니터의 왼쪽 확장 화면으로도 자연스럽게 옮길 수 있어요.
`,
  },
  {
    version: "2.10.0",
    date: "2026-05-22",
    title: "Windows 작업표시줄 아이콘",
    body: `
- Windows 작업표시줄에 대나무 아이콘이 항상 보이도록 했어요. 우클릭 메뉴(설정·종료)에 쉽게 접근할 수 있습니다.
`,
  },
  {
    version: "2.09.0",
    date: "2026-05-22",
    title: "세션 카드와 토큰 표시 복원",
    body: `
- 진행 중인 Claude 세션 카드가 다시 떠요.
- 5시간/주간 토큰 사용량, 캐시 적중·실패 효과(✨/💨)도 함께 돌아왔습니다.
`,
  },
  {
    version: "1.96.0",
    date: "2026-05-22",
    title: "메뉴바 대나무 잔량 아이콘",
    body: `
- "5시간" 표시 모드에서 메뉴바 아이콘이 잔량에 따라 대나무 1~4줄기로 바뀌어요.
`,
  },
  {
    version: "1.85.0",
    date: "2026-05-22",
    title: "더 안정적인 앱으로",
    body: `
- 앱 내부 구조를 새 기반으로 옮겨 펫 표시와 설정 창 입력이 더 안정적이에요.
`,
  },
  {
    version: "1.74.0",
    date: "2026-05-21",
    title: "Windows 지원",
    body: `
- Windows에서도 설치하고 쓸 수 있어요.
- 트레이 아이콘과 시작하기·설정 창이 Windows에서 제대로 뜨도록 다듬었습니다.
`,
  },
  {
    version: "1.70.0",
    date: "2026-05-18",
    title: "펫 크기 조절",
    body: `
- 펫 오른쪽 아래 모서리의 핸들(↘)을 끌어서 크기를 조절할 수 있어요.
- 조절한 크기는 다음 실행에도 그대로 유지됩니다.
`,
  },
  {
    version: "1.48.0",
    date: "2026-05-17",
    title: "선불 잔액 표시",
    body: `
- "5시간 + 주간 + $" 표시 모드를 켜면 선불 크레딧 잔액($)도 메뉴바에 함께 보여요.
`,
  },
  {
    version: "1.37.0",
    date: "2026-05-16",
    title: "쿠키 자동 가져오기",
    body: `
- 설정의 **자동으로 가져오기** 버튼을 누르면 claude.ai가 열리고, 쿠키 한 줄만 붙여넣으면 Org ID와 세션 키를 자동으로 채워줘요.
- 직접 입력하는 기존 방식도 그대로 쓸 수 있습니다.
`,
  },
  {
    version: "1.26.0",
    date: "2026-05-16",
    title: "세션 카드",
    body: `
- 진행 중인 Claude 세션을 카드로 보여줘요. 어떤 작업인지 미리보기와 남은 시간이 함께 떠요.
`,
  },
  {
    version: "1.25.0",
    date: "2026-05-16",
    title: "트레이 표시 모드 선택",
    body: `
- 메뉴바에 표시할 내용을 **5시간만 / 5시간 + 주간 / 5시간 + 주간 + $** 중에서 고를 수 있어요.
`,
  },
  {
    version: "1.24.0",
    date: "2026-05-16",
    title: "자동 업데이트",
    body: `
- 새 버전이 나오면 트레이에서 알려주고, 클릭 한 번으로 바로 설치돼요.
`,
  },
  {
    version: "1.23.0",
    date: "2026-05-09",
    title: "빈 공간 클릭 통과",
    body: `
- 펫 주변의 투명한 영역을 클릭하면 뒤쪽 데스크탑이나 앱으로 그대로 통과돼요. 펫이 클릭을 가로채지 않습니다.
`,
  },
  {
    version: "1.22.0",
    date: "2026-05-09",
    title: "여러 계정",
    body: `
- 계정을 여러 개 등록하고 트레이에서 전환할 수 있어요.
- 계정마다 다른 캐릭터를 지정할 수 있습니다.
`,
  },
  {
    version: "1.0.0",
    date: "2026-05-02",
    title: "🎉 정식 출시",
    body: `
- 토큰 판다 **1.0** 이 나왔어요!
- 연결이 끊기면 "연결 실패" 표지판을 들고, 캐시 효과와 idle 동작을 더 자연스럽게 다듬었습니다.
`,
  },
  {
    version: "0.8.0",
    date: "2026-05-01",
    title: "설정 창 분리 + 디자인 정리",
    body: `
- 설정을 별도 창으로 분리해서 입력이 막히던 문제를 해결했어요.
- 캐릭터 선택 그리드, 도움말 팝업을 추가했습니다.
`,
  },
  {
    version: "0.7.0",
    date: "2026-05-01",
    title: "claude.ai 실시간 사용량 연동",
    body: `
- 세션 쿠키로 30초마다 실시간 5시간/주간 사용량을 가져와요.
`,
  },
  {
    version: "0.6.0",
    date: "2026-05-01",
    title: "화면에 펫 고정 (macOS)",
    body: `
- 어느 데스크탑에서나 펫이 보이도록 화면에 고정했어요.
- Dock 아이콘은 숨겨서 메뉴바 전용으로 동작합니다.
`,
  },
  {
    version: "0.5.0",
    date: "2026-05-01",
    title: "메뉴바 트레이 + 잔량 알림",
    body: `
- 메뉴바에 잔량 %를 표시하고, 30·10·0%에서 시스템 알림을 보내요.
`,
  },
  {
    version: "0.4.0",
    date: "2026-05-01",
    title: "캐시 효율 시각화",
    body: `
- 응답 대기(thinking)를 감지하고, 캐시 적중/실패를 효과로 보여줘서 캐시 효율을 눈으로 확인할 수 있어요.
`,
  },
  {
    version: "0.3.0",
    date: "2026-05-01",
    title: "토큰 사용량 표시",
    body: `
- 배터리 모양 버블로 5시간·주간 사용량과 리셋까지 남은 시간을 보여줘요.
`,
  },
  {
    version: "0.2.0",
    date: "2026-05-01",
    title: "판다 캐릭터",
    body: `
- 에너지 단계에 따라 표정이 바뀌는 판다 캐릭터, idle 동작, 캐시 효과가 들어왔어요.
`,
  },
  {
    version: "0.1.0",
    date: "2026-05-01",
    title: "토큰 판다 시작",
    body: `
- 첫 빌드예요. 데스크톱 한 켠에 사는 토큰 모니터링 펫으로 출발합니다. 🎋
`,
  },
];

// "1.2.3" / "v1.2" → [major, minor, patch]. 두 segment 는 patch=0. 실패는 null.
export function parseVer(tag: string | null | undefined): [number, number, number] | null {
  if (typeof tag !== "string") return null;
  const s = tag.startsWith("v") ? tag.slice(1) : tag;
  const parts = s.split(".");
  if (parts.length < 2 || parts.length > 3) return null;
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const patch = parts.length === 3 ? Number(parts[2]) : 0;
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return null;
  }
  return [major, minor, patch];
}

// candidate > base 면 true. 파싱 실패는 false(보수적). updater.cjs:isNewer 와 동일 의미.
export function isNewerVer(base: string | null | undefined, candidate: string | null | undefined): boolean {
  const b = parseVer(base);
  const c = parseVer(candidate);
  if (!b || !c) return false;
  for (let i = 0; i < 3; i++) {
    if (c[i] > b[i]) return true;
    if (c[i] < b[i]) return false;
  }
  return false;
}

// since 보다 새 버전의 항목만 (최신순 보존). since 가 null/빈값이면 전체를 반환
// (= "전부 새 항목" 의미). whatsnew 팝업은 main 이 직전 버전을 넘겨 줘서 since 가 항상 채워진다.
export function entriesNewerThan(
  entries: ChangelogEntry[],
  since: string | null | undefined,
): ChangelogEntry[] {
  if (!since) return entries;
  return entries.filter((e) => isNewerVer(since, e.version));
}
