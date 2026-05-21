// 토큰 판다 — Electron 메인 프로세스 (MVP).
// 구 Tauri 백엔드(src-tauri/src/lib.rs)의 MVP 표면을 포팅:
//   - 펫/설정/온보딩 BrowserWindow
//   - 시스템 트레이 + 메뉴
//   - claude.ai usage 30초 폴링 → usage-update 브로드캐스트
//   - 프론트엔드가 호출하는 IPC 커맨드 + 창 간 이벤트 중계
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const claudeApi = require("./claudeApi.cjs");
const createStore = require("./store.cjs");
const updater = require("./updater.cjs");
const installer = require("./installer.cjs");
const spaces = require("./spaces.cjs");
const { isAuthFailure, formatUpdateCheckLabel, formatHeaderLabel, bambooTierForRemaining } = require("./helpers.cjs");

app.setName("token-panda");

// unpackaged 실행 시 app.getVersion() 은 Electron 버전을 돌려주므로,
// 트레이/로그 표시는 package.json 의 앱 버전을 직접 읽는다 (빌드 신선도 확인용).
const APP_VERSION = require("../package.json").version;

// 단일 인스턴스: 두 번째 실행은 기존 펫을 띄우고 종료.
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
let tray = null;
let quitting = false;

let trayMode = "fivehour";
let trayAccounts = [];
let trayActiveId = null;
let lastRemaining = 1; // 마지막 5h 잔량(0-1). 트레이 아이콘 tier 갱신용

let apiConfig = null; // { orgId, cookie, platformOrgId, platformCookie }
let latest = null; // ApiUsage
let lastError = null;
let pollTimer = null;
let prepaid = null; // { dollars, fetched_at } | null
let prepaidError = null; // string | null

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
    fullscreenable: false,
    icon: ICON,
    webPreferences: webPrefs("main"),
  });
  petWin.setAlwaysOnTop(true, "screen-saver");
  // 모든 Space + 스와이프 전환에도 화면 고정(Stationary) 으로 — 메뉴바처럼 데스크탑을
  // 넘겨도 펫의 x,y 가 안 밀리는 "한 겹 위 레이어" 느낌. Electron 내장
  // setVisibleOnAllWorkspaces 는 CanJoinAllSpaces 만 켜서 전환 때 같이 밀리므로,
  // spaces.cjs 가 koffi FFI 로 NSWindow.collectionBehavior 에 Stationary 까지 박는다.
  // 펫 윈도우에만 적용 — 설정/온보딩 창은 일반 BrowserWindow 라 포커스 회귀와 무관.
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
    title: "토큰 판다 — 설정",
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
    title: "토큰 판다 — 시작하기",
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

function broadcast(event, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("tp:event", { event, payload });
  }
}

function buildSnapshot() {
  return {
    five_hour_tokens: 0,
    weekly_tokens: 0,
    last_request_at: null,
    last_user_prompt_at: null,
    is_thinking: false,
    five_hour_window_start: null,
    five_hour_resets_at: latest ? latest.five_hour_resets_at : null,
    weekly_window_start: null,
    weekly_resets_at: latest ? latest.weekly_resets_at : null,
    cache_hits_5min: 0,
    cache_misses_5min: 0,
    current_combo: 0,
    last_cache_hit: null,
    now: new Date().toISOString(),
    api: latest,
    api_error: lastError,
    prepaid: prepaid,
    prepaid_error: prepaidError,
    active_sessions: [],
  };
}

// platformOrgId 가 설정돼 있을 때만 prepaid 호출. usage 와 분리된 cycle 이라
// platform cookie 가 따로 있으면 그걸 쓰고, 아니면 claude.ai cookie 재사용
// (두 도메인이 같은 sessionKey 를 공유하는 케이스 대응).
async function pollPrepaid() {
  if (!apiConfig || !apiConfig.platformOrgId) {
    prepaid = null;
    prepaidError = null;
    return;
  }
  const ck = apiConfig.platformCookie || apiConfig.cookie;
  try {
    const dollars = await claudeApi.fetchPrepaid(apiConfig.platformOrgId, ck);
    prepaid = { dollars, fetched_at: new Date().toISOString() };
    prepaidError = null;
  } catch (e) {
    prepaid = null;
    prepaidError = e && e.message ? e.message : String(e);
  }
}

async function pollOnce() {
  if (!apiConfig) {
    broadcast("usage-update", buildSnapshot());
    return;
  }
  try {
    latest = await claudeApi.fetchUsage(apiConfig.orgId, apiConfig.cookie);
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

// 부팅 3초 후 + 1시간 주기. anonymous GitHub API 가 60 req/hr 이라 1회/hr 면 안전.
function startUpdateChecker() {
  setTimeout(() => {
    checkLatestRelease().catch((e) => console.warn("[tp] update check failed:", e));
  }, 3000);
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = setInterval(() => {
    checkLatestRelease().catch((e) => console.warn("[tp] update check failed:", e));
  }, 60 * 60 * 1000);
}

function rebuildTray() {
  if (!tray) return;
  // 헤더 한 줄에 버전 + 마지막 폴링 시각 통합 (v1.98): "토큰 판다 v1.97.0 (03:18 확인)".
  // 평시엔 이 한 줄 + 메뉴 항목들만. 새 버전이 감지되면 헤더 바로 아래에
  // "🆕 v.. 설치" 버튼 하나만 붙음 (중간 "있음" 라인 폐기 — 헤더의 시각이 폴링
  // 동작 확인 신호를 이미 줌).
  const template = [
    { label: formatHeaderLabel(APP_VERSION, lastUpdateCheck), enabled: false },
  ];
  if (updateInfo) {
    template.push({
      label: installInProgress
        ? `🆕 v${updateInfo.latest_version} 설치 중…`
        : `🆕 v${updateInfo.latest_version} 설치`,
      enabled: !installInProgress,
      click: () => handleInstallClick(),
    });
  }
  template.push(
    { type: "separator" },
    {
      label: "펫 보이기/숨기기",
      click: () => {
        if (!petWin) return;
        if (petWin.isVisible()) petWin.hide();
        else {
          petWin.show();
          petWin.focus();
        }
      },
    },
    {
      // usage 30s poller cycle + 1h release checker cycle 둘 다 즉시 한 번
      // 더 돌려서, 사용자가 "지금 새로고침" 누르면 트레이 헤더 timestamp 가
      // 갱신되는 게 시각적 신호로 동작한다 (v1.51 회귀).
      label: "지금 새로고침 ↻",
      click: () => {
        pollOnce();
        checkLatestRelease().catch((e) => console.warn("[tp] update check failed:", e));
      },
    },
    {
      label: "표시 모드",
      submenu: [
        { label: "5시간", type: "radio", checked: trayMode === "fivehour", click: () => broadcast("tray-set-mode", "fivehour") },
        { label: "5시간 + 주간", type: "radio", checked: trayMode === "both", click: () => broadcast("tray-set-mode", "both") },
        { label: "5시간 + 주간 + $", type: "radio", checked: trayMode === "all", click: () => broadcast("tray-set-mode", "all") },
      ],
    },
  );

  if (trayAccounts.length > 0) {
    template.push({
      label: "계정 전환",
      submenu: trayAccounts.map((a) => ({
        label: a.label,
        type: "radio",
        checked: a.id === trayActiveId,
        click: () => broadcast("tray-switch-account", a.id),
      })),
    });
  }

  template.push(
    { type: "separator" },
    { label: "설정...", click: () => openSettings() },
    { label: "종료", click: () => { quitting = true; app.quit(); } },
  );

  tray.setContextMenu(Menu.buildFromTemplate(template));
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

// 5h 모드일 때만 잔량별 컬러 대나무(build/tray/tray-<tier>.png, 4→1 줄기) 노출.
// 그 외(5h+주간, 5h+주간+$) 모드에선 사용자 요청대로 아이콘 자체를 빼고
// 텍스트 라벨만 메뉴바에 남김 (nativeImage.createEmpty()).
function applyTrayIcon() {
  if (!tray) return;
  if (trayMode === "fivehour") {
    const tier = bambooTierForRemaining(lastRemaining);
    const img = trayImage(path.join(RESOURCE_ROOT, "build", "tray", `tray-${tier}.png`));
    tray.setImage(img.isEmpty() ? defaultTrayImage() : img);
  } else {
    tray.setImage(nativeImage.createEmpty());
  }
}

function createTray() {
  const init = defaultTrayImage();
  tray = new Tray(init.isEmpty() ? nativeImage.createEmpty() : init);
  tray.setToolTip("토큰 판다");
  tray.on("click", () => tray.popUpContextMenu());
  applyTrayIcon();
  rebuildTray();
}

async function handleCommand(cmd, a) {
  a = a || {};
  switch (cmd) {
    case "get_usage_snapshot":
      return buildSnapshot();
    case "set_api_config": {
      const { orgId, cookie, platformOrgId, platformCookie } = a;
      if (orgId && cookie && String(orgId).trim() && String(cookie).trim()) {
        apiConfig = {
          orgId: String(orgId).trim(),
          cookie: String(cookie).trim(),
          platformOrgId: platformOrgId ? String(platformOrgId).trim() : null,
          platformCookie: platformCookie ? String(platformCookie).trim() : null,
        };
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
      const u = await claudeApi.fetchUsage(a.orgId, a.cookie); // 실패 시 throw
      // platformOrgId 가 주어지면 prepaid 도 같이 시도 — 한 줄에 "usage X% ·
      // prepaid $.." 또는 "prepaid err: .." 로 wizard 에 표시되게.
      let prepaid_dollars = null;
      let prepaid_error = null;
      if (a.platformOrgId && String(a.platformOrgId).trim()) {
        try {
          prepaid_dollars = await claudeApi.fetchPrepaid(
            String(a.platformOrgId).trim(),
            String(a.platformCookie || a.cookie || "").trim(),
          );
        } catch (e) {
          prepaid_error = e && e.message ? e.message : String(e);
        }
      }
      return { ...u, prepaid_dollars, prepaid_error };
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
    case "open_claude_usage_in_browser":
      await shell.openExternal("https://claude.ai/settings/usage");
      return null;
    case "auto_extract_from_cookie":
      return await claudeApi.autoExtract(a.rawCookie);
    case "set_tray_title": {
      // 프론트가 formatTrayLabel 로 계산한 5h%/주간%/$ 라벨. macOS 는 setTitle 로
      // 메뉴바 아이콘 옆에 *상시* 표시(옛 Tauri 동작). setToolTip 만 쓰면 hover 시에만
      // 보여서 라이브 표시가 안 된다. setTitle 은 macOS 전용이라 가드.
      const t = a.title ? String(a.title).trim() : "";
      if (tray) {
        if (process.platform === "darwin") tray.setTitle(t);
        tray.setToolTip(`토큰 판다  ${t}`.trim());
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
  console.log(
    `[tp] ready v${APP_VERSION} | mode=${DEV_URL ? "dev(" + DEV_URL + ")" : "prod(dist)"} | userData=${app.getPath("userData")}`,
  );
});
