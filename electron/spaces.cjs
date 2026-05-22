// macOS 전용: 펫 윈도우를 "모든 Space + 스와이프 전환에도 화면 고정" 으로.
//
// 메뉴바처럼 데스크탑을 좌우로 넘겨도 펫의 x,y 가 안 밀리는 "한 겹 위 레이어" 느낌.
// 핵심 메커니즘은 옛 Tauri 빌드(token-panda src-tauri/src/lib.rs)의 검증된 방식 그대로:
//
//   1) SkyLight 로 *별도 private Space* 를 만들고(SLSSpaceCreate) absolute level 100
//      (= 유저의 좌우 Mission Control 스와이프 Space 집합 밖, 그 위)으로 올린다.
//   2) 그 Space 를 항상 표시(SLSShowSpaces)하고, 펫 윈도우를 그 Space 로 이동
//      (SLSSpaceAddWindowsAndRemoveFromSpaces, 기존 Space 멤버십 7 비트 제거).
//   3) 보조로 NSWindow.collectionBehavior(Stationary|...) + level 1500.
//
// collectionBehavior 의 Stationary 비트만으로는 스와이프 슬라이드가 안 막힌다(실측).
// 진짜로 막는 건 (1)(2) 의 private elevated Space. 옛 Tauri 빌드는 NSPanel 클래스
// 스왑(convert_to_panel_once)으로 Stage Manager 관리에서도 제외됐지만, koffi 로 같은
// 스왑을 하면 Electron 의 NSWindow 서브클래스와 충돌해 AppKit 이 크래시한다(실측).
// 그래서 Stage Manager 의 화면-밖 재배치(좌측 드래그 튕김)는 NSPanel 대신 main.cjs
// move_pet_window 의 bounds clamp 로 막는다.
//
// 네이티브 컴파일 addon 대신 koffi(prebuilt, Electron 호환) FFI 로 objc + SkyLight
// 런타임을 직접 호출 → CI 에 node-gyp/electron-rebuild 단계 불필요.

// NSWindowCollectionBehavior 비트 (NSWindow.h) — 옛 코드의 clear/set 마스크 그대로
const CB = {
  CAN_JOIN_ALL_SPACES: 1 << 0,
  MOVE_TO_ACTIVE_SPACE: 1 << 1,
  MANAGED: 1 << 2,
  TRANSIENT: 1 << 3,
  STATIONARY: 1 << 4,
  PARTICIPATES_IN_CYCLE: 1 << 5,
  IGNORES_CYCLE: 1 << 6,
  FULLSCREEN_PRIMARY: 1 << 7,
  FULLSCREEN_AUXILIARY: 1 << 8,
  FULLSCREEN_NONE: 1 << 9,
  FULLSCREEN_ALLOWS_TILING: 1 << 11,
  FULLSCREEN_DISALLOWS_TILING: 1 << 12,
  PRIMARY: 1 << 16,
  AUXILIARY: 1 << 17,
  CAN_JOIN_ALL_APPS: 1 << 18,
};
// CAN_JOIN_ALL_SPACES 는 *clear* 한다. 윈도우는 아래 SkyLight private Space(level
// 100, 항상 표시)에만 두는데, CanJoinAllSpaces 가 켜져 있으면 WindowServer 가 그
// 윈도우를 모든 유저 Space 에도 미러링해 private Space 배치와 충돌 → 다른 데스크탑에
// 중복(잔상) 판다가 생긴다. 빼면 private Space 한 곳에만 살아 단일 고정본만 남는다.
const CLEAR_MASK =
  CB.CAN_JOIN_ALL_SPACES | CB.MOVE_TO_ACTIVE_SPACE | CB.MANAGED | CB.TRANSIENT |
  CB.PARTICIPATES_IN_CYCLE | CB.FULLSCREEN_PRIMARY | CB.FULLSCREEN_NONE |
  CB.FULLSCREEN_ALLOWS_TILING | CB.PRIMARY | CB.AUXILIARY | CB.CAN_JOIN_ALL_APPS;
// 옛 Tauri 빌드(SET_MASK) 와 동일. STATIONARY 는 스와이프 고정용. 좌측 드래그 튕김의
// 본 원인은 collectionBehavior 가 아니라 macOS Stage Manager 의 화면-밖 윈도우
// 재배치였고, main.cjs move_pet_window 의 bounds clamp 로 해소(거기 주석 참고).
const SET_MASK =
  CB.STATIONARY | CB.FULLSCREEN_AUXILIARY | CB.IGNORES_CYCLE | CB.FULLSCREEN_DISALLOWS_TILING;

// 펫 윈도우 level — main.cjs 의 setAlwaysOnTop(true, "screen-saver") 가 이미
// Electron 내부적으로 NSScreenSaverWindowLevel(=1000) 로 매핑. 옛 코드에서
// 추가로 CGAssistiveTechHighWindowLevel(1500) 까지 올렸던 이유는 "위쪽 진입
// 차단 회피"였으나, 그 의도는 이제 enableLargerThanScreen:true + helpers.cjs
// clampPetPosition 이 직접 담당해서 중복. setLevel:1500 은 macOS WindowServer
// 가 high-level 윈도우를 "always-visible system UI" 로 간주해 partial-exit 시
// shadow/backing 잔재(잿빛 사각형) + 강제 reposition(중간으로 튕김) 의 두
// 부수효과를 일으키는 가설이라 폐기. clawd-on-desk 와 동일 level(1000) 로 통일.
// SkyLight private-space pinning + collectionBehavior STATIONARY 는 그대로 유지
// — 모든 Space 고정(v1.95)은 그 두 메커니즘이 담당하고 level 과 무관.
const ANIM_NONE = 2; // NSWindowAnimationBehaviorNone

let loaded = false;
let koffi = null;
let getClass = null;
let selReg = null;
let msgSend = null;
let sls = null; // { conn, space, ShowSpaces, AddWindows }

function ensureLoaded() {
  if (loaded) return koffi != null;
  loaded = true;
  try {
    koffi = require("koffi");
    const objc = koffi.load("/usr/lib/libobjc.A.dylib");
    getClass = objc.func("void* objc_getClass(const char* name)");
    selReg = objc.func("void* sel_registerName(const char* name)");
    // 단일 프로토타입(self, sel, unsigned long). 포인터 인자가 필요한 호출
    // (arrayWithObject:)은 koffi.address() 로 포인터를 정수 주소로 바꿔 넘긴다
    // — arm64 레지스터 ABI 상 포인터/정수 모두 같은 레지스터(x2)라 동일하다.
    msgSend = objc.func("void* objc_msgSend(void* self, void* op, unsigned long arg)");

    const sky = koffi.load("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight");
    const SLSMainConnectionID = sky.func("int SLSMainConnectionID(void)");
    const SLSSpaceCreate = sky.func("int SLSSpaceCreate(int cid, int a, int b)");
    const SLSSpaceSetAbsoluteLevel = sky.func("int SLSSpaceSetAbsoluteLevel(int cid, int space, int level)");
    const SLSShowSpaces = sky.func("int SLSShowSpaces(int cid, void* spaces)");
    const SLSSpaceAddWindowsAndRemoveFromSpaces =
      sky.func("int SLSSpaceAddWindowsAndRemoveFromSpaces(int cid, int space, void* windows, int mask)");

    const conn = SLSMainConnectionID();
    const space = SLSSpaceCreate(conn, 1, 0);
    if (!space) {
      console.warn("[tp] spaces: SLSSpaceCreate 실패, Space 고정 비활성");
      koffi = null;
      return false;
    }
    // absolute level 100 → 유저 좌우 스와이프 Space 집합 밖(위).
    SLSSpaceSetAbsoluteLevel(conn, space, 100);
    const arr = nsNumberArray(space);
    if (arr) SLSShowSpaces(conn, arr);

    sls = { conn, space, ShowSpaces: SLSShowSpaces, AddWindows: SLSSpaceAddWindowsAndRemoveFromSpaces };
    return true;
  } catch (e) {
    console.warn("[tp] spaces: FFI 로드 실패, Space 고정 비활성 —", e && e.message);
    koffi = null;
    return false;
  }
}

// [NSArray arrayWithObject:[NSNumber numberWithInt: value]] → koffi 포인터
function nsNumberArray(value) {
  const num = msgSend(getClass("NSNumber"), selReg("numberWithInt:"), value >>> 0);
  if (!num) return null;
  const arr = msgSend(getClass("NSArray"), selReg("arrayWithObject:"), koffi.address(num));
  return arr || null;
}

function nsWindowOf(win) {
  const view = koffi.decode(win.getNativeWindowHandle(), "void *");
  return msgSend(view, selReg("window"), 0);
}

// 펫 윈도우를 모든 Space + private elevated Space 로 고정. 실패해도 조용히 무시.
// windowNumber 가 0(창이 아직 화면에 안 올라옴)이면 false 반환 → 호출부가
// lifecycle 시점마다 재시도한다.
function pinPetToAllSpaces(win) {
  if (process.platform !== "darwin") return false;
  if (!win || win.isDestroyed()) return false;
  if (!ensureLoaded()) return false;
  try {
    const w = nsWindowOf(win);
    if (!w) return false;

    // collectionBehavior: 옛 코드와 동일하게 clear 후 set.
    const current = Number(koffi.address(msgSend(w, selReg("collectionBehavior"), 0)));
    const next = (current & ~CLEAR_MASK) | SET_MASK;
    if (next !== current) msgSend(w, selReg("setCollectionBehavior:"), next >>> 0);
    msgSend(w, selReg("setCanHide:"), 0);
    msgSend(w, selReg("setHidesOnDeactivate:"), 0);
    // setLevel: 호출 폐기 — main.cjs 의 setAlwaysOnTop("screen-saver") 가 박은
    // NSScreenSaverWindowLevel(1000) 그대로 둠. (위 주석 참고)
    msgSend(w, selReg("setAnimationBehavior:"), ANIM_NONE);

    // private Space 로 윈도우 이동 (기존 Space 멤버십 7 비트 제거) + 재표시
    const wid = Number(koffi.address(msgSend(w, selReg("windowNumber"), 0)));
    if (!wid || wid <= 0) return false;
    const warr = nsNumberArray(wid);
    if (!warr) return false;
    sls.AddWindows(sls.conn, sls.space, warr, 7);
    const sarr = nsNumberArray(sls.space);
    if (sarr) sls.ShowSpaces(sls.conn, sarr);

    console.log(`[tp] spaces: pinned wid=${wid} → space=${sls.space} (conn=${sls.conn})`);
    return true;
  } catch (e) {
    console.warn("[tp] spaces: 핀닝 실패 —", e && e.message);
    return false;
  }
}

module.exports = { pinPetToAllSpaces };
