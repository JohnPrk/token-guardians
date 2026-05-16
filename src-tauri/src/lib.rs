mod claude_api;
mod login_capture;
mod updater;
mod usage;

use claude_api::{ApiUsage, PrepaidCredits};
use login_capture::{build_cookie_header, extract_org_id_from_orgs_json, has_required_cookies};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use notify_debouncer_mini::new_debouncer;
use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::menu::{IsMenuItem, Menu, MenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};

#[cfg(target_os = "macos")]
fn set_macos_accessory_app() {
    use objc2::class;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    unsafe {
        let cls = class!(NSApplication);
        let app: *mut AnyObject = msg_send![cls, sharedApplication];
        // NSApplicationActivationPolicyAccessory = 1
        // No Dock icon, no Cmd-Tab entry. macOS no longer manages our
        // window with the regular Space mechanics, which is the only
        // configuration where the 'stationary' collection behavior is
        // honored reliably.
        // -[NSApplication setActivationPolicy:] returns BOOL. objc2 ≥0.5의
        // 런타임 타입 검증이 () 반환을 거부하면서 panic("expected B, found v")
        // 으로 부팅 자체가 막히던 회귀. 명시적으로 bool로 받음.
        let _: bool = msg_send![app, setActivationPolicy: 1i64];
    }
}

#[cfg(not(target_os = "macos"))]
fn set_macos_accessory_app() {}

#[cfg(target_os = "macos")]
mod macos_pinning {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use std::os::raw::{c_int, c_void};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use tauri::WebviewWindow;

    // True while the Settings panel is open. While true, apply() must NOT
    // re-set the window level back to ASSISTIVE_LEVEL — that would refreeze
    // WebKit text input under the user mid-typing. The 1.5s pinning tick
    // and Focused/Resized/Moved events both call apply(), so without this
    // gate the input field appears blocked.
    static SETTINGS_OPEN: AtomicBool = AtomicBool::new(false);

    pub fn set_settings_open(open: bool) {
        SETTINGS_OPEN.store(open, Ordering::SeqCst);
    }

    pub fn is_settings_open() -> bool {
        SETTINGS_OPEN.load(Ordering::SeqCst)
    }

    // NSWindowCollectionBehavior bits (NSWindow.h)
    const CB_CAN_JOIN_ALL_SPACES: u64 = 1 << 0;
    const CB_MOVE_TO_ACTIVE_SPACE: u64 = 1 << 1;
    const CB_MANAGED: u64 = 1 << 2;
    const CB_TRANSIENT: u64 = 1 << 3;
    const CB_STATIONARY: u64 = 1 << 4;
    const CB_PARTICIPATES_IN_CYCLE: u64 = 1 << 5;
    const CB_IGNORES_CYCLE: u64 = 1 << 6;
    const CB_FULLSCREEN_PRIMARY: u64 = 1 << 7;
    const CB_FULLSCREEN_AUXILIARY: u64 = 1 << 8;
    const CB_FULLSCREEN_NONE: u64 = 1 << 9;
    const CB_FULLSCREEN_ALLOWS_TILING: u64 = 1 << 11;
    const CB_FULLSCREEN_DISALLOWS_TILING: u64 = 1 << 12;
    const CB_PRIMARY: u64 = 1 << 16;
    const CB_AUXILIARY: u64 = 1 << 17;
    const CB_CAN_JOIN_ALL_APPS: u64 = 1 << 18;

    // Window level used by clawd: CGAssistiveTechHighWindowLevel = 1500.
    // Far above NSStatusWindowLevel (25), survives Mission Control overlays.
    const ASSISTIVE_LEVEL: i64 = 1500;
    // NSWindowAnimationBehaviorNone = 2.
    const ANIM_NONE: i64 = 2;

    type SLSMainConnectionID = unsafe extern "C" fn() -> c_int;
    type SLSSpaceCreate = unsafe extern "C" fn(c_int, c_int, c_int) -> c_int;
    type SLSSpaceSetAbsoluteLevel = unsafe extern "C" fn(c_int, c_int, c_int) -> c_int;
    type SLSShowSpaces = unsafe extern "C" fn(c_int, *const c_void) -> c_int;
    type SLSSpaceAddWindowsAndRemoveFromSpaces =
        unsafe extern "C" fn(c_int, c_int, *const c_void, c_int) -> c_int;

    struct SkyLight {
        _lib: libloading::Library,
        connection: c_int,
        space: c_int,
        add_windows_fn: SLSSpaceAddWindowsAndRemoveFromSpaces,
        show_spaces_fn: SLSShowSpaces,
    }

    fn skylight() -> Option<&'static SkyLight> {
        static CELL: OnceLock<Option<SkyLight>> = OnceLock::new();
        CELL.get_or_init(|| unsafe {
            let lib = libloading::Library::new(
                "/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/SkyLight",
            ).ok()?;

            let main_conn: libloading::Symbol<SLSMainConnectionID> =
                lib.get(b"SLSMainConnectionID\0").ok()?;
            let space_create: libloading::Symbol<SLSSpaceCreate> =
                lib.get(b"SLSSpaceCreate\0").ok()?;
            let space_abs_level: libloading::Symbol<SLSSpaceSetAbsoluteLevel> =
                lib.get(b"SLSSpaceSetAbsoluteLevel\0").ok()?;
            let show_spaces: libloading::Symbol<SLSShowSpaces> =
                lib.get(b"SLSShowSpaces\0").ok()?;
            let add_windows: libloading::Symbol<SLSSpaceAddWindowsAndRemoveFromSpaces> =
                lib.get(b"SLSSpaceAddWindowsAndRemoveFromSpaces\0").ok()?;

            let connection = main_conn();
            let space = space_create(connection, 1, 0);
            if space == 0 {
                return None;
            }
            // Absolute level 100 puts this Space outside the user's
            // left/right Mission Control swipe animation entirely.
            space_abs_level(connection, space, 100);

            // SLSShowSpaces wants an NSArray of NSNumber. Build via objc.
            if let Some(arr) = ns_number_array(space) {
                show_spaces(connection, arr);
            }

            let add_windows_fn: SLSSpaceAddWindowsAndRemoveFromSpaces = *add_windows;
            let show_spaces_fn: SLSShowSpaces = *show_spaces;
            Some(SkyLight {
                _lib: lib,
                connection,
                space,
                add_windows_fn,
                show_spaces_fn,
            })
        }).as_ref()
    }

    fn ns_number_array(value: c_int) -> Option<*const c_void> {
        use objc2::class;
        unsafe {
            let cls_num = class!(NSNumber);
            let cls_arr = class!(NSArray);
            let num: *mut AnyObject = msg_send![cls_num, numberWithInt: value];
            if num.is_null() {
                return None;
            }
            let arr: *mut AnyObject = msg_send![cls_arr, arrayWithObject: num];
            if arr.is_null() {
                return None;
            }
            Some(arr as *const c_void)
        }
    }

    fn delegate_window_to_stationary_space(ns_window: *mut AnyObject) -> bool {
        let Some(sl) = skylight() else { return false };
        unsafe {
            let window_number: i64 = msg_send![ns_window, windowNumber];
            if window_number == 0 {
                return false;
            }
            let Some(arr) = ns_number_array(window_number as c_int) else {
                return false;
            };
            // Last arg `7` matches clawd's call: bitmask for which existing
            // Space memberships to remove the window from.
            let _ = (sl.add_windows_fn)(sl.connection, sl.space, arr, 7);
            true
        }
    }

    // NSWindowStyleMaskNonactivatingPanel = 1 << 7 — kept here as a
    // reference. NOT applied: empirically, even with Settings'
    // focus_for_input dance, Apple's WebKit text input stays frozen on
    // a panel that was created with this mask. Trade-off accepted: the
    // very first click on an inactive window activates the app instead
    // of starting a drag, but settings text inputs always work.
    #[allow(dead_code)]
    const STYLE_NONACTIVATING_PANEL: u64 = 1 << 7;

    extern "C" {
        fn object_setClass(obj: *mut c_void, cls: *const c_void) -> *const c_void;
    }

    fn convert_to_panel_once(ns_window: *mut AnyObject) {
        use objc2::class;
        use std::sync::atomic::{AtomicBool, Ordering};
        static DONE: AtomicBool = AtomicBool::new(false);
        if DONE.swap(true, Ordering::SeqCst) {
            return;
        }
        unsafe {
            // Class-swap NSWindow → NSPanel. NSPanel inherits from NSWindow,
            // so the vtable stays compatible.
            let panel_cls = class!(NSPanel);
            let _ = object_setClass(
                ns_window as *mut c_void,
                panel_cls as *const _ as *const c_void,
            );
            // setBecomesKeyOnlyIfNeeded:false so any click that needs the
            // window for input promotes us to key window immediately.
            let _: () = msg_send![ns_window, setBecomesKeyOnlyIfNeeded: false];
        }
    }

    pub fn apply(window: &WebviewWindow) {
        let Ok(ptr) = window.ns_window() else { return };
        let ns_window = ptr as *mut AnyObject;
        if ns_window.is_null() {
            return;
        }

        // 1) NSPanel conversion (idempotent, runs once).
        convert_to_panel_once(ns_window);

        unsafe {
            // 2) Collection behavior — explicit clear + set so stale bits
            //    don't leave the window participating in Spaces management.
            let current: u64 = msg_send![ns_window, collectionBehavior];
            let clear_mask = CB_MOVE_TO_ACTIVE_SPACE
                | CB_MANAGED
                | CB_TRANSIENT
                | CB_PARTICIPATES_IN_CYCLE
                | CB_FULLSCREEN_PRIMARY
                | CB_FULLSCREEN_NONE
                | CB_FULLSCREEN_ALLOWS_TILING
                | CB_PRIMARY
                | CB_AUXILIARY
                | CB_CAN_JOIN_ALL_APPS;
            let set_mask = CB_CAN_JOIN_ALL_SPACES
                | CB_STATIONARY
                | CB_FULLSCREEN_AUXILIARY
                | CB_IGNORES_CYCLE
                | CB_FULLSCREEN_DISALLOWS_TILING;
            let next = (current & !clear_mask) | set_mask;
            if next != current {
                let _: () = msg_send![ns_window, setCollectionBehavior: next];
            }

            let _: () = msg_send![ns_window, setCanHide: false];
            let _: () = msg_send![ns_window, setHidesOnDeactivate: false];
            // Skip while Settings is open: the panel is intentionally at
            // NSFloatingWindowLevel (3) so its text inputs accept keys.
            // settings_focus() restores ASSISTIVE_LEVEL on close.
            if !is_settings_open() {
                let _: () = msg_send![ns_window, setLevel: ASSISTIVE_LEVEL];
            }
            let _: () = msg_send![ns_window, setAnimationBehavior: ANIM_NONE];
        }

        // 3) SkyLight: re-add the window to our private system Space and
        //    re-issue SLSShowSpaces. The re-show fixes the case where a
        //    different app's overlay (image viewer, fullscreen, etc.)
        //    occludes our private Space.
        delegate_window_to_stationary_space(ns_window);
        if let Some(sl) = skylight() {
            if let Some(arr) = ns_number_array(sl.space) {
                unsafe { let _ = (sl.show_spaces_fn)(sl.connection, arr); }
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn set_macos_panel_behavior(window: &WebviewWindow) {
    macos_pinning::apply(window);
}

#[cfg(not(target_os = "macos"))]
fn set_macos_panel_behavior(_window: &WebviewWindow) {}

struct WatcherState {
    _debouncer: Mutex<Option<Box<dyn std::any::Any + Send>>>,
}

#[derive(Default)]
struct ApiState {
    config: Mutex<Option<(String, String)>>, // (org_id, cookie)
    latest: Mutex<Option<ApiUsage>>,
    last_error: Mutex<Option<String>>,
    /// platform.claude.com prepaid 잔액. usage 호출과 같은 poller cycle에서
    /// 별 호출로 채워진다. 둘은 독립적이라 하나가 실패해도 다른 쪽은 살린다.
    prepaid: Mutex<Option<PrepaidCredits>>,
    prepaid_error: Mutex<Option<String>>,
}

fn api_state() -> &'static ApiState {
    static CELL: OnceLock<ApiState> = OnceLock::new();
    CELL.get_or_init(ApiState::default)
}

#[derive(serde::Serialize, Clone)]
struct CombinedSnapshot {
    #[serde(flatten)]
    inner: usage::UsageSnapshot,
    api: Option<ApiUsage>,
    api_error: Option<String>,
    prepaid: Option<PrepaidCredits>,
    prepaid_error: Option<String>,
}

fn build_combined_snapshot() -> CombinedSnapshot {
    let inner = usage::snapshot();
    let api = api_state().latest.lock().clone();
    let api_error = api_state().last_error.lock().clone();
    let prepaid = api_state().prepaid.lock().clone();
    let prepaid_error = api_state().prepaid_error.lock().clone();
    CombinedSnapshot {
        inner,
        api,
        api_error,
        prepaid,
        prepaid_error,
    }
}

#[tauri::command]
fn get_usage_snapshot() -> CombinedSnapshot {
    build_combined_snapshot()
}

#[tauri::command]
fn set_api_config(org_id: Option<String>, cookie: Option<String>) -> Result<(), String> {
    let pair = match (org_id, cookie) {
        (Some(o), Some(c)) if !o.trim().is_empty() && !c.trim().is_empty() => {
            Some((o.trim().to_string(), c.trim().to_string()))
        }
        _ => None,
    };
    *api_state().config.lock() = pair;
    if api_state().config.lock().is_none() {
        *api_state().latest.lock() = None;
        *api_state().last_error.lock() = None;
        *api_state().prepaid.lock() = None;
        *api_state().prepaid_error.lock() = None;
    }
    Ok(())
}

#[tauri::command]
fn test_api_config(org_id: String, cookie: String) -> Result<ApiUsage, String> {
    claude_api::fetch_usage(&org_id, &cookie)
}

/// While Settings is open, drop the panel from
/// CGAssistiveTechHighWindowLevel (1500) down to NSFloatingWindowLevel
/// (3) so WebKit text inputs accept keystrokes. macOS silently freezes
/// text input on windows above the screen-saver level. Restored on
/// close.
#[tauri::command]
fn settings_focus(app: AppHandle, open: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    #[cfg(target_os = "macos")]
    {
        use objc2::class;
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        const NS_FLOATING_WINDOW_LEVEL: i64 = 3;
        const ASSISTIVE_LEVEL: i64 = 1500;

        // Flip the flag BEFORE touching the level. The 1.5s pinning tick
        // and focus events read this flag inside macos_pinning::apply();
        // setting it first guarantees no interleaved tick re-elevates the
        // window mid-typing.
        macos_pinning::set_settings_open(open);

        if let Ok(ptr) = window.ns_window() {
            let ns_window = ptr as *mut AnyObject;
            if !ns_window.is_null() {
                unsafe {
                    let level = if open {
                        NS_FLOATING_WINDOW_LEVEL
                    } else {
                        ASSISTIVE_LEVEL
                    };
                    let _: () = msg_send![ns_window, setLevel: level];
                    if open {
                        let nsapp_cls = class!(NSApplication);
                        let nsapp: *mut AnyObject =
                            msg_send![nsapp_cls, sharedApplication];
                        // BOOL 반환. 위 setActivationPolicy 케이스와 같은 이유로 bool 명시.
                        let _: bool = msg_send![nsapp, activateIgnoringOtherApps: true];
                        let nil: *const AnyObject = std::ptr::null();
                        let _: () = msg_send![ns_window, makeKeyAndOrderFront: nil];
                    }
                }
            }
        }
    }
    let _ = open;
    Ok(())
}

/// Manual refresh — invoked when the user double-clicks the panda.
/// Re-reads the local jsonl snapshot synchronously and (if an API
/// config is set) kicks off a background API fetch. A `usage-update`
/// event is emitted on completion of either path so the UI re-renders.
#[tauri::command]
fn refresh_usage(app: AppHandle) -> Result<(), String> {
    emit_snapshot(&app);
    let cfg = api_state().config.lock().clone();
    if let Some((org, cookie)) = cfg {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            match claude_api::fetch_usage(&org, &cookie) {
                Ok(api) => {
                    *api_state().latest.lock() = Some(api);
                    *api_state().last_error.lock() = None;
                    AUTH_POPUP_SHOWN.store(false, Ordering::SeqCst);
                    emit_snapshot(&app_clone);
                }
                Err(e) => {
                    let err_for_popup = e.clone();
                    *api_state().last_error.lock() = Some(e);
                    emit_snapshot(&app_clone);
                    maybe_popup_settings_for_auth(&app_clone, &err_for_popup);
                }
            }
            fetch_and_store_prepaid(&org, &cookie);
            emit_snapshot(&app_clone);
        });
    }
    Ok(())
}

/// usage 호출과 같은 자격증명으로 prepaid 잔액을 호출해 글로벌 state에 저장한다.
/// usage 와 별개라 실패해도 usage 값에는 영향 없음. 호출처가 emit_snapshot을
/// 책임지므로 여기서는 emit 안 함.
fn fetch_and_store_prepaid(org: &str, cookie: &str) {
    match claude_api::fetch_prepaid_credits(org, cookie) {
        Ok(dollars) => {
            *api_state().prepaid.lock() = Some(PrepaidCredits {
                dollars,
                fetched_at: chrono::Utc::now(),
            });
            *api_state().prepaid_error.lock() = None;
        }
        Err(e) => {
            *api_state().prepaid_error.lock() = Some(e);
        }
    }
}

#[tauri::command]
fn claude_projects_path() -> Option<PathBuf> {
    usage::claude_projects_dir()
}

#[tauri::command]
fn set_tray_title(app: AppHandle, title: String) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_title(Some(title)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_active_skin(_skin_id: String) -> Result<(), String> {
    // 트레이 아이콘이 제거되면서 skin별 트레이 PNG 분기도 사라졌다. 호출
    // 호환성을 위해 시그니처는 보존하되 본체는 no-op.
    Ok(())
}

#[tauri::command]
fn set_tray_icon_for_remaining(_app: AppHandle, _remaining: f64) -> Result<(), String> {
    // 트레이 아이콘 제거됨. 호출 호환성 유지를 위해 시그니처는 보존.
    Ok(())
}

/// 윈도우 height 변경 시 새 윈도우의 bottom 이 이전 bottom 과 같아지도록 새 top y 를
/// 계산. 펫 발끝 화면 위치를 유지하기 위한 anchoring 식. 모든 단위는 physical px.
pub fn compute_anchored_y(cur_y: i32, cur_height: u32, new_height: u32) -> i32 {
    cur_y + (cur_height as i32 - new_height as i32)
}

/// 펫 윈도우 height(과 width)을 실제 콘텐츠 크기에 맞춰 줄여서 OS hit-test 가
/// 잡을 빈 영역 자체를 없앤다. 카드 stack 이 0~5장 변동에 따라 윈도우 위쪽이
/// 늘었다 줄었다 하지만 발끝 화면 위치(window bottom)는 유지.
/// frontend ResizeObserver 가 logical px 로 보내고, 여기서 scale_factor 로
/// physical 환산해 set_size + set_position 한 트랜잭션.
#[tauri::command]
fn resize_pet_window(app: AppHandle, width: u32, height: u32) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let cur_pos = window.outer_position().map_err(|e| e.to_string())?;
    let cur_size = window.outer_size().map_err(|e| e.to_string())?;
    let new_w = ((width as f64) * scale).round() as u32;
    let new_h = ((height as f64) * scale).round() as u32;
    let new_y = compute_anchored_y(cur_pos.y, cur_size.height, new_h);
    window
        .set_size(tauri::PhysicalSize::new(new_w, new_h))
        .map_err(|e| e.to_string())?;
    window
        .set_position(tauri::PhysicalPosition::new(cur_pos.x, new_y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Force the main window into key+active state so WebKit text inputs (like
/// the org id / cookie fields in Settings) actually receive paste and
/// keystrokes. Called from JS whenever Settings opens.
#[tauri::command]
fn focus_for_input(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let _ = window.show();
    let _ = window.set_focus();

    #[cfg(target_os = "macos")]
    {
        use objc2::class;
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        unsafe {
            let nsapp_cls = class!(NSApplication);
            let nsapp: *mut AnyObject = msg_send![nsapp_cls, sharedApplication];
            // 'true' here is fine for our accessory app — there's no Dock
            // icon to flash and we want keyboard input to flow.
            // BOOL 반환. objc2 런타임 검증 통과를 위해 bool 명시.
            let _: bool = msg_send![nsapp, activateIgnoringOtherApps: true];

            if let Ok(ptr) = window.ns_window() {
                let ns_window = ptr as *mut AnyObject;
                if !ns_window.is_null() {
                    let nil: *const AnyObject = std::ptr::null();
                    let _: () = msg_send![ns_window, makeKeyAndOrderFront: nil];
                }
            }
        }
    }
    Ok(())
}


/// Open the standalone Settings window. The pet itself is a borderless
/// NSPanel pinned at CGAssistiveTechHighWindowLevel — WebKit silently
/// freezes text input on windows above the screen-saver level, so all
/// keyed input (org id, cookie) lives in this separate, ordinary window
/// instead. Reuses the existing window if it's already open.
#[tauri::command]
fn open_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("settings") {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = WebviewUrl::App("index.html?view=settings".into());
    // Bumped from 440×620 to 600×680 — at the narrower size the
    // "API 연동" link and the "🔔 어떻게 연결되나요?" chip wrapped onto
    // two lines and clipped the cookie-flow diagram inside the help
    // popup. 600 wide gives both sub-elements room without scrolling.
    let builder = WebviewWindowBuilder::new(&app, "settings", url)
        .title("토큰 판다 — 설정")
        .inner_size(600.0, 680.0)
        .min_inner_size(520.0, 560.0)
        .resizable(true)
        .decorations(true)
        .transparent(false)
        .always_on_top(false)
        .skip_taskbar(false)
        .visible(true);

    let window = builder.build().map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

/// Open the standalone Onboarding window — first-launch welcome that
/// walks the user through choosing a character + entering Org ID and
/// session cookie. Same separate-WebviewWindow pattern as Settings so
/// text inputs aren't blocked by the pet panel's window level. Bigger
/// canvas than settings (560×720) so the welcome copy + step-by-step
/// instructions can breathe.
#[tauri::command]
fn open_onboarding_window(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("onboarding") {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = WebviewUrl::App("index.html?view=onboarding".into());
    let builder = WebviewWindowBuilder::new(&app, "onboarding", url)
        .title("토큰 판다 — 시작하기")
        .inner_size(640.0, 760.0)
        .min_inner_size(540.0, 620.0)
        .resizable(true)
        .decorations(true)
        .transparent(false)
        .always_on_top(false)
        .skip_taskbar(false)
        .center()
        .visible(true);

    let window = builder.build().map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

/// (I') paste 흐름의 1단계: 시스템 기본 브라우저로 claude.ai/settings/usage 를
/// 띄운다. 사용자가 거기서 Network 탭의 cookie 헤더 한 줄을 복사해 wizard로
/// 돌아와 paste 하면 auto_extract_from_cookie 가 받아 처리한다.
///
/// 임베디드 WebView 방식(v1.27 initial)은 claude.ai 가 인증을 magic link로만
/// 발송 + 그 링크가 시스템 기본 브라우저에서 열리기 때문에 본질적으로 작동
/// 안 함이 확인돼 폐기. 시스템 브라우저 + paste 방식으로 전환.
#[tauri::command]
fn open_claude_usage_in_browser() -> Result<(), String> {
    let url = "https://claude.ai/settings/usage";

    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).status();

    // Windows에서 URL은 `cmd /C start "" "<url>"` 형태로 띄운다. `start`는
    // cmd 빌트인이라 PATH에 없고, 첫 따옴표 인자는 윈도우 제목 자리이므로
    // 비워두지 않으면 URL이 제목으로 해석돼 브라우저가 안 뜨는 케이스가 있다.
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .status();

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let result = std::process::Command::new("xdg-open").arg(url).status();

    let status = result.map_err(|e| format!("브라우저 열기 명령 실행 실패: {}", e))?;
    if !status.success() {
        return Err(format!("브라우저 열기 명령이 비정상 종료: {}", status));
    }
    Ok(())
}

#[derive(serde::Serialize, Clone)]
struct AutoExtractResult {
    org_id: String,
    cookie: String,
}

/// (I') paste 흐름의 2단계: 사용자가 paste한 raw Cookie 헤더 한 줄을 받아
/// 5종만 추리고, 그 쿠키로 /api/organizations 를 호출해 org_id 를 추출한다.
/// 성공 시 정리된 cookie 헤더 + org_id 를 반환해 wizard 폼에 자동 채움.
#[tauri::command]
fn auto_extract_from_cookie(raw_cookie: String) -> Result<AutoExtractResult, String> {
    let pairs = login_capture::parse_raw_cookie_header(&raw_cookie);
    if !has_required_cookies(&pairs) {
        return Err("sessionKey 쿠키가 보이지 않아요. claude.ai의 cookie 헤더 한 줄을 통째로 붙여넣어 주세요.".into());
    }
    let cookie_header = build_cookie_header(&pairs);

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP 클라이언트 생성 실패: {}", e))?;

    let resp = client
        .get("https://claude.ai/api/organizations")
        .header("Cookie", &cookie_header)
        .header("Accept", "*/*")
        .header("Referer", "https://claude.ai/")
        .header("anthropic-client-platform", "web_claude_ai")
        .header("anthropic-client-version", "1.0.0")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        )
        .send()
        .map_err(|e| format!("/api/organizations 요청 실패: {}", e))?;

    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("/api/organizations HTTP {}", status));
    }

    let org_id = extract_org_id_from_orgs_json(&body)
        .ok_or_else(|| "organizations 응답에서 org_id를 추출하지 못했어요".to_string())?;

    Ok(AutoExtractResult {
        org_id,
        cookie: cookie_header,
    })
}

#[tauri::command]
fn toggle_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e| e.to_string())?;
        } else {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn emit_snapshot(app: &AppHandle) {
    let combined = build_combined_snapshot();
    let _ = app.emit("usage-update", &combined);
}

/// True if the error string from claude_api::fetch_usage looks like an
/// expired-cookie / wrong-org scenario the user has to fix in Settings.
/// 401 = unauthorized, 403 = blocked (often Cloudflare on a stale
/// session), 404 = org id no longer resolves with this cookie.
fn is_auth_failure(err: &str) -> bool {
    err.contains("HTTP 401") || err.contains("HTTP 403") || err.contains("HTTP 404")
}

/// One-shot latch: pop Settings open the first time we hit an auth
/// failure, then stay quiet until the next successful fetch resets it.
/// Without the latch the poller would re-open Settings every 30s.
static AUTH_POPUP_SHOWN: AtomicBool = AtomicBool::new(false);

fn maybe_popup_settings_for_auth(app: &AppHandle, err: &str) {
    if !is_auth_failure(err) {
        return;
    }
    if AUTH_POPUP_SHOWN.swap(true, Ordering::SeqCst) {
        return;
    }
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = open_settings_window(app_clone);
    });
}

fn start_api_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        let cfg = api_state().config.lock().clone();
        if let Some((org, cookie)) = cfg {
            match claude_api::fetch_usage(&org, &cookie) {
                Ok(api) => {
                    *api_state().latest.lock() = Some(api);
                    *api_state().last_error.lock() = None;
                    AUTH_POPUP_SHOWN.store(false, Ordering::SeqCst);
                    emit_snapshot(&app);
                }
                Err(e) => {
                    let err_for_popup = e.clone();
                    *api_state().last_error.lock() = Some(e);
                    emit_snapshot(&app);
                    maybe_popup_settings_for_auth(&app, &err_for_popup);
                }
            }
            fetch_and_store_prepaid(&org, &cookie);
            emit_snapshot(&app);
        }
        std::thread::sleep(Duration::from_secs(30));
    });
}

fn start_watcher(app: AppHandle) -> Arc<WatcherState> {
    let state = Arc::new(WatcherState {
        _debouncer: Mutex::new(None),
    });

    let Some(root) = usage::claude_projects_dir() else {
        log::warn!("~/.claude/projects not found — watcher idle");
        return state;
    };

    let app_for_events = app.clone();
    let mut debouncer = match new_debouncer(
        Duration::from_millis(500),
        move |res: notify_debouncer_mini::DebounceEventResult| match res {
            Ok(_events) => emit_snapshot(&app_for_events),
            Err(e) => log::error!("watch error: {:?}", e),
        },
    ) {
        Ok(d) => d,
        Err(e) => {
            log::error!("failed to create debouncer: {:?}", e);
            return state;
        }
    };

    if let Err(e) = debouncer
        .watcher()
        .watch(&root, notify::RecursiveMode::Recursive)
    {
        log::error!("failed to watch {:?}: {:?}", root, e);
        return state;
    }

    *state._debouncer.lock() = Some(Box::new(debouncer));

    let app_for_tick = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        emit_snapshot(&app_for_tick);
        loop {
            std::thread::sleep(Duration::from_secs(15));
            emit_snapshot(&app_for_tick);
        }
    });

    state
}

#[derive(Clone, serde::Deserialize)]
struct AccountMeta {
    id: String,
    label: String,
}

// 백그라운드 update_checker 스레드가 1시간 주기로 채우는 글로벌. 트레이 메뉴
// 빌더(build_menu)가 이걸 읽어 헤더 라벨에 인라인 마커 + "🆕 설치" 메뉴 아이템을
// conditional하게 끼운다. UPDATE_INFO와 TRAY_ACCOUNTS_CACHE는 둘 다 rebuild_tray_menu가
// 양쪽을 읽어 합치므로, 어느 한쪽이 새로 들어와도 트레이 메뉴 한 번만 다시 그리면 된다.
static UPDATE_INFO: OnceLock<parking_lot::Mutex<Option<updater::UpdateInfo>>> = OnceLock::new();
static TRAY_ACCOUNTS_CACHE: OnceLock<parking_lot::Mutex<(Vec<AccountMeta>, Option<String>)>> =
    OnceLock::new();

// 트레이 메뉴 "표시 모드 ▸" 서브메뉴의 라디오 표시(● vs ○)를 그리려면 현재 mode를
// 알아야 한다. webview가 부트 시 + 메뉴에서 토글 시 update_tray_mode 커맨드로 푸시.
// 기본값은 v1.24까지의 동작인 FiveHour.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum TrayMode {
    #[default]
    Fivehour,
    Both,
    /// 5h + 주간 + prepaid 잔액 달러. prepaid 데이터가 아직 없으면 트레이엔
    /// `76% · 주 54%`까지만, 들어온 다음 cycle부터 `· $12.34` 합쳐짐.
    All,
}

static TRAY_MODE: OnceLock<parking_lot::Mutex<TrayMode>> = OnceLock::new();
// 설치 클릭이 진행 중일 때 중복 트리거 차단. 사용자가 메뉴를 다시 펴서 "설치"를
// 여러 번 누르는 케이스 보호.
static INSTALL_IN_PROGRESS: OnceLock<AtomicBool> = OnceLock::new();

fn update_info_lock() -> &'static parking_lot::Mutex<Option<updater::UpdateInfo>> {
    UPDATE_INFO.get_or_init(|| parking_lot::Mutex::new(None))
}

fn tray_accounts_cache_lock(
) -> &'static parking_lot::Mutex<(Vec<AccountMeta>, Option<String>)> {
    TRAY_ACCOUNTS_CACHE.get_or_init(|| parking_lot::Mutex::new((Vec::new(), None)))
}

fn install_in_progress() -> &'static AtomicBool {
    INSTALL_IN_PROGRESS.get_or_init(|| AtomicBool::new(false))
}

fn tray_mode_lock() -> &'static parking_lot::Mutex<TrayMode> {
    TRAY_MODE.get_or_init(|| parking_lot::Mutex::new(TrayMode::default()))
}

fn rebuild_tray_menu(app: &AppHandle) -> Result<(), String> {
    let (accounts, active_id) = {
        let lock = tray_accounts_cache_lock().lock();
        lock.clone()
    };
    let info_opt = update_info_lock().lock().clone();
    let menu = build_menu(app, &accounts, active_id.as_deref(), info_opt.as_ref())
        .map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 트레이 메뉴를 항상 같은 골격으로 짠다: 버전(비활성, 업데이트 있으면 인라인 마커
// 추가) / 🆕 새 버전 설치(업데이트 있을 때만) / 보이기 / 새로고침 /
// (계정 1개 이상이면) 계정 전환 ▸ / 설정 / 종료.
fn build_menu(
    app: &AppHandle,
    accounts: &[AccountMeta],
    active_id: Option<&str>,
    update_info: Option<&updater::UpdateInfo>,
) -> tauri::Result<Menu<Wry>> {
    let version_label = match update_info {
        Some(info) => format!(
            "토큰 판다 v{} · 🆕 v{} 있음",
            env!("CARGO_PKG_VERSION"),
            info.latest_version
        ),
        None => format!("토큰 판다 v{}", env!("CARGO_PKG_VERSION")),
    };
    let version_item = MenuItem::with_id(app, "version", &version_label, false, None::<&str>)?;
    let update_item: Option<MenuItem<Wry>> = match update_info {
        Some(info) => Some(MenuItem::with_id(
            app,
            "install_update",
            &format!("🆕 새 버전 v{} 설치", info.latest_version),
            true,
            None::<&str>,
        )?),
        None => None,
    };
    let show_item = MenuItem::with_id(app, "show", "펫 보이기/숨기기", true, None::<&str>)?;
    let refresh_item = MenuItem::with_id(app, "refresh", "지금 새로고침", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "설정...", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;

    // 계정 항목들. 활성 계정 앞에 `● `, 비활성에는 `○ `를 붙여 라디오 표시.
    // (Tauri 2.x의 CheckMenuItem은 macOS 트레이에서 라벨 정렬이 들쭉날쭉해서
    // 텍스트 prefix가 더 안정적이라 이걸 선택.)
    let mut account_items: Vec<MenuItem<Wry>> = Vec::with_capacity(accounts.len());
    for acc in accounts {
        let prefix = if active_id == Some(acc.id.as_str()) {
            "● "
        } else {
            "○ "
        };
        let label = format!("{}{}", prefix, acc.label);
        let id = format!("account-{}", acc.id);
        account_items.push(MenuItem::with_id(app, &id, &label, true, None::<&str>)?);
    }

    let submenu_opt: Option<Submenu<Wry>> = if account_items.is_empty() {
        None
    } else {
        let item_refs: Vec<&dyn IsMenuItem<Wry>> = account_items
            .iter()
            .map(|i| i as &dyn IsMenuItem<Wry>)
            .collect();
        Some(Submenu::with_id_and_items(
            app,
            "accounts",
            "계정 전환",
            true,
            &item_refs,
        )?)
    };

    // "표시 모드 ▸" 서브메뉴. 계정 전환과 같은 prefix 라디오 패턴(● 선택 / ○ 미선택).
    // 클릭 시 메뉴 이벤트 핸들러가 webview로 tray-set-mode를 emit하고, webview가
    // PlanConfig를 저장한 뒤 update_tray_mode로 라디오 표시를 갱신한다.
    let mode = *tray_mode_lock().lock();
    let mode_fivehour_label = format!(
        "{} 5h만",
        if mode == TrayMode::Fivehour { "●" } else { "○" }
    );
    let mode_both_label = format!(
        "{} 5h + 주간",
        if mode == TrayMode::Both { "●" } else { "○" }
    );
    let mode_all_label = format!(
        "{} 5h + 주간 + $",
        if mode == TrayMode::All { "●" } else { "○" }
    );
    let mode_fivehour_item = MenuItem::with_id(
        app,
        "mode-fivehour",
        &mode_fivehour_label,
        true,
        None::<&str>,
    )?;
    let mode_both_item = MenuItem::with_id(app, "mode-both", &mode_both_label, true, None::<&str>)?;
    let mode_all_item = MenuItem::with_id(app, "mode-all", &mode_all_label, true, None::<&str>)?;
    let mode_submenu = Submenu::with_id_and_items(
        app,
        "tray-mode",
        "표시 모드",
        true,
        &[
            &mode_fivehour_item as &dyn IsMenuItem<Wry>,
            &mode_both_item as &dyn IsMenuItem<Wry>,
            &mode_all_item as &dyn IsMenuItem<Wry>,
        ],
    )?;

    let mut top_refs: Vec<&dyn IsMenuItem<Wry>> = Vec::new();
    top_refs.push(&version_item);
    if let Some(ref item) = update_item {
        top_refs.push(item);
    }
    top_refs.push(&show_item);
    top_refs.push(&refresh_item);
    if let Some(ref sub) = submenu_opt {
        top_refs.push(sub);
    }
    top_refs.push(&mode_submenu);
    top_refs.push(&settings_item);
    top_refs.push(&quit_item);

    Menu::with_items(app, &top_refs)
}

#[tauri::command]
fn update_tray_accounts(
    app: AppHandle,
    accounts: Vec<AccountMeta>,
    active_id: Option<String>,
) -> Result<(), String> {
    {
        let mut lock = tray_accounts_cache_lock().lock();
        *lock = (accounts, active_id);
    }
    rebuild_tray_menu(&app)
}

#[tauri::command]
fn update_tray_mode(app: AppHandle, mode: TrayMode) -> Result<(), String> {
    {
        let mut lock = tray_mode_lock().lock();
        *lock = mode;
    }
    rebuild_tray_menu(&app)
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    // 첫 부팅에는 계정 정보와 업데이트 정보를 모르니 둘 다 None으로 메뉴를 짓고,
    // 메인 webview가 부트할 때 update_tray_accounts로 계정 서브메뉴를, 백그라운드
    // update_checker가 1시간 주기로 업데이트 마커를 채워넣는다.
    let menu = build_menu(app, &[], None, None)?;

    // 트레이 아이콘은 사용자 요청으로 제거. 메뉴바엔 텍스트 라벨(set_tray_title)만
    // 표시된다. 아이콘 PNG 상수와 tray_icon_bytes 분기, set_tray_icon_for_remaining
    // 호출은 호환성을 위해 남겨두되 본체는 no-op.
    let _tray = TrayIconBuilder::with_id("main-tray")
        .title("…")
        .menu(&menu)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            // 계정 전환 클릭은 webview 쪽에서 store/Rust 모두 한 트랜잭션으로
            // 처리해야 해서, Rust는 id만 던지고 webview의 `tray-switch-account`
            // 리스너가 실제 전환을 수행한다 (App.tsx의 switchActiveAccount).
            if let Some(acc_id) = id.strip_prefix("account-") {
                let _ = app.emit("tray-switch-account", acc_id.to_string());
                return;
            }
            match id {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        if window.is_visible().unwrap_or(false) {
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
                "refresh" => {
                    let _ = refresh_usage(app.clone());
                }
                "settings" => {
                    let _ = open_settings_window(app.clone());
                }
                "mode-fivehour" => {
                    let _ = app.emit("tray-set-mode", "fivehour");
                }
                "mode-both" => {
                    let _ = app.emit("tray-set-mode", "both");
                }
                "mode-all" => {
                    let _ = app.emit("tray-set-mode", "all");
                }
                "install_update" => {
                    // 사용자가 메뉴를 여러 번 펴서 "설치"를 연타하는 케이스 방어.
                    if install_in_progress().swap(true, Ordering::SeqCst) {
                        return;
                    }
                    let app_clone = app.clone();
                    std::thread::spawn(move || {
                        run_install_update(app_clone);
                    });
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        // No on_tray_icon_event: a left-click on the tray title now just
        // opens the menu (the macOS default when a menu is set). The pet
        // window stays visible until the user explicitly hides it via
        // "펫 보이기/숨기기" in the menu.
        .build(app)?;
    Ok(())
}

// 사용자가 "🆕 새 버전 설치"를 눌렀을 때 별도 스레드에서 수행되는 본체.
// dmg 다운로드 → bash 스크립트 spawn → self-quit. 중간 실패는 알림으로만
// 알리고 install_in_progress 락을 풀어 사용자가 다시 시도할 수 있게 한다.
// Windows/Linux 자동 업데이트는 Phase 3에서 cross-platform화 예정 — 현재는 stub.
#[cfg(not(target_os = "macos"))]
fn run_install_update(_app: AppHandle) {
    install_in_progress().store(false, Ordering::SeqCst);
}

#[cfg(target_os = "macos")]
fn run_install_update(app: AppHandle) {
    let info = match update_info_lock().lock().clone() {
        Some(i) => i,
        None => {
            install_in_progress().store(false, Ordering::SeqCst);
            return;
        }
    };
    notify_update("토큰 판다 업데이트", "새 버전 다운로드 중...");
    let dmg_path = match updater::download_dmg(&info.dmg_url, &info.dmg_name) {
        Ok(p) => p,
        Err(e) => {
            log::error!("dmg download failed: {}", e);
            notify_update("업데이트 실패", &format!("다운로드 실패: {}", e));
            install_in_progress().store(false, Ordering::SeqCst);
            return;
        }
    };
    let app_path = updater::applications_app_path();
    if let Err(e) = updater::spawn_install_script(&dmg_path, &app_path) {
        log::error!("spawn install script failed: {}", e);
        notify_update("업데이트 실패", &format!("스크립트 실행 실패: {}", e));
        install_in_progress().store(false, Ordering::SeqCst);
        return;
    }
    // 스크립트가 sleep 1s 후 옛 앱이 죽었는지 검사하므로, 우리는 0.5s 후 self-quit.
    std::thread::sleep(Duration::from_millis(500));
    app.exit(0);
}

// osascript로 macOS 시스템 알림. tauri-plugin-notification은 webview 권한 흐름이
// 얽혀 있어 Rust 백그라운드 스레드에서 직접 부르기 번거로움. osascript는 알림
// 권한이 macOS 시스템 설정에 종속되어 별도 권한 다이얼로그 없이 발사된다.
// Windows는 Phase 3에서 powershell New-BurntToastNotification 같은 동등 흐름 추가 예정.
#[cfg(not(target_os = "macos"))]
fn notify_update(_title: &str, _body: &str) {}

#[cfg(target_os = "macos")]
fn notify_update(title: &str, body: &str) {
    let sanitized_title = title.replace('"', "'");
    let sanitized_body = body.replace('"', "'");
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(format!(
            r#"display notification "{}" with title "{}""#,
            sanitized_body, sanitized_title
        ))
        .status();
}

// 부팅 3초 후 + 1시간 주기로 GitHub Releases를 폴링. 새 버전이 있으면 UPDATE_INFO에
// 넣고 트레이 메뉴를 다시 그린다. 네트워크 실패는 graceful — UPDATE_INFO 그대로 두고
// 다음 사이클로 넘어간다.
// Windows/Linux는 자동 설치 경로가 아직 없어 Phase 1에선 polling 자체를 끔.
#[cfg(not(target_os = "macos"))]
fn start_update_checker(_app: AppHandle) {}

#[cfg(target_os = "macos")]
fn start_update_checker(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        loop {
            let current = env!("CARGO_PKG_VERSION");
            let fetched = updater::fetch_latest_release(current);
            let changed = {
                let mut lock = update_info_lock().lock();
                let prev = lock.clone();
                if prev != fetched {
                    *lock = fetched.clone();
                    true
                } else {
                    false
                }
            };
            if changed {
                let app_for_main = app.clone();
                let _ = app.run_on_main_thread(move || {
                    let _ = rebuild_tray_menu(&app_for_main);
                });
            }
            // 1시간 대기. anonymous GitHub API 60/hr이라 1회/hr면 안전.
            std::thread::sleep(Duration::from_secs(60 * 60));
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 두 번째 부팅 시도는 즉시 quit. lock file이 같은 bundle id로 잡혀 있어
        // LSDB가 같은 .app을 두 번 spawn하거나, 사용자가 binary를 손으로 한 번 더
        // 띄워도 트레이가 2개 뜨지 않는다. 콜백은 *기존* 인스턴스에서 실행되며,
        // 메인 윈도우를 다시 보이게 끌어올린다.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Hide the Dock icon FIRST so the window we're about to attach
            // panel-behavior to is created under accessory mode.
            set_macos_accessory_app();

            let handle = app.handle().clone();
            build_tray(&handle)?;
            start_update_checker(handle.clone());

            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                {
                    // 1) Apply once during setup.
                    set_macos_panel_behavior(&window);

                    // 2) Apply again ~200ms later — tao re-applies its own
                    //    collection-behavior bits during early window
                    //    lifecycle, after our setup hook has returned.
                    let w_for_thread = window.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(200));
                        let w_for_main = w_for_thread.clone();
                        let _ = w_for_thread.run_on_main_thread(move || {
                            set_macos_panel_behavior(&w_for_main);
                        });
                    });

                    // 3) Re-apply on every relevant lifecycle event. Some
                    //    tao/macOS interactions (focus, Space change, app
                    //    activation) reset the collection behavior; we
                    //    enforce it back to our values each time.
                    let w_for_event = window.clone();
                    window.on_window_event(move |event| {
                        use tauri::WindowEvent;
                        match event {
                            WindowEvent::Focused(_)
                            | WindowEvent::Resized(_)
                            | WindowEvent::Moved(_) => {
                                let w = w_for_event.clone();
                                let _ = w_for_event.run_on_main_thread(move || {
                                    set_macos_panel_behavior(&w);
                                });
                            }
                            _ => {}
                        }
                    });

                    // 4) Periodic re-application (~1.5s). Window focus
                    //    events only fire on OUR window's transitions; when
                    //    another app activates and visually covers our
                    //    SkyLight Space, we don't get an event. Without
                    //    this tick the panda only reappears after the user
                    //    clicks somewhere — exactly the symptom users
                    //    reported as "I click the image, panda disappears
                    //    until I click again." 1.5s is the slowest that
                    //    feels instant; faster wastes CPU on a no-op
                    //    SLSShowSpaces call.
                    let w_for_tick = window.clone();
                    std::thread::spawn(move || loop {
                        std::thread::sleep(Duration::from_millis(1500));
                        let w = w_for_tick.clone();
                        if w_for_tick
                            .run_on_main_thread(move || {
                                set_macos_panel_behavior(&w);
                            })
                            .is_err()
                        {
                            break;
                        }
                    });
                }
            }

            let watcher = start_watcher(handle.clone());
            app.manage(watcher);
            start_api_poller(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_usage_snapshot,
            claude_projects_path,
            set_tray_title,
            set_tray_icon_for_remaining,
            resize_pet_window,
            set_active_skin,
            update_tray_accounts,
            update_tray_mode,
            toggle_main_window,
            focus_for_input,
            set_api_config,
            test_api_config,
            refresh_usage,
            settings_focus,
            open_settings_window,
            open_onboarding_window,
            open_claude_usage_in_browser,
            auto_extract_from_cookie
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchored_y_height_decrease_moves_window_down() {
        // cur top y=100, height 460 → bottom = 560. 새 height 280 이면 같은
        // bottom(560)을 유지하려면 new_y = 100 + (460 - 280) = 280.
        assert_eq!(compute_anchored_y(100, 460, 280), 280);
    }

    #[test]
    fn anchored_y_height_increase_moves_window_up() {
        // cur top y=280, height 280 → bottom = 560. 새 height 460 이면 같은
        // bottom(560)을 유지하려면 new_y = 280 + (280 - 460) = 100.
        assert_eq!(compute_anchored_y(280, 280, 460), 100);
    }

    #[test]
    fn anchored_y_height_unchanged_keeps_y() {
        assert_eq!(compute_anchored_y(123, 300, 300), 123);
    }

    #[test]
    fn anchored_y_handles_negative_top() {
        // 멀티 모니터 등으로 cur_y 가 음수일 수 있음. 산식은 그대로.
        assert_eq!(compute_anchored_y(-50, 400, 200), 150);
    }
}
