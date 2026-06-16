// 메뉴 항목 단일 레지스트리. 시스템 트레이 메뉴와 캐릭터 우클릭 컨텍스트 메뉴가
// *같은* 항목 목록을 공유한다. 새 항목은 여기 MENU_ITEMS 한 곳에만 추가하면
// 트레이·우클릭 양쪽에 동시에 반영된다(핸들러는 main.cjs:menuItemTemplate 에 부착).
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ 새 메뉴 항목 추가하는 법                                                   │
// ├─────────────────────────────────────────────────────────────────────────┤
// │ 1) 아래 MENU_ITEMS 배열에 원하는 위치로 descriptor 한 줄 추가             │
// │ 2) main.cjs 의 menuItemTemplate(id) switch 에 그 id 의 라벨+클릭 핸들러   │
// │ 이 둘이면 트레이·우클릭 메뉴·설정 토글 아코디언에 모두 자동 노출된다.      │
// └─────────────────────────────────────────────────────────────────────────┘
//
// descriptor 필드:
//   id          : 안정적 키(라벨이 아님 — 토글 저장·설정 UI 가 이 키로 묶임)
//   kind        : "item" | "submenu" | "separator" | "header"
//   settingsLabel: 설정 아코디언에 보일 이름(동적 라벨이라도 고정 표시명)
//   toggleable  : 우클릭 메뉴에서 On/Off 대상인지 (header/separator 는 false)
//   conditional : "update" | "accounts" | null — 런타임 조건이 충족돼야 노출
//   surfaces    : 이 항목이 등장하는 표면 ["tray","pet"]
//   defaultOn   : 우클릭 메뉴 기본 노출 여부(미지정=true). 예: install=false
//
// 토글은 *우클릭 메뉴(pet)* 에만 적용된다. 트레이는 항상 전체 노출(런타임 조건만).

const MENU_ITEMS = Object.freeze([
  // 버전+시각 헤더. 트레이 정체성용이라 우클릭 메뉴엔 넣지 않고 토글도 불가.
  { id: "header", kind: "header", settingsLabel: "버전 헤더", toggleable: false, conditional: null, surfaces: ["tray"] },
  // 새 버전이 감지됐을 때만(updateInfo) 노출되는 설치 버튼.
  // 우클릭 메뉴에선 기본 off(defaultOn:false) — 평소 잘 안 쓰는 항목이라 사용자가
  // 원할 때만 켠다. 트레이는 토글 무시라 업데이트 감지 시 항상 노출.
  { id: "install", kind: "item", settingsLabel: "업데이트 설치", toggleable: true, conditional: "update", surfaces: ["tray", "pet"], defaultOn: false },
  { id: "sep1", kind: "separator", settingsLabel: "", toggleable: false, conditional: null, surfaces: ["tray", "pet"] },
  { id: "showHide", kind: "item", settingsLabel: "지키미 보이기/숨기기", toggleable: true, conditional: null, surfaces: ["tray", "pet"] },
  { id: "refresh", kind: "item", settingsLabel: "지금 새로고침", toggleable: true, conditional: null, surfaces: ["tray", "pet"] },
  { id: "trayMode", kind: "submenu", settingsLabel: "표시 모드", toggleable: true, conditional: null, surfaces: ["tray", "pet"] },
  // 계정이 1개 이상 등록됐을 때만(trayAccounts) 노출되는 계정 전환 서브메뉴.
  { id: "switchAccount", kind: "submenu", settingsLabel: "계정 전환", toggleable: true, conditional: "accounts", surfaces: ["tray", "pet"] },
  { id: "monthlyUsage", kind: "item", settingsLabel: "월별 API 사용량", toggleable: true, conditional: null, surfaces: ["tray", "pet"] },
  { id: "sep2", kind: "separator", settingsLabel: "", toggleable: false, conditional: null, surfaces: ["tray", "pet"] },
  { id: "settings", kind: "item", settingsLabel: "설정", toggleable: true, conditional: null, surfaces: ["tray", "pet"] },
  { id: "changelog", kind: "item", settingsLabel: "업데이트 일지", toggleable: true, conditional: null, surfaces: ["tray", "pet"] },
  { id: "quit", kind: "item", settingsLabel: "종료", toggleable: true, conditional: null, surfaces: ["tray", "pet"] },
]);

// 우클릭 메뉴가 비면(모든 항목 off 등) 복구 표면이 사라지므로, 최소한 설정은
// 띄울 수 있게 폴백한다.
const PET_FALLBACK_ID = "settings";

// 선행/후행/연속 separator 를 제거한다. 항목을 토글로 걷어내면 구분선만 남거나
// 연달아 뜨는 걸 방지.
function collapseSeparators(items) {
  const out = [];
  for (const it of items) {
    if (it.kind === "separator") {
      if (out.length === 0) continue; // 선행
      if (out[out.length - 1].kind === "separator") continue; // 연속
    }
    out.push(it);
  }
  while (out.length && out[out.length - 1].kind === "separator") out.pop(); // 후행
  return out;
}

// 주어진 표면에 실제로 그릴 항목 descriptor 배열을 순서대로 돌려준다.
//   surface : "tray" | "pet"
//   toggles : { [id]: boolean }  — 없는 id 는 항목 defaultOn(미지정=true) 따름 (pet)
//   ctx     : { hasUpdate, hasAccounts } — 조건부 항목 노출 여부
function selectMenuItems({ surface, toggles = {}, ctx = {} } = {}) {
  const hasUpdate = !!ctx.hasUpdate;
  const hasAccounts = !!ctx.hasAccounts;

  const picked = MENU_ITEMS.filter((it) => {
    if (!it.surfaces.includes(surface)) return false;
    if (it.conditional === "update" && !hasUpdate) return false;
    if (it.conditional === "accounts" && !hasAccounts) return false;
    if (surface === "pet") {
      if (it.kind === "separator") return true; // 일단 유지, 아래서 collapse
      if (!it.toggleable) return false;
      if ((toggles[it.id] ?? (it.defaultOn !== false)) === false) return false;
    }
    return true;
  });

  const collapsed = collapseSeparators(picked);

  if (surface === "pet") {
    const actionable = collapsed.filter((it) => it.kind !== "separator");
    if (actionable.length === 0) {
      return [MENU_ITEMS.find((it) => it.id === PET_FALLBACK_ID)];
    }
  }
  return collapsed;
}

// 설정 아코디언이 그릴 토글 가능 항목 메타데이터. 우클릭 메뉴(pet)에 등장하는
// toggleable 항목만, 메뉴 순서 그대로.
function listToggleableItems() {
  return MENU_ITEMS.filter(
    (it) => it.toggleable && it.surfaces.includes("pet"),
  ).map((it) => ({
    id: it.id,
    settingsLabel: it.settingsLabel,
    conditionalHint: conditionalHint(it.conditional),
    defaultOn: it.defaultOn !== false,
  }));
}

function conditionalHint(conditional) {
  if (conditional === "update") return "업데이트가 있을 때만";
  if (conditional === "accounts") return "계정이 2개 이상일 때만";
  return null;
}

module.exports = {
  MENU_ITEMS,
  selectMenuItems,
  listToggleableItems,
  collapseSeparators,
};
