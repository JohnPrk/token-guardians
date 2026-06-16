// 토큰 지키미 — Electron 메인 프로세스 (MVP).
// 구 Tauri 백엔드(src-tauri/src/lib.rs)의 MVP 표면을 포팅:
//   - 지키미/설정/온보딩 BrowserWindow
//   - 시스템 트레이 + 메뉴
//   - claude.ai usage 30초 폴링 → usage-update 브로드캐스트
//   - 프론트엔드가 호출하는 IPC 커맨드 + 창 간 이벤트 중계
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, screen } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const claudeApi = require("./claudeApi.cjs");
const providers = require("./providers/index.cjs");
const createStore = require("./store.cjs");
const updater = require("./updater.cjs");
const installer = require("./installer.cjs");
const telemetry = require("./telemetry.cjs");
const spaces = require("./spaces.cjs");
const usage = require("./usage.cjs");
const menu = require("./menu.cjs");
const {
  isAuthFailure,
  formatUpdateCheckLabel,
  formatHeaderLabel,
  pickTrayTierForState,
  clampPetPosition,
} = require("./helpers.cjs");

// dock·메뉴바에 보이는 이름은 한글 "토큰 지키미"로. macOS 는 dock/메뉴바에
// CFBundleName(=ASCII "TokenGuardians", helper 경로 lookup 용)을 쓰기 때문에
// 번들의 CFBundleDisplayName("토큰 지키미")만으로는 dock 에 영어가 샌다.
// → 런타임 app 이름으로 override. helper 폴더명은 ASCII 그대로라 v2.24 의
// NFC/NFD SIGTRAP 와 무관하다(현재도 app.name="token-panda"≠helper 폴더명인데
// 정상 동작 → app 이름 변경은 안전).
// 단 userData 는 기존 "token-panda" 경로로 고정해 설정 데이터를 그대로 보존한다.
const USER_DATA_DIR = path.join(app.getPath("appData"), "token-panda");
app.setName("토큰 지키미");
app.setPath("userData", USER_DATA_DIR);

// unpackaged 실행 시 app.getVersion() 은 Electron 버전을 돌려주므로,
// 트레이/로그 표시는 package.json 의 앱 버전을 직접 읽는다 (빌드 신선도 확인용).
const APP_VERSION = require("../package.json").version;

// 단일 인스턴스: 두 번째 실행은 기존 지키미를 띄우고 종료.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const DEV_URL = process.env.TP_DEV_URL || null; // dev 러너가 주입 (없으면 dist 로드)
// 아이콘은 electron-builder buildResources(`build/`) 컨벤션. 패키지 안에선
// process.resourcesPath 하위로 이동하지만, dev 실행에선 working tree 루트의
// build/ 를 그대로 본다.
const RESOURCE_ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
const ICON = path.join(RESOURCE_ROOT, "build", "icon.ico");
const TRAY_ICON = path.join(RESOURCE_ROOT, "build", "tray.png");

let store;
let petWin = null;
let settingsWin = null;
let onboardingWin = null;
let changelogWin = null;
let usageWin = null;
let tray = null;
let quitting = false;

// 업데이트 일지 창에 넘길 컨텍스트. mode="whatsnew" 면 직전 본 버전(sinceVersion)
// 이후 항목만, "full" 이면 전체. 렌더러가 get_changelog_context 로 읽고,
// 창이 살아 있는 동안 다시 열리면 changelog-context 이벤트로 갱신받는다.
let changelogContext = { mode: "full", sinceVersion: null };

let trayMode = "fivehour";
let trayAccounts = [];
let trayActiveId = null;
let lastRemaining = 1; // 마지막 5h 잔량(0-1). 트레이 아이콘 tier 갱신용

// apiConfig 는 활성 계정 한 개의 자격증명 + provider id 묶음.
// 모양 (provider 별로 credentials 만 다름):
//   { provider: "claude", credentials: { orgId, cookie, platformOrgId?, platformCookie? } }
//   { provider: "gemini", credentials: { cookie } }
// `set_api_config` IPC 는 legacy 호출(provider 필드 없는 평탄한 모양) 도
// 받아서 normalizeApiConfig 가 새 모양으로 만들어 준다.
let apiConfig = null;
let latest = null; // ApiUsage
let lastError = null;
let pollTimer = null;
let prepaid = null; // { dollars, fetched_at } | null
let prepaidError = null; // string | null

// ~/.claude/projects/**/*.jsonl 파싱 결과 캐시. pollOnce 마다 갱신.
// active_sessions, 5h/주간 토큰, cache hit/miss/콤보 등 JSONL 유래 필드 출처.
let usageSnap = null;

// 업데이트 체커 (1h 폴링) 상태. updateInfo = 새 버전 있음(없으면 null),
// lastUpdateCheck = 마지막 polling 시각 + 성공 여부 (트레이 헤더 표시용),
// updateAssets = release JSON 의 assets (auto-installer 가 picked asset URL 필요).
let updateInfo = null; // { latest_version, html_url } | null
let updateAssets = []; // [{ name, browser_download_url }]
let lastUpdateCheck = null; // { at: Date, ok: boolean } | null
let updateTimer = null;
let installInProgress = false; // "🆕 설치" 중복 클릭 가드

// 401/403/404 첫 발생 시 1회만 설정창을 띄우는 latch. 다음 성공 시 풀려서
// 재만료 사이클에 다시 한 번만 동작. 없으면 폴러가 30초마다 설정창을 다시
// 띄워서 사용자가 작업을 못함.
let authPopupShown = false;

function pageUrl(page) {
  if (DEV_URL) {
    const base = DEV_URL.endsWith("/") ? DEV_URL : DEV_URL + "/";
    return new URL(page, base).href;
  }
  return pathToFileURL(path.join(__dirname, "..", "dist", page)).href;
}

function webPrefs(label) {
  return {
    preload: path.join(__dirname, "preload.cjs"),
    additionalArguments: ["--tp-label=" + label],
    contextIsolation: true,
    nodeIntegration: false,
  };
}

function createPetWindow() {
  petWin = new BrowserWindow({
    width: 220,
    height: 460,
    x: 100,
    y: 100,
    resizable: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // macOS Sequoia(15.x) 의 Window Tiling 은 focusable 윈도우를 화면 끝으로
    // 가져갈 때 잿빛 "tile hint zone" 미리보기를 그리고 윈도우를 reposition
    // 한다. 지키미는 사용자 키보드 포커스 안 가져오는 보조 윈도우라 focusable:false
    // 로 OS 타일링 대상에서 제외 — clawd-on-desk 와 동일한 패턴. 텍스트 입력은
    // 별도 settings/onboarding BrowserWindow 가 담당해서 영향 없음.
    focusable: false,
    fullscreenable: false,
    // movable:false 로 native drag(-webkit-app-region) 을 끄고 main 이 OS 커서를
    // 폴링해서 setPosition 으로 직접 옮긴다(아래 startPetDrag). native drag 의
    // setFrame: 호출이 macOS 윈도우 관리와 충돌하기도 하고, PointerEvent.screenX/Y
    // 는 윈도우 이동 중 delta 가 어긋날 수 있어 screen.getCursorScreenPoint 가
    // always-authoritative.
    movable: false,
    // enableLargerThanScreen:true 가 빠지면 macOS AppKit 의 constrainFrameRect 가
    // setBounds 마다 윈도우를 NSScreen.visibleFrame 안으로 강제로 끌어들여서
    // 좌측·상단·음수 x 보조 모니터 영역으로 진입이 막힌다 (= "끝으로 가다 튕김").
    // 끄면 우리가 직접 bounds 를 통제해야 하므로 helpers.cjs:clampPetPosition 으로
    // 모든 디스플레이 workArea 합집합 안에 클램프 (drag/move 양쪽에서 호출).
    enableLargerThanScreen: true,
    type: process.platform === "darwin" ? "panel" : undefined,
    // NSPanel + transparent 의 rounded corner mask 가 partial-clip 시 unfilled
    // 영역을 잿빛으로 노출하는 회귀 회피. NSWindow.roundedCorners 기본 true 라
    // 명시적으로 끔. clawd-on-desk 와 동일.
    roundedCorners: false,
    icon: ICON,
    webPreferences: webPrefs("main"),
  });
  // setFocusable(false) 는 BrowserWindow 옵션 focusable:false 와 동등한 macOS
  // NSWindow.canBecomeKey=NO 효과를 한 번 더 보장. Electron 구현체에 따라 옵션
  // 만으로 안 박히는 케이스가 있어 안전망으로 호출 (clawd 패턴).
  petWin.setFocusable(false);
  // alwaysOnTop level "screen-saver" 복원. 1단계 시도(level 낮춤)는 위쪽 진입 자체를
  // 막아 회귀 — 본 원인이 level 이 아닌 collectionBehavior STATIONARY 비트였음
  // (spaces.cjs SET_MASK 에서 제거). level 은 옛 값으로 복원해 다른 앱 위 항상 표시
  // 효과 보존.
  petWin.setAlwaysOnTop(true, "screen-saver");
  // 모든 Space + 스와이프 전환에도 화면 고정(Stationary) 으로 — 메뉴바처럼 데스크탑을
  // 넘겨도 지키미의 x,y 가 안 밀리는 "한 겹 위 레이어" 느낌. Electron 내장
  // setVisibleOnAllWorkspaces 는 CanJoinAllSpaces 만 켜서 전환 때 같이 밀리므로,
  // spaces.cjs 가 koffi FFI 로 NSWindow.collectionBehavior 에 Stationary 까지 박는다.
  // 지키미 윈도우에만 적용 — 설정/온보딩 창은 일반 BrowserWindow 라 포커스 회귀와 무관.
  // sticky 태그는 NSWindow.windowNumber 가 유효(창이 화면에 올라온 뒤)해야 박힌다.
  // 생성 직후엔 0 일 수 있어 lifecycle 시점마다 재시도한다.
  spaces.pinPetToAllSpaces(petWin);
  petWin.once("ready-to-show", () => spaces.pinPetToAllSpaces(petWin));
  petWin.once("show", () => spaces.pinPetToAllSpaces(petWin));
  setTimeout(() => spaces.pinPetToAllSpaces(petWin), 800);

  petWin.loadURL(pageUrl("index.html"));
  petWin.on("closed", () => {
    petWin = null;
  });
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 600,
    height: 680,
    minWidth: 520,
    minHeight: 560,
    resizable: true,
    title: "토큰 지키미 — 설정",
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: webPrefs("settings"),
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadURL(pageUrl("settings.html"));
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
}

function openOnboarding() {
  if (onboardingWin && !onboardingWin.isDestroyed()) {
    onboardingWin.show();
    if (onboardingWin.isMinimized()) onboardingWin.restore();
    onboardingWin.focus();
    return;
  }
  onboardingWin = new BrowserWindow({
    width: 640,
    height: 760,
    minWidth: 540,
    minHeight: 620,
    resizable: true,
    center: true,
    title: "토큰 지키미 — 시작하기",
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: webPrefs("onboarding"),
  });
  onboardingWin.setMenuBarVisibility(false);
  onboardingWin.loadURL(pageUrl("onboarding.html"));
  onboardingWin.on("closed", () => {
    onboardingWin = null;
  });
}

// 업데이트 일지 창. 팝업(mode="whatsnew")과 트레이 메뉴(mode="full")가 같은 창
// 하나를 재사용한다. 이미 떠 있으면 컨텍스트만 갱신해 다시 렌더하도록 이벤트를 쏜다.
function openChangelog(mode, sinceVersion) {
  changelogContext = {
    mode: mode === "whatsnew" ? "whatsnew" : "full",
    sinceVersion: sinceVersion || null,
  };
  if (changelogWin && !changelogWin.isDestroyed()) {
    changelogWin.show();
    if (changelogWin.isMinimized()) changelogWin.restore();
    changelogWin.focus();
    broadcast("changelog-context", changelogContext);
    return;
  }
  changelogWin = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 460,
    minHeight: 420,
    resizable: true,
    center: true,
    title: "토큰 지키미 — 업데이트 일지",
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: webPrefs("changelog"),
  });
  changelogWin.setMenuBarVisibility(false);
  changelogWin.loadURL(pageUrl("changelog.html"));
  changelogWin.on("closed", () => {
    changelogWin = null;
  });
}

// 트레이 "월별 API 사용량" 이 여는 독립 창. 설정 창과 별개로, 활성 계정의 이번
// 달 키별 비용만 보여준다. 창이 열려 MonthlyUsageApp(=MonthlyApiCost)이 마운트될
// 때 fetch_api_key_costs 를 1회 호출한다(폴링 없음).
function openMonthlyUsage() {
  if (usageWin && !usageWin.isDestroyed()) {
    usageWin.show();
    if (usageWin.isMinimized()) usageWin.restore();
    usageWin.focus();
    return;
  }
  usageWin = new BrowserWindow({
    width: 460,
    height: 560,
    minWidth: 380,
    minHeight: 420,
    resizable: true,
    center: true,
    title: "토큰 지키미 — 월별 API 사용량",
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: webPrefs("usage"),
  });
  usageWin.setMenuBarVisibility(false);
  usageWin.loadURL(pageUrl("usage.html"));
  usageWin.on("closed", () => {
    usageWin = null;
  });
}

// 부팅 시 버전 baseline 기록. 옛날엔 새 버전이면 "방금 업데이트됨" 일지 팝업을
// 자동으로 띄웠으나(openChangelog("whatsnew", …)), 사용자 요청으로 자동 팝업은
// 제거 — 업데이트마다 창이 튀어나오는 게 거슬려서. 변경로그는 트레이 "업데이트
// 일지" 메뉴로 언제든 수동 확인 가능. baseline 기록만 남겨 둔다(updater 비교용).
function maybeShowWhatsNew() {
  let lastSeen = null;
  try {
    lastSeen = store.op("get", "config.json", "changelogLastSeenVersion") || null;
  } catch {
    lastSeen = null;
  }
  if (lastSeen !== APP_VERSION) {
    try {
      store.op("set", "config.json", "changelogLastSeenVersion", APP_VERSION);
      store.op("save", "config.json");
    } catch (e) {
      console.warn("[tp] changelog baseline save failed:", e);
    }
  }
}

function broadcast(event, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("tp:event", { event, payload });
  }
}

// 지키미 윈도우 드래그 — main 이 OS 커서(screen.getCursorScreenPoint)를 ~60fps 로
// 폴링해서 setPosition. 종전 PointerEvent.screenX/Y 기반 renderer 드래그를
// 대체. 이유:
//   1) PointerEvent.screenX/Y 는 같은 프레임에 윈도우가 setPosition 으로
//      이동하면 다음 이벤트의 좌표가 새 윈도우 기준으로 다시 계산돼 delta 가
//      어긋난다. OS 커서 좌표는 윈도우 이동과 무관하므로 항상 정확.
//   2) clampPetPosition 으로 매 tick 마다 모든 디스플레이 workArea 합집합
//      안에 가둘 수 있음 — enableLargerThanScreen:true 로 AppKit constrain
//      을 끈 대신 우리가 직접 통제.
// renderer 는 pointerdown 에 start_pet_drag, pointerup 에 end_pet_drag 만 호출.
const PET_DRAG_INTERVAL_MS = 16;
let petDragInterval = null;
let petDragStart = null;

function startPetDrag() {
  if (!petWin || petDragInterval) return;
  const c = screen.getCursorScreenPoint();
  const [wx, wy] = petWin.getPosition();
  petDragStart = { cursorX: c.x, cursorY: c.y, winX: wx, winY: wy };
  petDragInterval = setInterval(() => {
    if (!petWin || petWin.isDestroyed() || !petDragStart) {
      endPetDrag();
      return;
    }
    const cur = screen.getCursorScreenPoint();
    const b = petWin.getBounds();
    const rawX = petDragStart.winX + (cur.x - petDragStart.cursorX);
    const rawY = petDragStart.winY + (cur.y - petDragStart.cursorY);
    const { x, y } = clampPetPosition(
      rawX,
      rawY,
      b.width,
      b.height,
      screen.getAllDisplays(),
    );
    petWin.setPosition(x, y, false);
  }, PET_DRAG_INTERVAL_MS);
}

function endPetDrag() {
  if (petDragInterval) {
    clearInterval(petDragInterval);
    petDragInterval = null;
  }
  petDragStart = null;
}

// usage.snapshot() 한 번 굴려 캐시 갱신. 동기 I/O 라 빠르고, 실패해도 이전
// 캐시 유지 (네트워크 블립 같은 흔들림 없게). JSONL 파일이 없으면 빈 스냅샷.
function pollUsageSnapshot() {
  try {
    usageSnap = usage.snapshot();
  } catch (e) {
    console.error("[usage] snapshot failed:", e && e.message ? e.message : e);
  }
}

function buildSnapshot() {
  const u = usageSnap;
  return {
    five_hour_tokens: u ? u.five_hour_tokens : 0,
    weekly_tokens: u ? u.weekly_tokens : 0,
    last_request_at: u ? u.last_request_at : null,
    last_user_prompt_at: u ? u.last_user_prompt_at : null,
    is_thinking: u ? u.is_thinking : false,
    five_hour_window_start: u ? u.five_hour_window_start : null,
    // claude.ai API 가 살아있으면 그 reset 시각을 우선 (서버 truth). 없으면
    // JSONL anchor 기반 fallback.
    five_hour_resets_at: latest ? latest.five_hour_resets_at : (u ? u.five_hour_resets_at : null),
    weekly_window_start: u ? u.weekly_window_start : null,
    weekly_resets_at: latest ? latest.weekly_resets_at : (u ? u.weekly_resets_at : null),
    cache_hits_5min: u ? u.cache_hits_5min : 0,
    cache_misses_5min: u ? u.cache_misses_5min : 0,
    current_combo: u ? u.current_combo : 0,
    last_cache_hit: u ? u.last_cache_hit : null,
    now: new Date().toISOString(),
    api: latest,
    api_error: lastError,
    prepaid: prepaid,
    prepaid_error: prepaidError,
    active_sessions: u ? u.active_sessions : [],
  };
}

// provider 가 prepaid 를 지원하고(capabilities.prepaid) 자격증명에 platformOrgId
// 가 있을 때만 prepaid 호출. usage 와 분리된 cycle 이라 platform cookie 가
// 따로 있으면 그걸 쓰고, 아니면 claude.ai cookie 재사용 (두 도메인이 같은
// sessionKey 를 공유하는 케이스 대응). gemini 등 prepaid 미지원 provider 는
// 그냥 null 로 둔다.
async function pollPrepaid() {
  if (!apiConfig) {
    prepaid = null;
    prepaidError = null;
    return;
  }
  const provider = providers.resolveProvider(apiConfig.provider);
  if (!provider.capabilities.prepaid || typeof provider.fetchPrepaid !== "function") {
    prepaid = null;
    prepaidError = null;
    return;
  }
  const creds = apiConfig.credentials || {};
  if (!creds.platformOrgId) {
    prepaid = null;
    prepaidError = null;
    return;
  }
  try {
    const dollars = await provider.fetchPrepaid(creds);
    prepaid = { dollars, fetched_at: new Date().toISOString() };
    prepaidError = null;
  } catch (e) {
    prepaid = null;
    prepaidError = e && e.message ? e.message : String(e);
  }
}

// provider 가 폴링 중 회전 토큰을 갱신했을 때 호출되는 콜백 (gemini 전용 사실상).
// (1) in-memory apiConfig 를 새 쿠키로 갱신해 다음 폴이 fresh 쿠키를 쓰게 하고,
// (2) store 의 활성 gemini 계정 cookie 를 write-back 해 재시작 후에도 유지한다.
// store write 실패는 폴링을 막지 않는다(in-memory 갱신은 이미 적용됨).
function persistRefreshedCredentials(refreshed) {
  if (!apiConfig || !refreshed || !refreshed.cookie) return;
  apiConfig.credentials = { ...apiConfig.credentials, cookie: refreshed.cookie };
  try {
    const cfg = store.op("get", "config.json", "accounts_config");
    if (!cfg || !Array.isArray(cfg.accounts) || !cfg.activeAccountId) return;
    let touched = false;
    const accounts = cfg.accounts.map((a) => {
      if (
        a.id === cfg.activeAccountId &&
        a.provider === "gemini" &&
        a.cookie !== refreshed.cookie
      ) {
        touched = true;
        return { ...a, cookie: refreshed.cookie };
      }
      return a;
    });
    if (touched) {
      store.op("set", "config.json", "accounts_config", { ...cfg, accounts });
      store.op("save", "config.json");
    }
  } catch (e) {
    console.error("[tp] gemini 쿠키 store write-back 실패:", e && e.message ? e.message : e);
  }
}

async function pollOnce() {
  // JSONL 파싱은 apiConfig 유무와 무관 — 사용자가 claude.ai 쿠키를 안 넣어도
  // 로컬 ~/.claude/projects 만 있으면 active_sessions / 5h·주간 토큰 / cache
  // hit·miss 가 다 살아남.
  pollUsageSnapshot();
  if (!apiConfig) {
    broadcast("usage-update", buildSnapshot());
    return;
  }
  const provider = providers.resolveProvider(apiConfig.provider);
  try {
    latest = await provider.fetchUsage(apiConfig.credentials, persistRefreshedCredentials);
    lastError = null;
    authPopupShown = false; // 다음 만료 사이클에서 다시 한 번 띄우게 reset
  } catch (err) {
    lastError = err && err.message ? err.message : String(err);
    if (isAuthFailure(lastError) && !authPopupShown) {
      authPopupShown = true;
      openSettings();
    }
  }
  await pollPrepaid();
  broadcast("usage-update", buildSnapshot());
}

function startPoller() {
  if (pollTimer) clearInterval(pollTimer);
  // 첫 폴 즉시 — apiConfig 없을 때도 JSONL 카드가 곧장 뜨게.
  pollUsageSnapshot();
  pollTimer = setInterval(pollOnce, 30000);
}

// GitHub Releases 한 번 조회 → updateInfo + lastUpdateCheck 갱신 → 트레이
// rebuild. 실패해도 기존 updateInfo 는 보존(네트워크 블립으로 "🆕 설치"가
// 사라졌다 다시 나타나지 않게). lastUpdateCheck.ok 만 false 로 바뀌어서 헤더
// 가 "확인 실패 · HH:MM" 으로 표시된다.
async function checkLatestRelease() {
  const r = await updater.fetchLatestRelease(APP_VERSION);
  if (r.ok) {
    updateInfo = r.info; // null 이면 이미 최신
    updateAssets = Array.isArray(r.assets) ? r.assets : [];
  }
  lastUpdateCheck = { at: new Date(), ok: r.ok };
  rebuildTray();
}

// "🆕 설치" 클릭 핸들러 — 진짜 자동설치 흐름. 다운로드 + 백그라운드 스크립트
// 시작 → 현재 앱 즉시 quit. 스크립트가 옛 프로세스 종료 대기 후 설치 + 새
// 앱 실행을 책임진다. 사용자가 본 입장에서는 "메뉴 클릭 → 잠시 뒤 새 버전이
// 떠 있음." 설치 가능한 asset 이 없으면 (Linux 등 또는 자산 누락) Releases
// 페이지를 브라우저로 fallback 으로 연다.
async function handleInstallClick() {
  if (installInProgress) return;
  const asset = installer.pickAssetForPlatform(updateAssets, process.platform);
  if (!asset) {
    if (updateInfo && updateInfo.html_url) shell.openExternal(updateInfo.html_url);
    return;
  }
  installInProgress = true;
  try {
    await installer.downloadAndStartInstall(asset, {});
    quitting = true;
    app.quit();
  } catch (e) {
    console.error("[tp] auto-install failed:", e);
    installInProgress = false;
    if (updateInfo && updateInfo.html_url) shell.openExternal(updateInfo.html_url);
  }
}

// 업데이트 체크 옆에서 익명 텔레메트리 핑을 한 발(fire-and-forget). sendPing 은
// 절대 throw 하지 않지만, 프라미스 거부 경고 방지로 .catch 만 달아둔다. 엔드포인트
// 미설정/ opt-out 이면 내부에서 no-op.
function sendTelemetryPing() {
  telemetry
    .sendPing(store, { version: APP_VERSION, os: process.platform })
    .catch(() => {});
}

// 부팅 3초 후 + 1시간 주기. anonymous GitHub API 가 60 req/hr 이라 1회/hr 면 안전.
// 텔레메트리 핑도 같은 주기에 묶어 보낸다(업데이트 체크와는 별개 요청).
function startUpdateChecker() {
  setTimeout(() => {
    checkLatestRelease().catch((e) => console.warn("[tp] update check failed:", e));
    sendTelemetryPing();
  }, 3000);
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = setInterval(() => {
    checkLatestRelease().catch((e) => console.warn("[tp] update check failed:", e));
    sendTelemetryPing();
  }, 60 * 60 * 1000);
}

// 트레이 메뉴와 캐릭터 우클릭 컨텍스트 메뉴가 공유하는 항목 빌더. 항목 목록·순서·
// 토글/조건부 필터는 menu.cjs(순수)가 정하고, 여기선 각 id 의 라벨+클릭 핸들러만
// 부착한다. 새 메뉴 항목은 menu.cjs:MENU_ITEMS 와 아래 menuItemTemplate 두 곳만
// 손대면 트레이·우클릭 양쪽에 함께 반영된다. opts.toggles 는 우클릭(pet) surface 에서만 쓰임.
function buildMenuTemplate(surface, opts = {}) {
  const ctx = { hasUpdate: !!updateInfo, hasAccounts: trayAccounts.length > 0 };
  const items = menu.selectMenuItems({ surface, toggles: opts.toggles || {}, ctx });
  return items.map((it) => menuItemTemplate(it.id)).filter(Boolean);
}

// id → Electron MenuItem 템플릿. 핸들러는 기존 모듈 상태/함수 클로저를 그대로 쓴다.
function menuItemTemplate(id) {
  switch (id) {
    case "header":
      // 헤더 한 줄에 버전 + 마지막 폴링 시각 통합 (v1.98): "토큰 지키미 v1.97.0 (03:18 확인)".
      return { label: formatHeaderLabel(APP_VERSION, lastUpdateCheck), enabled: false };
    case "install":
      // 새 버전이 감지되면(updateInfo) "🆕 v.. 설치" 버튼 하나 (중간 "있음" 라인 폐기,
      // 헤더 시각이 폴링 확인 신호를 이미 줌).
      return {
        label: installInProgress
          ? `🆕 v${updateInfo.latest_version} 설치 중…`
          : `🆕 v${updateInfo.latest_version} 설치`,
        enabled: !installInProgress,
        click: () => handleInstallClick(),
      };
    case "sep1":
    case "sep2":
      return { type: "separator" };
    case "showHide":
      return {
        label: "지키미 보이기/숨기기",
        click: () => {
          if (!petWin) return;
          if (petWin.isVisible()) petWin.hide();
          else {
            petWin.show();
            petWin.focus();
          }
        },
      };
    case "refresh":
      // usage 30s poller cycle + 1h release checker cycle 둘 다 즉시 한 번
      // 더 돌려서, 사용자가 "지금 새로고침" 누르면 트레이 헤더 timestamp 가
      // 갱신되는 게 시각적 신호로 동작한다 (v1.51 회귀).
      return {
        label: "지금 새로고침 ↻",
        click: () => {
          pollOnce();
          checkLatestRelease().catch((e) => console.warn("[tp] update check failed:", e));
        },
      };
    case "trayMode":
      return {
        label: "표시 모드",
        submenu: [
          { label: "5시간", type: "radio", checked: trayMode === "fivehour", click: () => broadcast("tray-set-mode", "fivehour") },
          { label: "5시간 + 주간", type: "radio", checked: trayMode === "both", click: () => broadcast("tray-set-mode", "both") },
          { label: "5시간 + 주간 + $", type: "radio", checked: trayMode === "all", click: () => broadcast("tray-set-mode", "all") },
        ],
      };
    case "switchAccount":
      return {
        label: "계정 전환",
        submenu: trayAccounts.map((a) => ({
          label: a.label,
          type: "radio",
          checked: a.id === trayActiveId,
          click: () => broadcast("tray-switch-account", a.id),
        })),
      };
    case "monthlyUsage":
      return { label: "월별 API 사용량", click: () => openMonthlyUsage() };
    case "settings":
      return { label: "설정...", click: () => openSettings() };
    case "changelog":
      return { label: "업데이트 일지", click: () => openChangelog("full", null) };
    case "quit":
      return { label: "종료", click: () => { quitting = true; app.quit(); } };
    default:
      return null;
  }
}

function rebuildTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate("tray")));
}

// tier PNG 는 원본 컬러(녹색 잎/갈색 줄기) 그대로 노출. setTemplateImage 를
// 걸면 알파만 남고 흑백 실루엣이 되어 사용자 의도("원래대로")와 어긋남.
function trayImage(p) {
  return nativeImage.createFromPath(p);
}

// 기본 트레이 아이콘(build/tray.png, 없으면 앱 아이콘). 5h 모드 외에선
// 트레이 아이콘을 비우니 startup 시 createTray 초기값으로만 잠깐 쓰인다.
function defaultTrayImage() {
  const img = trayImage(TRAY_ICON);
  return img.isEmpty() ? trayImage(ICON) : img;
}

// tier 결정은 helpers.cjs:pickTrayTierForState 가 담당 (platform/mode/잔량 → tier|null).
// null 이면 아이콘 비움(메뉴바 텍스트만 노출, macOS non-fivehour 모드).
// 그 외(macOS fivehour, Windows 모든 모드)는 build/tray/tray-<tier>.png 사용.
function applyTrayIcon() {
  if (!tray) return;
  const tier = pickTrayTierForState(process.platform, trayMode, lastRemaining);
  if (tier == null) {
    tray.setImage(nativeImage.createEmpty());
    return;
  }
  const img = trayImage(path.join(RESOURCE_ROOT, "build", "tray", `tray-${tier}.png`));
  tray.setImage(img.isEmpty() ? defaultTrayImage() : img);
}

function createTray() {
  const init = defaultTrayImage();
  tray = new Tray(init.isEmpty() ? nativeImage.createEmpty() : init);
  tray.setToolTip("토큰 지키미");
  tray.on("click", () => tray.popUpContextMenu());
  applyTrayIcon();
  rebuildTray();
}

// IPC `set_api_config` / `test_api_config` 의 인자 normalize. App.tsx 가
// 새 모양({provider, credentials}) 으로 보내든, 옛 평탄한 모양({orgId, cookie,
// platformOrgId, platformCookie}) 으로 보내든 모두 받아 동일한 내부 표현
// `{provider, credentials}` 으로 변환한다. orgId/cookie 같은 평탄한 키가
// 보이면 무조건 claude, 그 외에 a.provider="gemini" 면 gemini.
function normalizeApiConfig(a) {
  const trim = (v) => (v != null ? String(v).trim() : "");
  const providerId =
    a.provider === "gemini"
      ? "gemini"
      : a.provider === "codex"
        ? "codex"
        : "claude";
  if (providerId === "codex") {
    // codex 는 자격증명이 없다 — 로컬 ~/.codex/sessions 로그만 읽으므로 항상
    // 유효한 normalized 를 돌려준다(credentials 빈 객체).
    return { provider: "codex", credentials: {} };
  }
  if (providerId === "gemini") {
    // gemini: credentials = { cookie }
    const c = a.credentials || a;
    const cookie = trim(c.cookie);
    if (!cookie) return null;
    return { provider: "gemini", credentials: { cookie } };
  }
  // claude: credentials = { orgId, cookie, platformOrgId?, platformCookie? }
  const c = a.credentials || a;
  const orgId = trim(c.orgId);
  const cookie = trim(c.cookie);
  if (!orgId || !cookie) return null;
  const platformOrgId = trim(c.platformOrgId);
  const platformCookie = trim(c.platformCookie);
  return {
    provider: "claude",
    credentials: {
      orgId,
      cookie,
      platformOrgId: platformOrgId || null,
      platformCookie: platformCookie || null,
    },
  };
}

async function handleCommand(cmd, a) {
  a = a || {};
  switch (cmd) {
    case "get_usage_snapshot":
      return buildSnapshot();
    case "set_api_config": {
      const normalized = normalizeApiConfig(a);
      if (normalized) {
        apiConfig = normalized;
      } else {
        apiConfig = null;
        latest = null;
        lastError = null;
        prepaid = null;
        prepaidError = null;
      }
      return null;
    }
    case "test_api_config": {
      const normalized = normalizeApiConfig(a);
      if (!normalized) {
        throw new Error("자격증명이 비어 있습니다 (orgId/cookie 또는 gemini cookie).");
      }
      const provider = providers.resolveProvider(normalized.provider);
      const u = await provider.fetchUsage(normalized.credentials);
      // prepaid 지원 provider 면 같이 시도 — 한 줄에 "usage X% · prepaid $.." 또는
      // "prepaid err: .." 로 wizard 에 표시되게.
      let prepaid_dollars = null;
      let prepaid_error = null;
      if (
        provider.capabilities.prepaid &&
        typeof provider.fetchPrepaid === "function" &&
        normalized.credentials.platformOrgId
      ) {
        try {
          prepaid_dollars = await provider.fetchPrepaid(normalized.credentials);
        } catch (e) {
          prepaid_error = e && e.message ? e.message : String(e);
        }
      }
      return { ...u, prepaid_dollars, prepaid_error };
    }
    case "fetch_api_key_costs": {
      // 설정 창이 열릴 때 1회 호출 (폴링 아님). 활성 계정 기준. prepaid 와 달리
      // platformOrgId 가 없어도 provider 가 공유 쿠키로 API 조직을 자동 발견하므로
      // 여기선 provider 지원 여부만 게이팅한다. 그 외엔 available:false + reason/
      // error 로 UI 가 안내 문구를 띄운다.
      if (!apiConfig) return { available: false, reason: "no_account" };
      const provider = providers.resolveProvider(apiConfig.provider);
      if (
        !provider.capabilities.apiKeyCosts ||
        typeof provider.fetchApiKeyCosts !== "function"
      ) {
        return { available: false, reason: "unsupported" };
      }
      try {
        const result = await provider.fetchApiKeyCosts(apiConfig.credentials || {});
        return { available: true, ...result };
      } catch (e) {
        return { available: false, error: e && e.message ? e.message : String(e) };
      }
    }
    case "refresh_usage":
      await pollOnce();
      return null;
    case "open_settings_window":
      openSettings();
      return null;
    case "open_onboarding_window":
      openOnboarding();
      return null;
    case "open_changelog_window":
      openChangelog("full", null);
      return null;
    case "get_changelog_context":
      return changelogContext;
    case "open_claude_usage_in_browser":
      await shell.openExternal("https://claude.ai/settings/usage");
      return null;
    case "open_gemini_usage_in_browser":
      await shell.openExternal("https://gemini.google.com/usage");
      return null;
    case "open_claude_platform_in_browser":
      // 설정창 "API 자동" 버튼: platform.claude.com(Claude API 콘솔)을 연다.
      // claude.ai 와 별도 쿠키 컨텍스트라 여기서 쿠키를 받아야 prepaid/비용을 읽는다.
      await shell.openExternal("https://platform.claude.com/settings/billing");
      return null;
    case "auto_extract_from_cookie": {
      // provider 인식형. a.provider 가 비어 있거나 claude 면 옛 동작
      // (claude.ai org_id 추출). gemini 는 autoExtract 미지원 (capability=false)
      // 이라 throw — App.tsx 가 사용자에게 "쿠키 직접 입력" 만 시킨다.
      const providerId = a.provider === "gemini" ? "gemini" : "claude";
      const provider = providers.resolveProvider(providerId);
      if (!provider.capabilities.autoExtract || typeof provider.autoExtract !== "function") {
        throw new Error(`${provider.displayName} provider 는 쿠키 자동 추출을 지원하지 않습니다.`);
      }
      const r = await provider.autoExtract(a.rawCookie);
      // 옛 frontend 와의 호환: { org_id, cookie } snake_case 평탄 모양으로
      // 돌려줌 (claude provider 의 r.legacy 에 그 모양이 들어 있음).
      return r.legacy || r.credentials;
    }
    case "discover_platform_org": {
      // 설정창 "API 자동" 버튼: 붙여넣은 platform.claude.com 쿠키로 API(콘솔)
      // 조직 uuid 를 발견해 돌려준다. platform 은 Claude 전용 개념이라 claude
      // provider 로 고정. 못 찾으면 org_id:null, 네트워크 오류는 throw → UI 가
      // "쿠키는 가져왔지만 org 자동발견 실패" 로 안내한다.
      const provider = providers.resolveProvider("claude");
      if (typeof provider.discoverPlatformOrg !== "function") {
        throw new Error("이 provider 는 platform 조직 자동 발견을 지원하지 않습니다.");
      }
      const orgId = await provider.discoverPlatformOrg(a.cookie);
      return { org_id: orgId || null };
    }
    case "set_tray_title": {
      // 프론트가 formatTrayLabel 로 계산한 5h%/주간%/$ 라벨. macOS 는 setTitle 로
      // 메뉴바 아이콘 옆에 *상시* 표시(옛 Tauri 동작). setToolTip 만 쓰면 hover 시에만
      // 보여서 라이브 표시가 안 된다. setTitle 은 macOS 전용이라 가드.
      const t = a.title ? String(a.title).trim() : "";
      if (tray) {
        if (process.platform === "darwin") tray.setTitle(t);
        tray.setToolTip(`토큰 지키미  ${t}`.trim());
      }
      return null;
    }
    case "set_tray_icon_for_remaining":
      if (typeof a.remaining === "number" && Number.isFinite(a.remaining)) {
        lastRemaining = a.remaining;
      }
      applyTrayIcon();
      return null;
    case "set_active_skin":
      return null;
    case "update_tray_accounts":
      trayAccounts = Array.isArray(a.accounts) ? a.accounts : [];
      trayActiveId = a.activeId != null ? a.activeId : null;
      rebuildTray();
      return null;
    case "update_tray_mode":
      trayMode = a.mode || "fivehour";
      applyTrayIcon();
      rebuildTray();
      return null;
    case "resize_pet_window":
      if (petWin && a.width && a.height) {
        petWin.setSize(Math.round(a.width), Math.round(a.height));
      }
      return null;
    case "start_pet_drag":
      // OS 커서 polling 기반 main 주도 드래그 시작 — drag 중엔 renderer 가
      // pointer 이벤트를 안 흘려도 OK (screen.getCursorScreenPoint 가 진실).
      startPetDrag();
      return null;
    case "end_pet_drag":
      endPetDrag();
      return null;
    case "move_pet_window":
      // 외부 좌표 지정 이동 경로 — 드래그가 아닌 키보드/복구/테스트 호출용.
      // clampPetPosition 으로 화면 밖 영구 분실을 방지.
      if (petWin && typeof a.x === "number" && typeof a.y === "number") {
        const b = petWin.getBounds();
        const { x, y } = clampPetPosition(
          a.x,
          a.y,
          b.width,
          b.height,
          screen.getAllDisplays(),
        );
        petWin.setPosition(x, y, false);
      }
      return null;
    case "get_pet_position":
      if (petWin) {
        const [x, y] = petWin.getPosition();
        return { x, y };
      }
      return null;
    case "toggle_main_window":
      if (petWin) {
        if (petWin.isVisible()) petWin.hide();
        else {
          petWin.show();
          petWin.focus();
        }
      }
      return null;
    case "focus_for_input":
      if (petWin) {
        petWin.show();
        petWin.focus();
      }
      return null;
    case "settings_focus":
      return null;
    case "claude_projects_path":
      return null;
    case "show_pet_context_menu": {
      // 캐릭터 우클릭 → 트레이와 동일 항목의 네이티브 메뉴를 펫 윈도우 위에 띄운다.
      // 표시 항목은 사용자가 설정에서 끈 토글(a.toggles)로 필터된다(pet surface).
      if (!petWin) return null;
      const template = buildMenuTemplate("pet", { toggles: (a && a.toggles) || {} });
      Menu.buildFromTemplate(template).popup({ window: petWin });
      return null;
    }
    case "get_menu_items":
      // 설정 아코디언이 그릴 토글 가능 항목 메타데이터(우클릭 메뉴 전용).
      return menu.listToggleableItems();
    default:
      console.warn("[tp] unknown command:", cmd);
      return null;
  }
}

function registerIpc() {
  ipcMain.handle("tp:invoke", (_e, cmd, args) => handleCommand(cmd, args));
  ipcMain.handle("tp:emit", (_e, event, payload) => {
    broadcast(event, payload);
    return null;
  });
  ipcMain.handle("tp:win", (e, action) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isDestroyed()) return null;
    if (action === "close") w.close();
    else if (action === "show") w.show();
    else if (action === "hide") w.hide();
    else if (action === "focus") w.focus();
    else if (action === "unminimize") w.restore();
    return null;
  });
  ipcMain.handle("tp:store", (_e, op, file, key, val) => store.op(op, file, key, val));
}

app.on("second-instance", () => {
  if (petWin) {
    petWin.show();
    petWin.focus();
  }
});

// 트레이 앱이므로 모든 창이 닫혀도 종료하지 않는다 (명시적 "종료"만).
// 구독만 해두면 Electron 의 자동 quit 이 비활성화되고, quitting 플래그가
// 설정된 경우(트레이 "종료")에만 실제로 종료한다.
app.on("window-all-closed", () => {
  if (quitting) app.quit();
});

app.whenReady().then(() => {
  // macOS: Dock 아이콘 + Cmd+Tab 항목 제거 (accessory mode). 트레이 전용 앱이라
  // Dock 에 떠 있을 이유가 없고, 구 Tauri 빌드의 `set_macos_accessory_app` 가
  // 하던 역할을 그대로 재현.
  if (process.platform === "darwin" && app.dock) app.dock.hide();

  store = createStore(app);
  registerIpc();
  createTray();
  createPetWindow();
  startPoller();
  startUpdateChecker();
  // 지키미가 먼저 뜬 뒤 잠깐 있다가 "방금 업데이트됨" 일지 팝업 (있을 때만).
  setTimeout(() => {
    try {
      maybeShowWhatsNew();
    } catch (e) {
      console.warn("[tp] whats-new popup failed:", e);
    }
  }, 1500);
  console.log(
    `[tp] ready v${APP_VERSION} | mode=${DEV_URL ? "dev(" + DEV_URL + ")" : "prod(dist)"} | userData=${app.getPath("userData")}`,
  );
});
