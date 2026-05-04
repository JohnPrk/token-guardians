import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ApiConfig, PlanConfig, UsageSnapshot } from "./types";
import { PLAN_PRESETS } from "./types";
import {
  loadApiConfig,
  loadPlanConfig,
  saveApiConfig,
  savePlanConfig,
} from "./store";
import { ACCESSORIES, DEFAULT_SKIN_ID, SKINS, findSkin, type ActionName } from "./skins";
import {
  CACHE_TTL_MS,
  derive,
  formatRemain,
  formatResetCountdown,
} from "./petLogic";
import { maybeNotify, resetThreshold } from "./notifier";
import "./App.css";

// Action set + wait gap, conditioned on the panda's current energy tier.
// Energetic actions only happen at upper tiers; sluggish ones at lower.
function allowedActionsFor(state: string) {
  const energetic = new Set(["roll", "jump", "run"]);
  const calm = new Set(["scratch", "wobble", "squish"]);
  const sluggish = new Set(["scratch", "wobble"]);
  // sleepy는 자고 있는 상태라서 머리 위 대나무를 들고 긁는 건 어색함.
  // wobble(좌우 기우뚱)만 남겨 살짝 뒤척이는 정도로.
  const sleepyOnly = new Set(["wobble"]);

  let names: Set<string>;
  switch (state) {
    case "full":
    case "high":
    case "good":
      names = new Set([...energetic, ...calm]);
      break;
    case "mid":
      names = new Set([...calm, "jump"]);
      break;
    case "low":
    case "tired":
      names = sluggish;
      break;
    case "sleepy":
      names = sleepyOnly;
      break;
    // dead and disconnected stay still — bouncing around while quota
    // is exhausted or API is broken would feel wrong.
    default:
      return [];
  }
  return IDLE_ACTIONS.filter((a) => names.has(a.name));
}

// Wait between actions, by tier — peppier states act more often.
function waitMsFor(state: string): [number, number] {
  switch (state) {
    case "full":
    case "high":
      return [4_500, 5_500];      // ~5-10s
    case "good":
      return [6_000, 6_000];      // ~6-12s
    case "mid":
      return [9_000, 7_000];      // ~9-16s
    case "low":
    case "tired":
      return [13_000, 9_000];     // ~13-22s
    case "sleepy":
      return [18_000, 12_000];    // ~18-30s
    default:
      return [10_000, 10_000];
  }
}

type IdleAction =
  | "none"
  | "roll"
  | "jump"
  | "run"
  | "scratch"
  | "wobble"
  | "squish";

const IDLE_ACTIONS: ReadonlyArray<{ name: Exclude<IdleAction, "none">; durationMs: number }> = [
  { name: "roll", durationMs: 3800 },     // 3.8s × 1
  { name: "jump", durationMs: 3800 },     // 3.8s × 1
  { name: "run", durationMs: 6300 },      // 1.05s × 6
  { name: "scratch", durationMs: 4500 },  // 1.5s × 3 → 4.5s
  { name: "wobble", durationMs: 2700 },   // 0.9s × 3
  { name: "squish", durationMs: 1260 },   // 1.26s × 1
];

// Battery-style: notify when remaining drops to these thresholds.
const REMAINING_THRESHOLDS: Array<[number, string]> = [
  [0.3, "30%"],
  [0.1, "10%"],
  [0.0, "0%"],
];

type View = "loading" | "pet";

// Three windows share this bundle: the pinned pet panel ("main"), the
// settings popup ("settings"), and the first-run onboarding popup
// ("onboarding"). The non-main ones are launched with ?view=<name> so
// we branch at the top of the React tree.
function viewFromUrl(): "settings" | "onboarding" | "preview" | null {
  const v = new URLSearchParams(window.location.search).get("view");
  if (v === "settings") return "settings";
  if (v === "onboarding") return "onboarding";
  if (v === "preview") return "preview";
  return null;
}

export default function App() {
  const v = viewFromUrl();
  if (v === "settings") return <SettingsApp />;
  if (v === "onboarding") return <OnboardingApp />;
  if (v === "preview") return <AnimPreviewApp />;
  return <PetApp />;
}

const PREVIEW_ACTIONS: Exclude<IdleAction, "none">[] = [
  "roll",
  "jump",
  "run",
  "scratch",
  "wobble",
  "squish",
];

const PREVIEW_LABELS: Record<Exclude<IdleAction, "none">, string> = {
  roll: "roll · 3.8s",
  jump: "jump · 3.8s + shadow",
  run: "run · 1.05s ×6 + wind",
  scratch: "scratch · 1.5s ×3",
  wobble: "wobble · 0.9s ×3",
  squish: "squish · 1.26s + impact",
};

const PREVIEW_FLASHES: Array<{ kind: "hit" | "miss"; label: string }> = [
  { kind: "hit", label: "flash-hit · 노란 폭죽" },
  { kind: "miss", label: "flash-miss · 비 (우는 톤)" },
];

function AnimPreviewApp() {
  const skin = findSkin(DEFAULT_SKIN_ID);
  const stillSrc = skin.frames.good;
  const [state] = useState<"full" | "high" | "good" | "mid" | "low" | "tired" | "sleepy">("good");

  return (
    <div className="preview-root">
      <header className="preview-header">
        <h1>Anim Preview</h1>
        <p>
          12개 idle 액션 + 캐시 hit/miss flash를 동시에 무한 반복. App.css의 keyframe·duration·timing을 고치면 Vite HMR로 즉시 반영됩니다.
        </p>
      </header>
      <div className="preview-grid">
        {PREVIEW_ACTIONS.map((action) => (
          <div key={action} className="preview-cell">
            <div className="preview-stage">
              <div className="character" data-state={state} data-action={action}>
                <img src={stillSrc} alt={action} draggable={false} />
                {action === "scratch" && (
                  <img className="bamboo bamboo-scratch" src={ACCESSORIES.bamboo} alt="" draggable={false} />
                )}
                {action === "run" && (
                  <div className="wind-streaks" aria-hidden>
                    <span className="streak streak-1" />
                    <span className="streak streak-2" />
                    <span className="streak streak-3" />
                  </div>
                )}
                {action === "jump" && <div className="jump-shadow" aria-hidden />}
                {action === "squish" && <div className="squish-impact" aria-hidden />}
              </div>
            </div>
            <div className="preview-label">{PREVIEW_LABELS[action]}</div>
          </div>
        ))}
        {PREVIEW_FLASHES.map(({ kind, label }) => (
          <div key={`flash-${kind}`} className="preview-cell">
            <div className="preview-stage">
              <div className="character" data-state={state} data-flash={kind}>
                <img src={stillSrc} alt={`flash-${kind}`} draggable={false} />
                {kind === "hit" && (
                  <div className="firework" aria-hidden>
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                      <span key={i} className={`spark spark-${i}`} />
                    ))}
                  </div>
                )}
                {kind === "miss" && (
                  <div className="rain" aria-hidden>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((i) => (
                      <span key={i} className={`drop drop-${i}`} />
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="preview-label">{label}</div>
          </div>
        ))}
        <div className="preview-cell">
          <div className="preview-stage">
            <div className="character" data-state="disconnected">
              <img src={skin.frames.disconnected} alt="disconnected" draggable={false} />
              <img
                className="disconnected-sign"
                src={ACCESSORIES.disconnectedSign}
                alt="연결 실패"
                draggable={false}
              />
            </div>
          </div>
          <div className="preview-label">disconnected · 연결 실패 표지판</div>
        </div>
      </div>
    </div>
  );
}

function PetApp() {
  const [view, setView] = useState<View>("loading");
  const [config, setConfig] = useState<PlanConfig | null>(null);

  useEffect(() => {
    Promise.all([loadPlanConfig(), loadApiConfig()]).then(([cfg, api]) => {
      if (api) {
        invoke("set_api_config", { orgId: api.orgId, cookie: api.cookie }).catch(
          () => {},
        );
      }
      if (cfg) {
        setConfig(cfg);
        setView("pet");
      } else {
        // First launch — silently save a default plan so the rest of
        // the pet logic has something to render against, then pop the
        // standalone onboarding window. The character picker and API
        // form live there, so the pet stops needing a plan modal.
        const defaultCfg: PlanConfig = {
          plan: "max5x",
          limits: PLAN_PRESETS.max5x,
          skin: DEFAULT_SKIN_ID,
        };
        savePlanConfig(defaultCfg).then(() => {
          setConfig(defaultCfg);
          setView("pet");
          invoke("open_onboarding_window").catch(() => {});
        });
      }
    });
  }, []);

  // The standalone settings window emits `config-changed` after every
  // save. Reload the plan from the shared store so the pet picks up the
  // new skin/limits without restarting. The api config is already pushed
  // to the Rust side directly by the settings window via set_api_config,
  // so we don't need to mirror it in pet React state.
  useEffect(() => {
    const un = listen("config-changed", async () => {
      const cfg = await loadPlanConfig();
      if (cfg) setConfig(cfg);
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  if (view === "loading") return null;
  // Onboarding lives in its own window now (open_onboarding_window).
  // The pet panel always renders against `config` — even on first
  // launch, where we save a default plan synchronously above before
  // popping the onboarding window.
  return <Pet config={config!} />;
}

// The settings popup is its own ordinary, decorated window. No panel
// pinning, no level juggling — text inputs work normally. It loads the
// shared config store, lets the user edit, and broadcasts
// `config-changed` so the pet window can re-read.
function SettingsApp() {
  const [config, setConfig] = useState<PlanConfig | null>(null);
  const [apiConfig, setApiConfig] = useState<ApiConfig | null>(null);
  const [snap, setSnap] = useState<UsageSnapshot | null>(null);

  useEffect(() => {
    Promise.all([
      loadPlanConfig(),
      loadApiConfig(),
      invoke<UsageSnapshot>("get_usage_snapshot").catch(() => null),
    ]).then(([cfg, api, s]) => {
      setConfig(cfg);
      setApiConfig(api);
      if (s) setSnap(s);
    });
    const un = listen<UsageSnapshot>("usage-update", (e) => setSnap(e.payload));
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  if (!config) return null;

  const closeSelf = async () => {
    try {
      await getCurrentWindow().close();
    } catch {
      // best-effort
    }
  };

  return (
    <div className="settings-window">
      <Settings
        config={config}
        apiConfig={apiConfig}
        snap={snap}
        onClose={closeSelf}
        onSave={async (c) => {
          await savePlanConfig(c);
          setConfig(c);
          await emit("config-changed");
          await closeSelf();
        }}
        onApiSave={async (a) => {
          await saveApiConfig(a);
          await invoke("set_api_config", {
            orgId: a?.orgId ?? null,
            cookie: a?.cookie ?? null,
          }).catch(() => {});
          setApiConfig(a);
          await emit("config-changed");
        }}
      />
    </div>
  );
}

// First-launch welcome window — opens automatically (from PetApp's
// boot when no PlanConfig is saved) and walks the user through the
// two real choices the app needs: a character and the claude.ai
// session credentials. There's no plan selection anymore — quota %
// comes straight from claude.ai's API once the user pastes a cookie.
function OnboardingApp() {
  const [skin, setSkin] = useState<string>(DEFAULT_SKIN_ID);
  const [orgId, setOrgId] = useState("");
  const [cookie, setCookie] = useState("");
  const [testStatus, setTestStatus] = useState<string>("");
  const [step, setStep] = useState<1 | 2>(1);

  const test = async () => {
    if (!orgId.trim() || !cookie.trim()) {
      setTestStatus("Org ID와 쿠키를 모두 채워주세요.");
      return;
    }
    setTestStatus("테스트 중...");
    try {
      const res = await invoke<{ five_hour_pct: number; weekly_pct: number }>(
        "test_api_config",
        { orgId: orgId.trim(), cookie: cookie.trim() },
      );
      setTestStatus(
        `✓ 5h ${res.five_hour_pct.toFixed(0)}% · 주간 ${res.weekly_pct.toFixed(0)}%`,
      );
    } catch (e: unknown) {
      setTestStatus(`✗ ${String(e)}`);
    }
  };

  const closeSelf = async () => {
    try {
      await getCurrentWindow().close();
    } catch {
      // best-effort
    }
  };

  const finish = async () => {
    // Save plan with default presets (legacy field; not user-visible
    // anymore in API-only mode) plus the chosen skin.
    const cfg: PlanConfig = {
      plan: "max5x",
      limits: PLAN_PRESETS.max5x,
      skin,
    };
    await savePlanConfig(cfg);
    if (orgId.trim() && cookie.trim()) {
      const api: ApiConfig = { orgId: orgId.trim(), cookie: cookie.trim() };
      await saveApiConfig(api);
      await invoke("set_api_config", api).catch(() => {});
    }
    await emit("config-changed");
    await closeSelf();
  };

  return (
    <div className="onboarding-window">
      <div className="onboarding-card">
        <header className="onboarding-header">
          <h1>토큰 판다에 오신 걸 환영해요 🎋</h1>
          <p className="onboarding-sub">
            Claude의 가장 큰 단점은 토큰이 자주 부족하다는 것 — 토큰 판다는
            데스크톱 한 켠에 앉아 5시간/주간 잔량을 실시간으로 보여주고,
            <strong> 캐시가 끊기기 전에 미리 알려줘서 토큰을 아낄 수 있게</strong> 도와줍니다.
          </p>
          <ol className="onboarding-stepper" aria-hidden="true">
            <li className={step === 1 ? "active" : "done"}>1. 캐릭터</li>
            <li className={step === 2 ? "active" : ""}>2. claude.ai 연동</li>
          </ol>
        </header>

        {step === 1 && (
          <section className="onboarding-step">
            <h2>1. 어떤 친구로 할까요?</h2>
            <p className="onboarding-step-desc">
              데스크톱 모서리에 살게 될 캐릭터를 골라주세요. 나중에
              `설정`에서 언제든 바꿀 수 있어요.
            </p>
            <div className="skin-grid">
              {SKINS.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  className={`skin-tile ${skin === s.id ? "selected" : ""}`}
                  onClick={() => setSkin(s.id)}
                  title={s.name}
                >
                  <img src={s.frames.good} alt={s.name} />
                  <span>{s.name}</span>
                </button>
              ))}
            </div>
            <div className="onboarding-actions">
              <button type="button" onClick={closeSelf} className="ghost">
                나중에 할게요
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => setStep(2)}
              >
                다음
              </button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="onboarding-step">
            <h2>2. claude.ai 연동</h2>
            <p className="onboarding-step-desc">
              claude.ai의 사용량 페이지가 쓰는 것과 같은 내부 API를 직접 호출해서
              <strong> Anthropic 공식 utilization%</strong> 그대로 가져옵니다.
              연동 정보는 이 컴퓨터 안에만 저장되고, 외부 서버 어디에도
              전송하지 않아요.
            </p>

            <div className="onboarding-howto">
              <h3>① Org ID 가져오기</h3>
              <ol>
                <li>
                  <a href="https://claude.ai/settings/account" target="_blank" rel="noreferrer">
                    claude.ai/settings/account
                  </a>
                  에 접속합니다.
                </li>
                <li>"계정" 섹션의 <strong>조직 ID</strong> 값 복사
                  <br />(예: <code>63e058d5-142c-4368-bca3-39d64d78b4f5</code>)</li>
              </ol>

              <h3>② 세션 쿠키 가져오기</h3>
              <ol>
                <li>
                  <a href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer">
                    claude.ai/settings/usage
                  </a>
                  에 접속해 한 번 새로고침합니다.
                </li>
                <li>
                  <code>⌘⌥I</code>로 개발자 도구 → <strong>Network</strong> 탭 열기
                </li>
                <li>
                  목록에서 <code>usage</code> 요청을 클릭 → Headers 탭 →
                  Request Headers의 <code>cookie:</code> 줄을 <strong>통째로</strong> 복사
                </li>
                <li>아래 칸에 그대로 붙여넣기</li>
              </ol>
              <p className="onboarding-howto-note">
                실제로 쓰이는 쿠키는 5개(<code>sessionKey</code>, <code>cf_clearance</code>, <code>__cf_bm</code>, <code>_cfuvid</code>, <code>routingHint</code>)뿐이고
                나머지는 무시됩니다. 그러니 한 줄을 통째로 복붙해도 안전해요.
              </p>
            </div>

            <label>
              Organization ID
              <input
                type="text"
                placeholder="63e058d5-142c-4368-bca3-39d64d78b4f5"
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
                spellCheck={false}
              />
            </label>
            <label>
              세션 쿠키
              <textarea
                placeholder="sessionKey=sk-ant-sid02-...; cf_clearance=...; __cf_bm=...; _cfuvid=...; routingHint=[sk-ant-rh-...]"
                value={cookie}
                onChange={(e) => setCookie(e.target.value)}
                rows={4}
                spellCheck={false}
              />
            </label>

            <div className="onboarding-test-row">
              <button type="button" onClick={test}>
                연결 테스트
              </button>
              {testStatus && <span className="onboarding-test-status">{testStatus}</span>}
            </div>

            <div className="onboarding-security">
              ⚠️ Org ID + 쿠키는 본인 claude.ai 세션의 자격증명입니다. 외부에
              유출되면 다른 사람이 사용량을 조회·소모할 수 있으니
              <strong>공유하지 마세요.</strong>
              쿠키가 만료되면 토큰 판다가 자동으로 감지하고
              이 창을 다시 열어 새 쿠키를 요청합니다.
            </div>

            <div className="onboarding-actions">
              <button type="button" onClick={() => setStep(1)} className="ghost">
                이전
              </button>
              <button type="button" className="primary" onClick={finish}>
                {orgId.trim() && cookie.trim() ? "저장하고 시작" : "건너뛰고 시작"}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Pet({
  config,
}: {
  config: PlanConfig;
}) {
  const [snap, setSnap] = useState<UsageSnapshot | null>(null);
  const [now, setNow] = useState(Date.now());
  const [idleAction, setIdleAction] = useState<IdleAction>("none");
  const [flash, setFlash] = useState<"hit" | "miss" | null>(null);
  // useRef instead of useState — avoids stale-closure/batching races where
  // the effect's captured seenLastReq lagged a render behind, swallowing
  // back-to-back snap updates.
  const seenLastReqRef = useRef<string | null | "init">("init");
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    invoke<UsageSnapshot>("get_usage_snapshot").then(setSnap).catch(() => {});
    const unlistenP = listen<UsageSnapshot>("usage-update", (e) =>
      setSnap(e.payload),
    );
    // Fallback for any old code path that emits show-settings: route to
    // the new standalone window instead of opening an in-panel overlay.
    const unlistenSettings = listen("show-settings", () => {
      invoke("open_settings_window").catch(() => {});
    });
    const tick = setInterval(() => setNow(Date.now()), 500);
    return () => {
      clearInterval(tick);
      unlistenP.then((fn) => fn());
      unlistenSettings.then((fn) => fn());
    };
  }, []);

  const d = useMemo(() => derive(snap, config.limits, now), [snap, config, now]);

  // Cache hit/miss flash: trigger when the latest assistant message advances.
  // Counts in `cache_hits_5min` are a sliding window — they can stay flat or
  // even drop as old entries age out, which used to swallow hits entirely.
  // Tracking `last_request_at` + `last_cache_hit` via ref (not state) fires
  // on every new assistant response without React batching/closure races.
  useEffect(() => {
    if (!snap) return;
    const lastReq = snap.last_request_at;
    const seen = seenLastReqRef.current;
    if (seen === "init") {
      seenLastReqRef.current = lastReq;
      return;
    }
    if (lastReq && lastReq !== seen && snap.last_cache_hit !== null) {
      const trigger: "hit" | "miss" = snap.last_cache_hit ? "hit" : "miss";
      seenLastReqRef.current = lastReq;
      setFlash(trigger);
      const dur = trigger === "miss" ? 4000 : 2500;
      const t = setTimeout(() => setFlash(null), dur);
      return () => clearTimeout(t);
    }
    seenLastReqRef.current = lastReq;
  }, [snap?.last_request_at, snap?.last_cache_hit]);

  // Idle micro-actions: filtered by current energy tier so a sleepy panda
  // doesn't spontaneously start exercising. sleep/dead never trigger any.
  useEffect(() => {
    if (d.petState === "dead") {
      setIdleAction("none");
      return;
    }
    const allowed = allowedActionsFor(d.petState);
    if (allowed.length === 0) {
      setIdleAction("none");
      return;
    }
    let cancelled = false;
    let actionTimeout: ReturnType<typeof setTimeout> | undefined;
    const tierGap = waitMsFor(d.petState);
    const schedule = () => {
      const wait = tierGap[0] + Math.random() * tierGap[1];
      actionTimeout = setTimeout(() => {
        if (cancelled) return;
        const pick = allowed[Math.floor(Math.random() * allowed.length)];
        setIdleAction(pick.name);
        actionTimeout = setTimeout(() => {
          if (cancelled) return;
          setIdleAction("none");
          schedule();
        }, pick.durationMs);
      }, wait);
    };
    schedule();
    return () => {
      cancelled = true;
      if (actionTimeout) clearTimeout(actionTimeout);
    };
  }, [d.petState]);

  // Tray title. 4단계 PNG 트레이 아이콘(대나무 → 죽순 → 시든 잎)이 상태를
  // 전부 표현하므로, 텍스트 라벨은 % 만 남겨 중복을 제거한다.
  useEffect(() => {
    const remaining = d.petState === "disconnected" ? 0 : d.fiveHourRemaining;
    const title = `${Math.round(remaining * 100)}%`;
    invoke("set_tray_title", { title }).catch(() => {});
    invoke("set_tray_icon_for_remaining", { remaining }).catch(() => {});
  }, [d.fiveHourRemaining, d.petState]);

  // Threshold notifications (battery-style: low remaining triggers alert).
  // disconnected는 "데이터 없음" 의미라 마지막 값 기반 알림 발사를 차단.
  useEffect(() => {
    if (!snap) return;
    if (d.petState === "disconnected") return;
    for (const [t] of REMAINING_THRESHOLDS) {
      if (d.fiveHourRemaining <= t) {
        const pct = Math.round(d.fiveHourRemaining * 100);
        maybeNotify({
          key: `5h-${t}`,
          title: t === 0 ? `5시간 토큰 소진` : `5시간 토큰 ${pct}% 남음`,
          body:
            t === 0
              ? `5시간 윈도우가 리셋될 때까지 사용 불가입니다.`
              : `여유 있게 쓰려면 곧 속도를 늦춰주세요.`,
        });
      }
      if (d.weeklyRemaining <= t) {
        const pct = Math.round(d.weeklyRemaining * 100);
        maybeNotify({
          key: `weekly-${t}`,
          title: t === 0 ? `주간 토큰 소진` : `주간 토큰 ${pct}% 남음`,
          body:
            t === 0
              ? `주간 윈도우가 리셋될 때까지 사용 불가입니다.`
              : `이번 주 남은 토큰이 ${pct}% 입니다.`,
        });
      }
    }
    if (snap.last_request_at) {
      const elapsed = Date.parse(snap.now) - Date.parse(snap.last_request_at);
      if (elapsed > 5 * 3600_000) resetThreshold("5h-");
    }
  }, [d.fiveHourRemaining, d.weeklyRemaining, d.petState, snap]);

  const skin = findSkin(config.skin);

  // Prefer a motion gif for the current action if the skin provides one.
  // The static frame always tracks the current pet state (energy tier) —
  // idle actions overlay CSS animation only, never swap to a different
  // tier's PNG, so the panda never visually jumps tier mid-action.
  const characterSrc = (() => {
    if (idleAction !== "none") {
      const gif = skin.actions?.[idleAction as ActionName];
      if (gif) return gif;
    }
    return skin.frames[d.petState];
  })();

  // Track image-load failure as React state instead of mutating inline
  // styles in onError. The previous approach set opacity:0 on error and
  // never restored it, so a single transient load failure (e.g. during
  // re-render after a click on the tauri drag region) made the panda
  // disappear permanently. Resetting on src change keeps it self-healing.
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    setImgFailed(false);
  }, [characterSrc]);

  const showCache =
    d.cacheRemainMs !== null && !(snap?.is_thinking ?? false);

  // Drag uses Tauri's native data-tauri-drag-region — macOS handles
  // click-vs-drag at the OS layer. Manual refresh is now exclusively a
  // right-click on the panda (or the tray menu's "지금 새로고침").
  const triggerRefresh = () => {
    setRefreshing(true);
    invoke("refresh_usage").catch(() => {});
    window.setTimeout(() => setRefreshing(false), 700);
  };

  return (
    <div className="pet-root">
      <div className="bubble-stack" data-tauri-drag-region>
        {showCache && (
          <CacheBubble
            remainMs={d.cacheRemainMs!}
            nudge={d.cacheNudge}
            hits={snap!.cache_hits_5min}
            misses={snap!.cache_misses_5min}
            combo={snap!.current_combo}
          />
        )}
        {snap?.is_thinking && <ThinkingBubble />}
        {snap && (
          <UsageBubble
            fiveRemaining={d.petState === "disconnected" ? 0 : d.fiveHourRemaining}
            weeklyRemaining={d.petState === "disconnected" ? 0 : d.weeklyRemaining}
            fiveResetMs={d.petState === "disconnected" ? null : d.fiveHourResetMs}
            weeklyResetMs={d.petState === "disconnected" ? null : d.weeklyResetMs}
          />
        )}
      </div>

      <div
        className="character"
        data-state={d.petState}
        data-action={idleAction}
        data-flash={flash ?? ""}
        data-refreshing={refreshing ? "true" : ""}
        data-tauri-drag-region
        onContextMenu={(e) => {
          // Right-click on the panda = manual refresh. preventDefault
          // suppresses any browser/webview context menu so only the
          // refresh ping is visible.
          e.preventDefault();
          triggerRefresh();
        }}
      >
        <img
          src={characterSrc}
          alt={d.petState}
          draggable={false}
          style={imgFailed ? { opacity: 0 } : undefined}
          onError={() => setImgFailed(true)}
          onLoad={() => setImgFailed(false)}
        />
        {d.petState === "disconnected" && (
          <img
            className="disconnected-sign"
            src={ACCESSORIES.disconnectedSign}
            alt="연결 실패"
            draggable={false}
          />
        )}
        {idleAction === "scratch" && d.petState !== "sleepy" && (
          <img className="bamboo bamboo-scratch" src={ACCESSORIES.bamboo} alt="" draggable={false} />
        )}
        {idleAction === "run" && (
          <div className="wind-streaks" aria-hidden>
            <span className="streak streak-1" />
            <span className="streak streak-2" />
            <span className="streak streak-3" />
          </div>
        )}
        {idleAction === "jump" && <div className="jump-shadow" aria-hidden />}
        {idleAction === "squish" && <div className="squish-impact" aria-hidden />}
        {flash === "hit" && (
          <div className="firework" aria-hidden>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <span key={i} className={`spark spark-${i}`} />
            ))}
          </div>
        )}
        {flash === "miss" && (
          <div className="rain" aria-hidden>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((i) => (
              <span key={i} className={`drop drop-${i}`} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CacheBubble({
  remainMs,
  nudge,
  hits,
  misses,
  combo,
}: {
  remainMs: number;
  nudge: boolean;
  hits: number;
  misses: number;
  combo: number;
}) {
  const pct = Math.max(0, Math.min(1, remainMs / CACHE_TTL_MS));
  return (
    <div className={`bubble cache ${nudge ? "nudge" : ""}`} data-tauri-drag-region>
      <div className="bubble-row" data-tauri-drag-region>
        <span className="bubble-time">{formatRemain(remainMs)}</span>
        <span className="bubble-label">캐시</span>
      </div>
      <div className="bubble-bar">
        <div className="bubble-fill" style={{ width: `${pct * 100}%` }} />
      </div>
      {(hits > 0 || misses > 0) && (
        <div className="bubble-stats">
          <span className="stat hit">✨{hits}</span>
          <span className="stat miss">💨{misses}</span>
          {combo >= 2 && <span className="stat combo">🔥×{combo}</span>}
        </div>
      )}
      {nudge && <div className="bubble-tip">. 이라도 눌러!</div>}
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div className="bubble thinking" data-tauri-drag-region>
      <span className="dots" data-tauri-drag-region>
        <span/><span/><span/>
      </span>
      <span className="thinking-label" data-tauri-drag-region>생각 중</span>
    </div>
  );
}

function UsageBubble({
  fiveRemaining,
  weeklyRemaining,
  fiveResetMs,
  weeklyResetMs,
}: {
  fiveRemaining: number;
  weeklyRemaining: number;
  fiveResetMs: number | null;
  weeklyResetMs: number | null;
}) {
  return (
    <div className="bubble usage" data-tauri-drag-region>
      <div className="usage-row" data-tauri-drag-region>
        <span className="usage-label" data-tauri-drag-region>5h</span>
        <span
          className={`usage-pct ${toneOf(fiveRemaining)}`}
          data-tauri-drag-region
        >
          {pad(Math.round(fiveRemaining * 100))}%
        </span>
        <span className="usage-reset" data-tauri-drag-region>
          {fiveResetMs !== null ? formatResetCountdown(fiveResetMs) : "—"}
        </span>
      </div>
      <div className="usage-row" data-tauri-drag-region>
        <span className="usage-label" data-tauri-drag-region>주간</span>
        <span
          className={`usage-pct ${toneOf(weeklyRemaining)}`}
          data-tauri-drag-region
        >
          {pad(Math.round(weeklyRemaining * 100))}%
        </span>
        <span className="usage-reset" data-tauri-drag-region>
          {weeklyResetMs !== null ? formatResetCountdown(weeklyResetMs) : "—"}
        </span>
      </div>
    </div>
  );
}

function pad(n: number) {
  return n < 10 ? `  ${n}` : n < 100 ? ` ${n}` : `${n}`;
}

function toneOf(remaining: number) {
  if (remaining <= 0) return "danger";
  if (remaining <= 0.3) return "warn";
  return "ok";
}

function Settings({
  config,
  apiConfig,
  snap,
  onClose,
  onSave,
  onApiSave,
}: {
  config: PlanConfig;
  apiConfig: ApiConfig | null;
  snap: UsageSnapshot | null;
  onClose: () => void;
  onSave: (c: PlanConfig) => void;
  onApiSave: (a: ApiConfig | null) => void;
}) {
  const [skin, setSkin] = useState(config.skin);
  const apiActive = !!snap?.api && Date.now() - Date.parse(snap.api.fetched_at) < 2 * 60 * 1000;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <h2>설정</h2>
        <div className="skin-picker">
          <span className="skin-picker-label">캐릭터</span>
          <div className="skin-grid">
            {SKINS.map((s) => (
              <button
                type="button"
                key={s.id}
                className={`skin-tile ${skin === s.id ? "selected" : ""}`}
                onClick={() => setSkin(s.id)}
                title={s.name}
              >
                <img src={s.frames.good} alt={s.name} />
                <span>{s.name}</span>
              </button>
            ))}
          </div>
        </div>

        <ApiSection
          apiConfig={apiConfig}
          apiActive={apiActive}
          apiError={snap?.api_error ?? null}
          onSave={onApiSave}
        />

        <div className="settings-actions">
          <button onClick={onClose}>취소</button>
          <button
            className="primary"
            onClick={() =>
              onSave({
                plan: config.plan,
                limits: config.limits,
                skin,
              })
            }
          >
            저장
          </button>
        </div>
      </div>
    </div>
  );
}

function ApiSection({
  apiConfig,
  apiActive,
  apiError,
  onSave,
}: {
  apiConfig: ApiConfig | null;
  apiActive: boolean;
  apiError: string | null;
  onSave: (a: ApiConfig | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [orgId, setOrgId] = useState(apiConfig?.orgId ?? "");
  const [cookie, setCookie] = useState(apiConfig?.cookie ?? "");
  const [testStatus, setTestStatus] = useState<string>("");
  const [showHelp, setShowHelp] = useState(false);

  const test = async () => {
    setTestStatus("테스트 중...");
    try {
      const res = await invoke<{ five_hour_pct: number; weekly_pct: number }>(
        "test_api_config",
        { orgId: orgId.trim(), cookie: cookie.trim() },
      );
      setTestStatus(
        `✓ 5h ${res.five_hour_pct.toFixed(0)}%, 주간 ${res.weekly_pct.toFixed(0)}%`,
      );
    } catch (e: unknown) {
      setTestStatus(`✗ ${String(e)}`);
    }
  };

  return (
    <div className="api-section">
      <div className="api-section-head">
        <button
          className="link"
          type="button"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "API 연동 닫기" : "API 연동"}
        </button>
        <button
          type="button"
          className="help-bell-btn"
          onClick={() => setShowHelp((v) => !v)}
          aria-label="API 연동 설명 보기"
          title="어떻게 연결되는지 보기"
        >
          <span className="bell-icon" aria-hidden="true">🔔</span>
          <span className="bell-text">어떻게 연결되나요?</span>
        </button>
      </div>
      {showHelp && (
        <div className="api-help-popup" role="note">
          <div className="cookie-flow" aria-hidden="true">
            <div className="cookie-flow-step">
              <span className="cookie-flow-icon">🌐</span>
              <span className="cookie-flow-label">claude.ai</span>
            </div>
            <span className="cookie-flow-arrow">→</span>
            <div className="cookie-flow-step">
              <span className="cookie-flow-icon">🍪</span>
              <span className="cookie-flow-label">쿠키 5개</span>
            </div>
            <span className="cookie-flow-arrow">→</span>
            <div className="cookie-flow-step">
              <span className="cookie-flow-icon">🐼</span>
              <span className="cookie-flow-label">이 앱</span>
            </div>
          </div>
          <p>
            🔒 <strong>이 컴퓨터 안에서만 돌아가요.</strong> Org ID와 쿠키는
            macOS 사용자 폴더의 설정 파일
            (<code>~/Library/Application Support/com.tnew.clauddeskpet/</code>) 한 곳에만 저장되고,
            앱이 직접 <code>claude.ai/api/.../usage</code>를 30초마다 호출해 사용량을 가져옵니다.
            <strong>외부 서버·분석 도구·텔레메트리 어디에도 전송하지 않아요.</strong>
            "연동 해제"를 누르면 저장된 값은 즉시 지워집니다.
          </p>
          <p>
            ⚠️ 단, 이 쿠키는 claude.ai 세션 전체 권한을 가지므로
            <strong>다른 사람에게 보내거나 공용 컴퓨터에 두지 마세요.</strong>
            의심스러운 곳에 붙여 넣지도 마시고요.
          </p>
          <p>
            쿠키가 만료되거나 무효해지면 (HTTP 401·403·404) 다음 폴링에서 감지해
            <strong> 이 설정 창이 자동으로 다시 열립니다.</strong> 그때 claude.ai에서 새 쿠키를 복사해 붙여넣으면 돼요.
          </p>
          <p>
            쿠키는 claude.ai/settings/usage의 개발자도구 → Network → <code>usage</code> 요청 →
            Request Headers의 <code>cookie</code> 줄 전체를 그대로 붙여넣으면 됩니다.
            필요한 키 5개(<code>sessionKey</code>, <code>cf_clearance</code>, <code>__cf_bm</code>, <code>_cfuvid</code>, <code>routingHint</code>)만 사용하고 나머지는 무시돼요.
          </p>
        </div>
      )}
      {apiActive && !open && (
        <p className="api-note ok">
          ✓ Anthropic API에서 실시간 사용량을 받고 있어요.
        </p>
      )}
      {apiError && !open && (
        <p className="api-note err">⚠ API 오류: {apiError}</p>
      )}
      {open && (
        <div className="api-form">
          <label>
            Organization ID
            <input
              type="text"
              placeholder="63e058d5-142c-4368-bca3-39d64d78b4f5"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label>
            세션 쿠키 (5개만)
            <textarea
              placeholder="sessionKey=sk-ant-sid02-...; cf_clearance=...; __cf_bm=...; _cfuvid=...; routingHint=[sk-ant-rh-...]"
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              rows={4}
              spellCheck={false}
            />
          </label>
          <div className="api-actions">
            <button type="button" onClick={test}>
              테스트
            </button>
            <button
              type="button"
              className="primary slim"
              onClick={() => {
                if (orgId.trim() && cookie.trim()) {
                  onSave({ orgId: orgId.trim(), cookie: cookie.trim() });
                  setTestStatus("저장됨");
                }
              }}
            >
              저장
            </button>
            {apiConfig && (
              <button
                type="button"
                onClick={() => {
                  onSave(null);
                  setOrgId("");
                  setCookie("");
                  setTestStatus("연동 해제됨");
                }}
              >
                연동 해제
              </button>
            )}
          </div>
          {testStatus && <p className="api-status">{testStatus}</p>}
        </div>
      )}
    </div>
  );
}

