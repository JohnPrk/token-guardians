import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  Account,
  AccountsConfig,
  PetState,
  PlanConfig,
  SessionInfo,
  TrayMode,
  UsageSnapshot,
} from "./types";
import { PLAN_PRESETS } from "./types";
import {
  cryptoRandomId,
  loadAccountsConfig,
  loadPlanConfig,
  saveAccountsConfig,
  savePlanConfig,
} from "./store";
import { ACCESSORIES, DEFAULT_SKIN_ID, SKINS, findSkin, type ActionName } from "./skins";
import { CHANGELOG, entriesNewerThan } from "./changelog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import {
  PET_SCALE_DEFAULT,
  clampScale,
  computeSessionTimer,
  derive,
  formatResetCountdown,
  formatTrayLabel,
  hashHue,
  scaleFromDrag,
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

// 계정 묶음(특히 활성 계정) 변경을 한 트랜잭션으로 처리하는 헬퍼.
// 호출처: 트레이 메뉴, 설정 창의 계정 카드 클릭/추가/삭제.
// 1) AccountsConfig 저장
// 2) 활성 계정의 자격증명/skin을 Rust로 푸시
// 3) PlanConfig.skin을 활성 계정의 skinId로 동기화 (Pet 컴포넌트가 여기서 그림)
// 4) 트레이 메뉴 라벨/체크 표시 리빌드
// 5) 즉시 새 자격증명으로 polling 한 번 (refresh_usage)
// 6) `config-changed` emit → 메인 펫 윈도우가 새 plan 다시 읽음
async function switchActiveAccount(next: AccountsConfig): Promise<void> {
  await saveAccountsConfig(next);
  const active = next.accounts.find((a) => a.id === next.activeAccountId);
  if (active) {
    const plan = await loadPlanConfig();
    if (!plan || plan.skin !== active.skinId) {
      const synced: PlanConfig = plan
        ? { ...plan, skin: active.skinId }
        : { plan: "max5x", limits: PLAN_PRESETS.max5x, skin: active.skinId };
      await savePlanConfig(synced);
    }
    await invoke("set_api_config", {
      orgId: active.orgId,
      cookie: active.cookie,
      platformOrgId: active.platformOrgId ?? null,
      platformCookie: active.platformCookie ?? null,
    }).catch(() => {});
    await invoke("set_active_skin", { skinId: active.skinId }).catch(() => {});
    await invoke("refresh_usage").catch(() => {});
  } else {
    await invoke("set_api_config", {
      orgId: null,
      cookie: null,
      platformOrgId: null,
      platformCookie: null,
    }).catch(() => {});
  }
  await invoke("update_tray_accounts", {
    accounts: next.accounts.map((a) => ({ id: a.id, label: a.label })),
    activeId: next.activeAccountId,
  }).catch(() => {});
  await emit("config-changed");
}

// 각 창은 자기 전용 HTML 진입점을 로드한다 (멀티페이지):
//   index.html      → main.tsx          → <PetApp/>      (펫 패널, 라벨 "main")
//   settings.html   → settings-main.tsx → <SettingsApp/> (라벨 "settings")
//   onboarding.html → onboarding-main.tsx→ <OnboardingApp/> (라벨 "onboarding")
//   preview.html    → preview-main.tsx  → <AnimPreviewApp/> (개발용 애니 프리뷰)
//
// 과거엔 세 창이 같은 index.html 하나를 로드하고 런타임에 `__TAURI_VIEW_LABEL__`/
// 윈도우 라벨/URL hash 로 자기가 누구인지 추측해 컴포넌트를 골랐는데, WebView2 에서
// 그 추측이 주입 레이스·URL 인코딩으로 반복적으로 깨져 v1.74.x 내내 회귀가 났다.
// 진입점을 분리하면 추측 자체가 사라져 양 OS / dev / release 에서 결정적으로 동작한다.

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

export function AnimPreviewApp() {
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

const SKIN_GRID_STATES: PetState[] = [
  "full",
  "high",
  "good",
  "mid",
  "low",
  "tired",
  "sleepy",
  "dead",
  "disconnected",
];

export function SkinGridApp() {
  const [skinId, setSkinId] = useState(SKINS[SKINS.length - 1]?.id ?? DEFAULT_SKIN_ID);
  const [bg, setBg] = useState<"checker" | "white" | "dark">("checker");
  const [showGuide, setShowGuide] = useState(true);
  const skin = findSkin(skinId);

  const bgStyle: React.CSSProperties =
    bg === "checker"
      ? {
          backgroundImage:
            "linear-gradient(45deg, #2a2a2a 25%, transparent 25%), linear-gradient(-45deg, #2a2a2a 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #2a2a2a 75%), linear-gradient(-45deg, transparent 75%, #2a2a2a 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
          backgroundColor: "#1f1f1f",
        }
      : bg === "white"
        ? { backgroundColor: "#ffffff" }
        : { backgroundColor: "#0a0a0a" };

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: 16,
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
        background: "#1a1a1a",
        color: "#eee",
      }}
    >
      <header
        style={{
          display: "flex",
          gap: 16,
          alignItems: "center",
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 18 }}>Skin Grid</h1>
        <label>
          스킨{" "}
          <select value={skinId} onChange={(e) => setSkinId(e.target.value)}>
            {SKINS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          배경{" "}
          <select value={bg} onChange={(e) => setBg(e.target.value as "checker" | "white" | "dark")}>
            <option value="checker">체크무늬</option>
            <option value="white">흰색</option>
            <option value="dark">어두움</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={showGuide}
            onChange={(e) => setShowGuide(e.target.checked)}
          />{" "}
          중심선·바닥선
        </label>
        <span style={{ marginLeft: "auto", opacity: 0.6, fontSize: 12 }}>
          objectFit: contain — 원본 PNG 그대로 비례 유지
        </span>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
          gap: 12,
        }}
      >
        {SKIN_GRID_STATES.map((state) => (
          <div key={state} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div
              style={{
                position: "relative",
                width: "100%",
                aspectRatio: "1 / 1",
                ...bgStyle,
                border: "1px solid #333",
                overflow: "hidden",
              }}
            >
              <img
                src={skin.frames[state]}
                alt={state}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  display: "block",
                }}
                draggable={false}
              />
              {showGuide && (
                <>
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      left: "50%",
                      width: 1,
                      background: "rgba(255, 0, 100, 0.5)",
                      pointerEvents: "none",
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      bottom: "1.25%",
                      height: 1,
                      background: "rgba(0, 200, 255, 0.5)",
                      pointerEvents: "none",
                    }}
                  />
                </>
              )}
            </div>
            <div style={{ textAlign: "center", fontSize: 12, opacity: 0.85 }}>{state}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PetApp() {
  // store IPC(plugin-store load)가 Windows WebView2에서 끝내 응답하지 않아도
  // 펫이 무조건 보이도록 기본 설정으로 즉시 렌더하고, store가 resolve되면 실제
  // 설정으로 갱신한다. 옛 구조는 loading 게이트로 null을 그리다 store hang 시
  // 영구 흰 화면이 됐고(메인 펫 윈도우는 라우팅과 무관하게 항상 PetApp), 그게
  // v1.74.1~.3 라우팅 수정과 별개인 흰 화면의 본 원인이었다.
  const [config, setConfig] = useState<PlanConfig>({
    plan: "max5x",
    limits: PLAN_PRESETS.max5x,
    skin: DEFAULT_SKIN_ID,
  });
  // v1.70 펫 zoom 배율. PlanConfig.petScale 로 영속화. 드래그 중에는 setScale 만
  // 호출해 즉시 시각 반영하고, pointerup 시점에 savePlanConfig 한 번 호출(드래그
  // 폭주 방지). disconnected 상태나 ResizeObserver 발화는 scale 변화의 자연
  // 부산물로만 일어남.
  const [scale, setScale] = useState<number>(PET_SCALE_DEFAULT);

  useEffect(() => {
    let settled = false;

    // 첫 설정 화면(온보딩) 안전망: loadPlanConfig/loadAccountsConfig가 Windows
    // WebView2에서 끝내 응답하지 않아도, 2초 안에 init이 settle 안 되면 온보딩을
    // 띄운다. 펫 본체는 기본 config로 이미 렌더돼 있으므로 여기선 온보딩만.
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      invoke("open_onboarding_window").catch(() => {});
    }, 2000);

    Promise.all([loadPlanConfig(), loadAccountsConfig()])
      .then(([planCfg, accCfg]) => {
        settled = true;
        clearTimeout(guard);

        const active = accCfg.accounts.find(
          (a) => a.id === accCfg.activeAccountId,
        );

        // 활성 계정이 있으면 그 자격증명을 Rust로 푸시 + skin/트레이 메뉴 동기화.
        // 활성 캐릭터는 PlanConfig.skin과 항상 같아야 한다 (Pet 컴포넌트가
        // config.skin을 그린다). 첫 부팅이거나 계정이 비었으면 온보딩 창을 띄운다.
        if (active) {
          const synced: PlanConfig = planCfg
            ? { ...planCfg, skin: active.skinId }
            : { plan: "max5x", limits: PLAN_PRESETS.max5x, skin: active.skinId };
          // 설정부터 반영 — 아래 invoke/save가 Windows에서 hang해도 펫은 이미 떠 있다.
          setConfig(synced);
          setScale(clampScale(synced.petScale ?? PET_SCALE_DEFAULT));

          invoke("set_api_config", {
            orgId: active.orgId,
            cookie: active.cookie,
            platformOrgId: active.platformOrgId ?? null,
            platformCookie: active.platformCookie ?? null,
          }).catch(() => {});
          invoke("set_active_skin", { skinId: active.skinId }).catch(() => {});
          invoke("update_tray_accounts", {
            accounts: accCfg.accounts.map((a) => ({ id: a.id, label: a.label })),
            activeId: active.id,
          }).catch(() => {});
          invoke("update_tray_mode", {
            mode: planCfg?.trayMode ?? "fivehour",
          }).catch(() => {});
          if (!planCfg || planCfg.skin !== active.skinId) {
            // await로 렌더를 막지 않도록 백그라운드 저장.
            savePlanConfig(synced).catch(() => {});
          }
          return;
        }

        // 계정이 비어 있는 첫 실행(또는 전부 삭제). 펫은 이미 기본 판다로 떠
        // 있으니, 저장된 plan이 있으면 반영하고 첫 계정을 만들도록 온보딩을 띄운다.
        if (planCfg) {
          setConfig(planCfg);
          setScale(clampScale(planCfg.petScale ?? PET_SCALE_DEFAULT));
        } else {
          savePlanConfig({
            plan: "max5x",
            limits: PLAN_PRESETS.max5x,
            skin: DEFAULT_SKIN_ID,
          }).catch(() => {});
        }
        invoke("update_tray_accounts", { accounts: [], activeId: null }).catch(
          () => {},
        );
        invoke("update_tray_mode", {
          mode: planCfg?.trayMode ?? "fivehour",
        }).catch(() => {});
        if (accCfg.accounts.length === 0) {
          invoke("open_onboarding_window").catch(() => {});
        }
      })
      .catch((e) => {
        // store load 자체가 reject해도 펫은 이미 떠 있고, 첫 설정을 받도록 온보딩.
        console.error("[pet] init failed:", e);
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        invoke("open_onboarding_window").catch(() => {});
      });

    return () => clearTimeout(guard);
  }, []);

  // 설정창 등 다른 윈도우가 PlanConfig 를 변경하면 petScale 도 다시 가져온다.
  useEffect(() => {
    const un = listen("config-changed", async () => {
      const cfg = await loadPlanConfig();
      if (cfg) setScale(clampScale(cfg.petScale ?? PET_SCALE_DEFAULT));
    });
    return () => {
      un.then((fn) => fn());
    };
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

  // 트레이 메뉴의 "계정 전환 ▸ 라벨" 항목 클릭 시 Rust가 계정 id를 던진다.
  // 이 핸들러가 실제 전환을 수행: AccountsConfig 갱신 → set_api_config /
  // set_active_skin 푸시 → 트레이 메뉴 리빌드 → PlanConfig.skin 동기화.
  // 메인 윈도우 어디에서든 받아 처리할 수 있어 PetApp 마운트 시 한 번만
  // 등록한다.
  useEffect(() => {
    const un = listen<string>("tray-switch-account", async (e) => {
      const targetId = e.payload;
      const accCfg = await loadAccountsConfig();
      if (!accCfg.accounts.some((a) => a.id === targetId)) return;
      const next: AccountsConfig = { ...accCfg, activeAccountId: targetId };
      await switchActiveAccount(next);
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // 트레이 메뉴 "표시 모드 ▸"에서 사용자가 선택한 mode를 받아 PlanConfig에 영구
  // 저장하고 React state에도 즉시 반영. set_tray_title useEffect의 deps에
  // config.trayMode가 들어있어 setConfig만 호출하면 라벨이 다음 tick에 다시
  // 그려지고, Rust 트레이 메뉴의 라디오 표시는 update_tray_mode로 동기화한다.
  useEffect(() => {
    const un = listen<TrayMode>("tray-set-mode", async (e) => {
      const mode = e.payload;
      const cur = await loadPlanConfig();
      const next: PlanConfig = cur
        ? { ...cur, trayMode: mode }
        : {
            plan: "max5x",
            limits: PLAN_PRESETS.max5x,
            skin: DEFAULT_SKIN_ID,
            trayMode: mode,
          };
      await savePlanConfig(next);
      setConfig(next);
      invoke("update_tray_mode", { mode }).catch(() => {});
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // Onboarding은 별도 윈도우(open_onboarding_window). 펫 패널은 항상 `config`로
  // 렌더 — config가 기본값으로 초기화돼 있어 첫 paint가 store IPC를 기다리지
  // 않는다(Windows에서 store가 hang해도 흰 화면이 안 됨).
  return (
    <Pet
      config={config}
      scale={scale}
      onScaleChange={setScale}
      onScaleCommit={async (next) => {
        setScale(next);
        const cur = await loadPlanConfig();
        const base: PlanConfig =
          cur ?? config ?? {
            plan: "max5x",
            limits: PLAN_PRESETS.max5x,
            skin: DEFAULT_SKIN_ID,
          };
        await savePlanConfig({ ...base, petScale: next });
      }}
    />
  );
}

// The settings popup is its own ordinary, decorated window. No panel
// pinning, no level juggling — text inputs work normally. It loads the
// shared config store, lets the user edit, and broadcasts
// `config-changed` so the pet window can re-read.
export function SettingsApp() {
  const [accounts, setAccounts] = useState<AccountsConfig | null>(null);
  const [snap, setSnap] = useState<UsageSnapshot | null>(null);

  useEffect(() => {
    let settled = false;
    // PetApp과 같은 안전망: loadAccountsConfig가 Windows에서 hang/reject해도
    // 설정 창이 흰 화면으로 멈추지 않도록, 2초 후 빈 계정 목록으로 렌더한다.
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      setAccounts((a) => a ?? { accounts: [], activeAccountId: null });
    }, 2000);
    Promise.all([
      loadAccountsConfig(),
      invoke<UsageSnapshot>("get_usage_snapshot").catch(() => null),
    ])
      .then(([acc, s]) => {
        settled = true;
        clearTimeout(guard);
        setAccounts(acc);
        if (s) setSnap(s);
      })
      .catch((e) => {
        console.error("[settings] init failed:", e);
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        setAccounts({ accounts: [], activeAccountId: null });
      });
    const un = listen<UsageSnapshot>("usage-update", (e) => setSnap(e.payload));
    return () => {
      clearTimeout(guard);
      un.then((fn) => fn());
    };
  }, []);

  if (!accounts) return null;

  const closeSelf = async () => {
    try {
      await getCurrentWindow().close();
    } catch {
      // best-effort
    }
  };

  // 모든 계정 변경(추가/삭제/활성 전환)을 한 경로로 모음.
  // switchActiveAccount가 저장+Rust 푸시+트레이 리빌드+config-changed emit까지 처리.
  const apply = async (next: AccountsConfig) => {
    await switchActiveAccount(next);
    setAccounts(next);
  };

  return (
    <div className="settings-window">
      <Settings
        accounts={accounts}
        snap={snap}
        onClose={closeSelf}
        onAccountsChange={apply}
      />
    </div>
  );
}

// First-launch welcome window — opens automatically (from PetApp's
// boot when no PlanConfig is saved) and walks the user through the
// two real choices the app needs: a character and the claude.ai
// session credentials. There's no plan selection anymore — quota %
// comes straight from claude.ai's API once the user pastes a cookie.
export function OnboardingApp() {
  const [skin, setSkin] = useState<string>(DEFAULT_SKIN_ID);
  const [label, setLabel] = useState("메인 계정");
  const [orgId, setOrgId] = useState("");
  const [cookie, setCookie] = useState("");
  const [testStatus, setTestStatus] = useState<string>("");
  const [step, setStep] = useState<1 | 2>(1);
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteValue, setPasteValue] = useState("");

  const autoCapture = async () => {
    setTestStatus("");
    setPasteValue("");
    setPasteMode(true);
    try {
      await invoke("open_claude_usage_in_browser");
    } catch (e) {
      setTestStatus(`브라우저 열기 실패: ${String(e)}`);
    }
  };

  const handlePasteValue = async (raw: string) => {
    setPasteValue(raw);
    if (!raw.includes("sessionKey=")) return;
    setTestStatus("Cookie 분석 중…");
    try {
      const res = await invoke<{ org_id: string; cookie: string }>(
        "auto_extract_from_cookie",
        { rawCookie: raw },
      );
      setOrgId(res.org_id);
      setCookie(res.cookie);
      setPasteMode(false);
      setPasteValue("");
      setTestStatus("자동으로 가져왔어요. 저장하고 시작하면 끝!");
    } catch (e) {
      setTestStatus(`자동 가져오기 실패: ${String(e)}`);
    }
  };

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
        `5h ${res.five_hour_pct.toFixed(0)}% · 주간 ${res.weekly_pct.toFixed(0)}%`,
      );
    } catch (e: unknown) {
      setTestStatus(String(e));
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
    // 자격증명을 채웠으면 첫 계정으로 등록, 아니면 빈 묶음으로 저장하고 종료.
    // PlanConfig는 활성 계정 skin과 동기화될 derived 값이라 여기서 같이 저장.
    if (orgId.trim() && cookie.trim()) {
      const acc: Account = {
        id: cryptoRandomId(),
        label: label.trim() || "메인 계정",
        orgId: orgId.trim(),
        cookie: cookie.trim(),
        skinId: skin,
      };
      const next: AccountsConfig = {
        accounts: [acc],
        activeAccountId: acc.id,
      };
      await switchActiveAccount(next);
    } else {
      // 건너뛰고 시작: plan만 저장하고 계정은 비워둠. 사용자가 설정에서 추가 가능.
      const planCfg: PlanConfig = {
        plan: "max5x",
        limits: PLAN_PRESETS.max5x,
        skin,
      };
      await savePlanConfig(planCfg);
      await emit("config-changed");
    }
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

            <div className="onboarding-auto">
              {!pasteMode ? (
                <>
                  <button type="button" className="primary" onClick={autoCapture}>
                    자동으로 가져오기
                  </button>
                  <p className="onboarding-auto-note">
                    누르면 Chrome으로 claude.ai/settings/usage 페이지가 열려요.
                    거기서 cookie 한 줄만 복사해서 아래 칸에 붙여넣으면 Org ID
                    + 쿠키가 자동으로 채워집니다. 직접 입력하려면 아래 ①②를 참고.
                  </p>
                </>
              ) : (
                <div className="paste-capture">
                  <div className="paste-capture-head">
                    <strong>Cookie 붙여넣기</strong>
                    <button
                      type="button"
                      className="paste-capture-close"
                      onClick={() => {
                        setPasteMode(false);
                        setPasteValue("");
                        setTestStatus("");
                      }}
                      aria-label="닫기"
                    >
                      ✕
                    </button>
                  </div>
                  <ol className="paste-capture-steps">
                    <li>방금 열린 Chrome 탭에서 <code>⌘⌥I</code> → Network 탭</li>
                    <li>목록의 <code>usage</code> 요청 클릭 → Headers → Request Headers의 <code>cookie:</code> 한 줄 복사</li>
                    <li>아래 칸에 ⌘V로 붙여넣기 (자동으로 처리됩니다)</li>
                  </ol>
                  <textarea
                    autoFocus
                    placeholder="sessionKey=sk-ant-sid02-...; cf_clearance=...; __cf_bm=...; _cfuvid=...; routingHint=[sk-ant-rh-...]"
                    value={pasteValue}
                    onChange={(e) => handlePasteValue(e.target.value)}
                    rows={4}
                    spellCheck={false}
                  />
                </div>
              )}
            </div>

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
              계정 이름 (이 컴퓨터에서만 보임)
              <input
                type="text"
                placeholder="메인 계정 / 회사 계정 / 서브 계정 …"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                spellCheck={false}
              />
            </label>
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

export function ChangelogApp() {
  const [ctx, setCtx] = useState<{ mode: "whatsnew" | "full"; sinceVersion: string | null }>({
    mode: "full",
    sinceVersion: null,
  });

  useEffect(() => {
    invoke<{ mode: "whatsnew" | "full"; sinceVersion: string | null }>("get_changelog_context")
      .then((c) => {
        if (c && (c.mode === "whatsnew" || c.mode === "full")) setCtx(c);
      })
      .catch(() => {
        // 컨텍스트를 못 받으면 전체 목록으로 폴백.
      });
    // 창이 살아 있는 동안 다시 열리면(예: 팝업 후 메뉴 클릭) main 이 모드를 다시 보냄.
    const un = listen<{ mode: "whatsnew" | "full"; sinceVersion: string | null }>(
      "changelog-context",
      (e) => {
        if (e.payload && (e.payload.mode === "whatsnew" || e.payload.mode === "full")) {
          setCtx(e.payload);
        }
      },
    );
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  const entries = useMemo(
    () => (ctx.mode === "whatsnew" ? entriesNewerThan(CHANGELOG, ctx.sinceVersion) : CHANGELOG),
    [ctx],
  );

  const closeSelf = async () => {
    try {
      await getCurrentWindow().close();
    } catch {
      // best-effort
    }
  };

  const isWhatsNew = ctx.mode === "whatsnew";

  return (
    <div className="changelog-window">
      <div className="changelog-card">
        <header className="changelog-header">
          {isWhatsNew ? (
            <>
              <span className="changelog-badge">새 버전으로 업데이트됐어요 🎋</span>
              <h1>이번 업데이트에서 바뀐 점</h1>
            </>
          ) : (
            <h1>업데이트 일지</h1>
          )}
        </header>

        {entries.length === 0 ? (
          <p className="changelog-empty">표시할 항목이 없어요.</p>
        ) : (
          <ol className="changelog-list">
            {entries.map((e) => (
              <li key={e.version} className="changelog-entry">
                {/* 제목만 보이는 접힘 상태가 기본. 팝업(whatsnew)에선 새 항목을 펼쳐서 보여줌. */}
                <details className="changelog-details" open={isWhatsNew}>
                  <summary className="changelog-summary">
                    <span className="changelog-title">{e.title}</span>
                    <span className="changelog-meta">
                      <span className="changelog-version">v{e.version}</span>
                      <span className="changelog-date">{e.date}</span>
                    </span>
                  </summary>
                  <div className="changelog-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
                      {e.body}
                    </ReactMarkdown>
                  </div>
                </details>
              </li>
            ))}
          </ol>
        )}

        <div className="changelog-footer">
          <button type="button" className="changelog-close" onClick={closeSelf}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}

function Pet({
  config,
  scale,
  onScaleChange,
  onScaleCommit,
}: {
  config: PlanConfig;
  scale: number;
  onScaleChange: (next: number) => void;
  onScaleCommit: (next: number) => void;
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

  // 펫 윈도우 드래그: main 프로세스가 OS 커서(screen.getCursorScreenPoint) 를
  // 폴링해서 직접 setPosition. renderer 는 pointerdown 에 start_pet_drag,
  // pointerup 에 end_pet_drag 만 호출 — PointerEvent.screenX/Y 의 윈도우-이동
  // 중 desync 회피 + 다중 디스플레이 workArea 합집합 clamp 는 main 이 담당.
  const draggingRef = useRef(false);
  const onPetPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // resize handle 은 별도 핸들러 — drag 신호 보내지 않음
    if (target.closest(".resize-handle")) return;
    draggingRef.current = true;
    target.setPointerCapture?.(e.pointerId);
    invoke("start_pet_drag").catch(() => {});
  };
  const onPetPointerMove = (_e: React.PointerEvent<HTMLDivElement>) => {
    // no-op — main 이 OS 커서 폴링으로 직접 윈도우 이동.
  };
  const onPetPointerUp = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    invoke("end_pet_drag").catch(() => {});
  };

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
  // 전부 표현하므로, 텍스트 라벨은 사용자가 메뉴 "표시 모드 ▸"에서 고른 형식대로
  // 송신한다. legacy store에 trayMode가 없으면 "fivehour" (v1.24까지의 동작).
  // mode === "all" 이고 prepaid 잔액이 있으면 라벨 끝에 `· $12.34` 합쳐짐.
  useEffect(() => {
    const five = d.petState === "disconnected" ? 0 : d.fiveHourRemaining;
    const weekly = d.petState === "disconnected" ? 0 : d.weeklyRemaining;
    const mode: TrayMode = config.trayMode ?? "fivehour";
    const prepaid =
      d.petState === "disconnected" ? null : snap?.prepaid?.dollars ?? null;
    const title = formatTrayLabel(mode, five, weekly, prepaid);
    invoke("set_tray_title", { title }).catch(() => {});
    invoke("set_tray_icon_for_remaining", { remaining: five }).catch(() => {});
  }, [
    d.fiveHourRemaining,
    d.weeklyRemaining,
    d.petState,
    config.trayMode,
    snap?.prepaid?.dollars,
  ]);

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

  // Drag uses Tauri's native data-tauri-drag-region — macOS handles
  // click-vs-drag at the OS layer. Manual refresh is now exclusively a
  // right-click on the panda (or the tray menu's "지금 새로고침").
  const triggerRefresh = () => {
    setRefreshing(true);
    invoke("refresh_usage").catch(() => {});
    window.setTimeout(() => setRefreshing(false), 700);
  };

  // v1.26부터 cache 거품 자리는 SessionStack의 카드 stack이 대체한다 — 카드 각각이
  // 자기 세션의 5분 카운트다운을 갖고 있으므로 cache 거품은 중복. 정의는 남겨두되
  // 호출은 제거. (CacheBubble 컴포넌트가 미사용이지만 hit/miss flash와 콤보 정보를
  // 다시 보고 싶을 때 살리기 쉽게 정의는 유지.)

  // v1.49 동적 윈도우 resize + v1.70 zoom 통합. webkit 의 CSS `zoom` 은
  // layout box 를 같이 안 바꿔서 ResizeObserver 가 zoom 변화에 발화하지
  // 못한다(2026-05-18 사용자 재보고로 확정). 그래서 두 wrapper 구조로:
  //   .pet-content       — 명시적 width/height = inner × scale, 윈도우 크기 기준
  //   .pet-content-inner — transform: scale 으로 시각 표현 (layout 영향 X)
  // ResizeObserver 는 *unscaled* inner 를 측정 → innerSize state. scale 또는
  // innerSize 가 변할 때 useEffect 가 invoke 를 강제 트리거. 핸들은 .pet-root
  // 자식이라 scale 영향을 받지 않고 화면 우하단에 고정.
  const petContentRef = useRef<HTMLDivElement | null>(null);
  const petInnerRef = useRef<HTMLDivElement | null>(null);
  const [innerSize, setInnerSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });
  useEffect(() => {
    const inner = petInnerRef.current;
    if (!inner) return;
    const ro = new ResizeObserver(() => {
      // offsetWidth/Height 는 layout box(=transform 적용 *전*) 크기.
      // getBoundingClientRect 는 transform 후 시각 크기라 scale 곱셈이
      // 제곱돼버림(2026-05-18 사용자 보고 "더 이상해졌어"의 원인). 항상
      // offset* 으로 unscaled 측정.
      const w = inner.offsetWidth;
      const h = inner.offsetHeight;
      setInnerSize((prev) => {
        if (Math.abs(prev.w - w) < 2 && Math.abs(prev.h - h) < 2) return prev;
        return { w, h };
      });
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  // scale 또는 innerSize 가 변하면 윈도우 크기 강제 갱신. ResizeObserver 가
  // zoom 변화에 발화 못 해도 이 흐름이 백업으로 동작. 16px 는 .pet-root padding.
  useEffect(() => {
    if (innerSize.w === 0 || innerSize.h === 0) return;
    const PAD = 16;
    const w = Math.ceil(innerSize.w * scale) + PAD;
    const h = Math.ceil(innerSize.h * scale) + PAD;
    invoke("resize_pet_window", { width: w, height: h }).catch(() => {});
  }, [scale, innerSize.w, innerSize.h]);

  // v1.70 resize handle 드래그 흐름. pointerdown 시 시작 좌표 + 시작 scale 을
  // 캡처하고, pointermove 마다 합 delta(dx+dy)로 새 scale 을 계산 후
  // onScaleChange 즉시 호출(시각 반영). pointerup 에서 onScaleCommit 한 번 호출해
  // store 에 저장. setPointerCapture 로 다른 영역으로 빠져나가도 추적 유지.
  const dragRef = useRef<{ startX: number; startY: number; startScale: number } | null>(
    null,
  );
  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, startScale: scale };
  };
  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    onScaleChange(scaleFromDrag(d.startScale, dx + dy));
  };
  const onHandlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const next = scaleFromDrag(d.startScale, dx + dy);
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    onScaleCommit(next);
  };

  // .pet-content 의 외곽 박스 크기(scale 곱한 값). innerSize 가 아직 0 이면
  // 첫 측정 직전이라 'auto' 로 두어 자연스럽게 fit. 측정 들어오면 명시적 px.
  const outerStyle: React.CSSProperties =
    innerSize.w > 0 && innerSize.h > 0
      ? { width: `${innerSize.w * scale}px`, height: `${innerSize.h * scale}px` }
      : {};

  return (
    <div
      className="pet-root"
      onPointerDown={onPetPointerDown}
      onPointerMove={onPetPointerMove}
      onPointerUp={onPetPointerUp}
      onPointerCancel={onPetPointerUp}
    >
      <div className="pet-content" ref={petContentRef} style={outerStyle}>
        <div
          className="pet-content-inner"
          ref={petInnerRef}
          style={{
            transform: scale === 1 ? undefined : `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
      <SessionStack sessions={snap?.active_sessions ?? []} now={now} />
      <div className="bubble-stack" data-tauri-drag-region>
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
        data-skin={skin.id}
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
        {/* resize 핸들 — .pet-content-inner 의 자식. 위치는 inner 우하단(= 캐릭터
            발 옆) 이라 펫 따라 자연스럽게 이동하지만, counter-scale(1/scale + bottom right
            origin)로 크기는 항상 일정. 2026-05-18 사용자 정정 두 번 반영. */}
        <div
          className="resize-handle"
          title="드래그해서 펫 크기 조정"
          aria-label="resize"
          style={{
            transform: scale === 1 ? undefined : `scale(${1 / scale})`,
            transformOrigin: "bottom right",
          }}
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerUp}
        >
          <span className="resize-icon" aria-hidden>↘</span>
        </div>
        </div>
      </div>
    </div>
  );
}

// 활성 세션(마지막 assistant 응답이 5분 이내) 카드 stack. Rust 쪽 snapshot의
// active_sessions를 그대로 받아 펫 윈도우 위쪽에 위에서 아래로 쌓는다. 0개면
// 아무것도 그리지 않고, 1개여도 카드 1장을 띄운다 (사용자 명시).
function SessionStack({
  sessions,
  now,
}: {
  sessions: SessionInfo[];
  now: number;
}) {
  if (sessions.length === 0) return null;
  return (
    <div className="session-stack" data-tauri-drag-region>
      {sessions.map((s) => (
        <SessionCard key={s.session_id} session={s} now={now} />
      ))}
    </div>
  );
}

// 카드 1개: 최근 user prompt 요약 + 남은 시간 + 카드 하단 진행 바.
// 진행 바는 width 100% → 0%로 감소 (5분 → 0초). 카드 hue는 session_id 해시.
function SessionCard({
  session,
  now,
}: {
  session: SessionInfo;
  now: number;
}) {
  const timer = computeSessionTimer(session.last_assistant_at, now);
  const hue = hashHue(session.session_id);
  return (
    <div
      className={`session-card${timer.expired ? " session-card--expired" : ""}`}
      style={{ "--session-hue": String(hue) } as React.CSSProperties}
      data-tauri-drag-region
    >
      <div className="session-card-row" data-tauri-drag-region>
        <span className="session-prompt" title={session.last_user_prompt} data-tauri-drag-region>
          {session.last_user_prompt}
        </span>
        <span className="session-timer" data-tauri-drag-region>{timer.label}</span>
      </div>
      <div className="session-gauge" data-tauri-drag-region>
        <div className="session-gauge-fill" style={{ width: `${timer.pct}%` }} data-tauri-drag-region />
      </div>
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
  accounts,
  snap,
  onClose,
  onAccountsChange,
}: {
  accounts: AccountsConfig;
  snap: UsageSnapshot | null;
  onClose: () => void;
  onAccountsChange: (next: AccountsConfig) => Promise<void> | void;
}) {
  const apiActive =
    !!snap?.api && Date.now() - Date.parse(snap.api.fetched_at) < 2 * 60 * 1000;
  const apiError = snap?.api_error ?? null;
  // 폼 모드: null = 닫힘, "new" = 새 계정 추가, "<id>" = 그 계정 편집.
  const [formMode, setFormMode] = useState<null | "new" | string>(null);
  const [showHelp, setShowHelp] = useState(false);

  const setActive = async (id: string) => {
    if (id === accounts.activeAccountId) return;
    await onAccountsChange({ ...accounts, activeAccountId: id });
  };

  const removeAccount = async (id: string) => {
    const remaining = accounts.accounts.filter((a) => a.id !== id);
    let nextActive = accounts.activeAccountId;
    if (id === accounts.activeAccountId) {
      // 활성 계정 삭제 시 남은 첫 번째 계정으로 자동 활성화. 0개면 null.
      nextActive = remaining[0]?.id ?? null;
    }
    await onAccountsChange({
      accounts: remaining,
      activeAccountId: nextActive,
    });
    if (formMode === id) setFormMode(null);
  };

  const addAccount = async (acc: Account) => {
    const next: AccountsConfig = {
      accounts: [...accounts.accounts, acc],
      // 첫 계정이면 자동으로 활성. 아니면 기존 활성 유지(사용자가 카드 클릭으로 전환).
      activeAccountId: accounts.activeAccountId ?? acc.id,
    };
    await onAccountsChange(next);
    setFormMode(null);
  };

  const updateAccount = async (acc: Account) => {
    // id를 키로 자리 교체. 활성 계정의 자격증명/skin이 바뀌었으면
    // switchActiveAccount 헬퍼가 set_api_config·set_active_skin·트레이 메뉴
    // 갱신까지 한 번에 처리한다 (onAccountsChange 경유).
    const next: AccountsConfig = {
      accounts: accounts.accounts.map((a) => (a.id === acc.id ? acc : a)),
      activeAccountId: accounts.activeAccountId,
    };
    await onAccountsChange(next);
    setFormMode(null);
  };

  const activeAccount = accounts.accounts.find(
    (a) => a.id === accounts.activeAccountId,
  );

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <h2>설정</h2>

        <div className="accounts-section">
          <div className="accounts-head">
            <span className="accounts-label">계정</span>
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

          {showHelp && <ApiHelpPopup />}

          {activeAccount && apiActive && (
            <p className="api-note ok">
              <strong>{activeAccount.label}</strong>에서 실시간 사용량을
              받고 있어요.
            </p>
          )}
          {activeAccount && apiError && (
            <p className="api-note err">API 오류: {apiError}</p>
          )}
          {!activeAccount && accounts.accounts.length === 0 && (
            <p className="api-note">
              아직 등록된 계정이 없어요. 아래 <strong>+ 새 계정</strong>에서
              추가하세요.
            </p>
          )}

          <div className="account-grid">
            {accounts.accounts.map((acc) => (
              <AccountCard
                key={acc.id}
                account={acc}
                active={acc.id === accounts.activeAccountId}
                editing={formMode === acc.id}
                onActivate={() => setActive(acc.id)}
                onRemove={() => removeAccount(acc.id)}
                onEdit={() =>
                  setFormMode(formMode === acc.id ? null : acc.id)
                }
              />
            ))}
            <button
              type="button"
              className={`account-tile add ${formMode === "new" ? "selected" : ""}`}
              onClick={() => setFormMode(formMode === "new" ? null : "new")}
            >
              <span className="account-tile-plus">+</span>
              <span>새 계정</span>
            </button>
          </div>

          {formMode === "new" && (
            <AccountForm
              mode="new"
              existingLabels={accounts.accounts.map((a) => a.label)}
              onCancel={() => setFormMode(null)}
              onSubmit={addAccount}
            />
          )}
          {formMode &&
            formMode !== "new" &&
            (() => {
              const target = accounts.accounts.find((a) => a.id === formMode);
              if (!target) return null;
              return (
                <AccountForm
                  mode="edit"
                  existing={target}
                  existingLabels={accounts.accounts
                    .filter((a) => a.id !== target.id)
                    .map((a) => a.label)}
                  onCancel={() => setFormMode(null)}
                  onSubmit={updateAccount}
                />
              );
            })()}
        </div>

        <div className="settings-actions">
          <button className="primary" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}

function AccountCard({
  account,
  active,
  editing,
  onActivate,
  onRemove,
  onEdit,
}: {
  account: Account;
  active: boolean;
  editing: boolean;
  onActivate: () => void;
  onRemove: () => void;
  onEdit: () => void;
}) {
  const skin = findSkin(account.skinId);
  const orgTail = account.orgId.slice(-4);
  // 카드 본체 클릭의 의미를 상태별로 갈라준다. 활성 카드를 또 활성화시키는
  // 건 무의미하니, 그 클릭은 자연스레 "편집 열기"로 해석한다. 비활성 카드는
  // 1차로 활성 전환, 두 번째 클릭(이젠 활성)에서 편집이 열리는 흐름.
  // 활성 전환 없이 그냥 편집만 하고 싶을 때는 우상단 ✎ 버튼을 쓴다.
  const handleBodyClick = () => {
    if (active) onEdit();
    else onActivate();
  };
  return (
    <div
      className={`account-tile ${active ? "selected" : ""} ${editing ? "editing" : ""}`}
    >
      <button
        type="button"
        className="account-tile-body"
        onClick={handleBodyClick}
        title={active ? "클릭해서 편집" : "이 계정으로 전환"}
      >
        <img src={skin.frames.good} alt={skin.name} />
        <span className="account-tile-label">{account.label}</span>
        <span className="account-tile-org">…{orgTail}</span>
        {active && <span className="account-tile-badge">활성</span>}
      </button>
      <button
        type="button"
        className="account-tile-edit"
        onClick={onEdit}
        title="라벨·캐릭터·Org ID·쿠키 편집"
        aria-label="이 계정 편집"
      >
        ✎
      </button>
      <button
        type="button"
        className="account-tile-remove"
        onClick={onRemove}
        title="이 계정 삭제"
        aria-label="이 계정 삭제"
      >
        ✕
      </button>
    </div>
  );
}

// 새 계정 추가와 기존 계정 편집 두 모드를 한 폼으로 처리. 새 모드에서는
// 라벨 자동 생성·새 id 발급·"추가" 버튼, 편집 모드에서는 기존 값으로 채우고
// id 보존·"저장" 버튼. 어느 모드든 onSubmit으로 완성된 Account를 부모에 넘긴다.
function AccountForm({
  mode,
  existing,
  existingLabels,
  onCancel,
  onSubmit,
}: {
  mode: "new" | "edit";
  existing?: Account;
  existingLabels: string[];
  onCancel: () => void;
  onSubmit: (acc: Account) => void;
}) {
  const [label, setLabel] = useState(() => {
    if (mode === "edit" && existing) return existing.label;
    if (existingLabels.length === 0) return "메인 계정";
    if (!existingLabels.includes("서브 계정")) return "서브 계정";
    return `계정 ${existingLabels.length + 1}`;
  });
  const [skin, setSkin] = useState(existing?.skinId ?? DEFAULT_SKIN_ID);
  const [orgId, setOrgId] = useState(existing?.orgId ?? "");
  const [cookie, setCookie] = useState(existing?.cookie ?? "");
  const [platformOrgId, setPlatformOrgId] = useState(
    existing?.platformOrgId ?? "",
  );
  const [platformCookie, setPlatformCookie] = useState(
    existing?.platformCookie ?? "",
  );
  const [testStatus, setTestStatus] = useState<string>("");
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteValue, setPasteValue] = useState("");

  const autoCapture = async () => {
    setTestStatus("");
    setPasteValue("");
    setPasteMode(true);
    try {
      await invoke("open_claude_usage_in_browser");
    } catch (e) {
      setTestStatus(`브라우저 열기 실패: ${String(e)}`);
    }
  };

  const handlePasteValue = async (raw: string) => {
    setPasteValue(raw);
    if (!raw.includes("sessionKey=")) return;
    setTestStatus("Cookie 분석 중…");
    try {
      const res = await invoke<{ org_id: string; cookie: string }>(
        "auto_extract_from_cookie",
        { rawCookie: raw },
      );
      setOrgId(res.org_id);
      setCookie(res.cookie);
      setPasteMode(false);
      setPasteValue("");
      setTestStatus("자동으로 가져왔어요.");
    } catch (e) {
      setTestStatus(`자동 가져오기 실패: ${String(e)}`);
    }
  };

  const test = async () => {
    if (!orgId.trim() || !cookie.trim()) {
      setTestStatus("Org ID와 쿠키를 모두 채워주세요.");
      return;
    }
    setTestStatus("테스트 중...");
    const trimmedPlatform = platformOrgId.trim();
    const trimmedPlatformCookie = platformCookie.trim();
    try {
      const res = await invoke<{
        five_hour_pct: number;
        weekly_pct: number;
        prepaid_dollars: number | null;
        prepaid_error: string | null;
      }>("test_api_config", {
        orgId: orgId.trim(),
        cookie: cookie.trim(),
        platformOrgId: trimmedPlatform || null,
        platformCookie: trimmedPlatformCookie || null,
      });
      const usagePart = `5h ${res.five_hour_pct.toFixed(0)}% · 주간 ${res.weekly_pct.toFixed(0)}%`;
      let prepaidPart = "";
      if (trimmedPlatform) {
        if (res.prepaid_dollars !== null) {
          prepaidPart = ` · prepaid $${res.prepaid_dollars.toFixed(2)}`;
        } else if (res.prepaid_error) {
          // 응답 너무 길면 잘라서 한 줄로. wizard 폭이 좁아 풀 메시지가
          // 가로로 터지면 더 헷갈림.
          const short = res.prepaid_error.length > 60
            ? res.prepaid_error.slice(0, 60) + "…"
            : res.prepaid_error;
          prepaidPart = ` · prepaid 실패: ${short}`;
        }
      }
      setTestStatus(usagePart + prepaidPart);
    } catch (e: unknown) {
      setTestStatus(String(e));
    }
  };

  const submit = () => {
    if (!orgId.trim() || !cookie.trim()) {
      setTestStatus("Org ID와 쿠키를 모두 채워주세요.");
      return;
    }
    const trimmedPlatform = platformOrgId.trim();
    const trimmedPlatformCookie = platformCookie.trim();
    onSubmit({
      id: existing?.id ?? cryptoRandomId(),
      label: label.trim() || "이름 없음",
      orgId: orgId.trim(),
      cookie: cookie.trim(),
      skinId: skin,
      // 빈 값은 undefined로 정규화. Account.platformOrgId/Cookie가 optional이라
      // 빈 문자열을 흘려보내면 Rust 쪽 정규화에 의존하게 됨.
      ...(trimmedPlatform ? { platformOrgId: trimmedPlatform } : {}),
      ...(trimmedPlatformCookie
        ? { platformCookie: trimmedPlatformCookie }
        : {}),
    });
  };

  return (
    <div className="account-form">
      <div className="account-form-head">
        {mode === "edit"
          ? `계정 편집 — ${existing?.label ?? ""}`
          : "새 계정 추가"}
      </div>
      <label>
        계정 이름
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          spellCheck={false}
        />
      </label>
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
      {pasteMode && (
        <div className="paste-capture">
          <div className="paste-capture-head">
            <strong>Cookie 붙여넣기</strong>
            <button
              type="button"
              className="paste-capture-close"
              onClick={() => {
                setPasteMode(false);
                setPasteValue("");
                setTestStatus("");
              }}
              aria-label="닫기"
            >
              ✕
            </button>
          </div>
          <ol className="paste-capture-steps">
            <li>Chrome 탭에서 <code>⌘⌥I</code> → Network 탭</li>
            <li><code>usage</code> 요청 → Headers → <code>cookie:</code> 한 줄 복사</li>
            <li>아래 칸에 ⌘V로 붙여넣기 (자동 처리)</li>
          </ol>
          <textarea
            autoFocus
            placeholder="sessionKey=sk-ant-sid02-...; cf_clearance=...; __cf_bm=...; _cfuvid=...; routingHint=[sk-ant-rh-...]"
            value={pasteValue}
            onChange={(e) => handlePasteValue(e.target.value)}
            rows={3}
            spellCheck={false}
          />
        </div>
      )}
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
      <label>
        Platform Org UUID <span className="field-optional">(선택)</span>
        <input
          type="text"
          placeholder="e25725d1-78db-40f8-a555-68593feb25bb"
          value={platformOrgId}
          onChange={(e) => setPlatformOrgId(e.target.value)}
          spellCheck={false}
        />
        <span className="field-hint">
          prepaid 잔액을 트레이 "5h+주간+$" 모드에서 보고 싶을 때만 채워주세요.
          비워두면 prepaid 호출 자체를 안 합니다. 값은{" "}
          <code>platform.claude.com/settings/billing</code> → DevTools → Network 탭의{" "}
          <code>prepaid/credits</code> 요청 URL에서 추출.
          <strong> claude.ai의 Org ID와 완전히 다른 UUID</strong>예요.
        </span>
      </label>
      <label>
        Platform Cookie <span className="field-optional">(선택)</span>
        <textarea
          placeholder="sessionKey=sk-ant-sid02-...; cf_clearance=...; __cf_bm=...; lastActiveOrg=...; routingHint=..."
          value={platformCookie}
          onChange={(e) => setPlatformCookie(e.target.value)}
          rows={3}
          spellCheck={false}
        />
        <span className="field-hint">
          위 Platform Org UUID로 호출했는데 <code>HTTP 403</code>이 떨어지면
          채워주세요. <strong>platform.claude.com</strong>은 claude.ai와{" "}
          <strong>별도 쿠키 컨텍스트</strong>예요. 같은{" "}
          <code>platform.claude.com/settings/billing</code> 페이지의 DevTools →
          Network 탭에서 <code>prepaid/credits</code> 요청 → Headers →{" "}
          <code>cookie:</code> 한 줄 통째로 복사. 비워두면 위쪽 세션 쿠키를
          그대로 시도합니다.
        </span>
      </label>
      <div className="api-actions">
        <button type="button" onClick={autoCapture}>
          자동으로 가져오기
        </button>
        <button type="button" onClick={test}>
          테스트
        </button>
        <button type="button" className="primary slim" onClick={submit}>
          {mode === "edit" ? "저장" : "추가"}
        </button>
        <button type="button" onClick={onCancel}>
          취소
        </button>
      </div>
      {testStatus && <p className="api-status">{testStatus}</p>}
    </div>
  );
}

function ApiHelpPopup() {
  return (
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
        계정을 삭제하면 그 계정의 자격증명은 즉시 지워집니다.
      </p>
      <p>
        ⚠️ 단, 이 쿠키는 claude.ai 세션 전체 권한을 가지므로
        <strong>다른 사람에게 보내거나 공용 컴퓨터에 두지 마세요.</strong>
        의심스러운 곳에 붙여 넣지도 마시고요.
      </p>
      <p>
        쿠키가 만료되거나 무효해지면 (HTTP 401·403·404) 다음 폴링에서 감지해
        <strong> 이 설정 창이 자동으로 다시 열립니다.</strong> 활성 계정의 쿠키를
        새로 발급받아 그 계정을 삭제 후 같은 라벨로 다시 추가하면 돼요.
      </p>
      <p>
        쿠키는 claude.ai/settings/usage의 개발자도구 → Network → <code>usage</code> 요청 →
        Request Headers의 <code>cookie</code> 줄 전체를 그대로 붙여넣으면 됩니다.
        필요한 키 5개(<code>sessionKey</code>, <code>cf_clearance</code>, <code>__cf_bm</code>, <code>_cfuvid</code>, <code>routingHint</code>)만 사용하고 나머지는 무시돼요.
      </p>
    </div>
  );
}

