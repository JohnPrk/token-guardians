import type { PetState } from "./types";

// 액세서리 PNG — 모든 스킨이 공유. 캐릭터 본체와 분리되어 idle 액션
// (scratch 의 대나무, run 의 apple/dumbbell 등) 과 disconnected overlay
// (연결 실패 표지판) 에서 쓴다.
import bambooPng from "./skins/_shared/bamboo.png";
import applePng from "./skins/_shared/apple.png";
import dumbbellPng from "./skins/_shared/dumbbell.png";
import disconnectedSignPng from "./skins/_shared/disconnected_sign.png";

// panda-v3 — Gemini Nano Banana 2 8 포즈 캐릭터 셋. centroid 좌우 정렬 +
// 발끝 동일 Y. 9-state 매핑은 v2.13 에 정착한 안:
//   full   (90-100%) → idle      (활기)
//   high   (77-90%)  → cheerful  (양호)
//   good   (63-77%)  → cheerful  (양호 유지, 같은 이미지)
//   mid    (49-63%)  → tired     (피곤한 기색)
//   low    (33-49%)  → weary     (지친)
//   tired  (15-33%)  → sleepy    (졸린, 눈 반감)
//   sleepy (0-15%)   → sleep     (완전히 누워 자는)
//   dead             → dead      (X 눈)
//   disconnected     → dead      (ACCESSORIES.disconnectedSign 오버레이)
import pandaV3Idle from "./skins/panda-v3/idle.png";
import pandaV3Cheerful from "./skins/panda-v3/cheerful.png";
import pandaV3Tired from "./skins/panda-v3/tired.png";
import pandaV3Weary from "./skins/panda-v3/weary.png";
import pandaV3Sleepy from "./skins/panda-v3/sleepy.png";
import pandaV3Sleep from "./skins/panda-v3/sleep.png";
import pandaV3Dead from "./skins/panda-v3/dead.png";

// cat-v1 — 회색+흰색 고양이, 오드아이(파랑/노랑). panda-v3 시트를
// style reference 로 같이 줘서 동일 톤(derpy / 큰 반짝 눈 / 통통한 비율)
// 으로 생성. 같은 9-state 매핑.
import catV1Idle from "./skins/cat-v1/idle.png";
import catV1Cheerful from "./skins/cat-v1/cheerful.png";
import catV1Tired from "./skins/cat-v1/tired.png";
import catV1Weary from "./skins/cat-v1/weary.png";
import catV1Sleepy from "./skins/cat-v1/sleepy.png";
import catV1Sleep from "./skins/cat-v1/sleep.png";
import catV1Dead from "./skins/cat-v1/dead.png";

// Action names used by the idle micro-action loop in App.tsx.
// A skin can optionally provide a .gif for any of these to express the
// motion via the gif itself instead of relying on CSS transforms.
export type ActionName =
  | "roll"
  | "jump"
  | "run"
  | "scratch"
  | "wobble"
  | "squish";

export type Skin = {
  id: string;
  name: string;
  /** Static PNG (or any image) per pet state. Required. */
  frames: Record<PetState, string>;
  /**
   * Optional motion GIFs per idle action. If a gif is provided for an
   * action, the renderer swaps the static state PNG for the gif while
   * the action plays. If absent, the static PNG remains visible and the
   * existing CSS keyframes provide a fallback motion.
   */
  actions?: Partial<Record<ActionName, string>>;
};

export const SKINS: Skin[] = [
  {
    id: "panda-v3",
    name: "Panda v3",
    frames: {
      full: pandaV3Idle,
      high: pandaV3Cheerful,
      good: pandaV3Cheerful,
      mid: pandaV3Tired,
      low: pandaV3Weary,
      tired: pandaV3Sleepy,
      sleepy: pandaV3Sleep,
      dead: pandaV3Dead,
      disconnected: pandaV3Dead,
    },
    actions: {},
  },
  {
    id: "cat-v1",
    name: "Cat v1",
    frames: {
      full: catV1Idle,
      high: catV1Cheerful,
      good: catV1Cheerful,
      mid: catV1Tired,
      low: catV1Weary,
      tired: catV1Sleepy,
      sleepy: catV1Sleep,
      dead: catV1Dead,
      disconnected: catV1Dead,
    },
    actions: {},
  },
];

export const ACCESSORIES = {
  bamboo: bambooPng,
  apple: applePng,
  dumbbell: dumbbellPng,
  disconnectedSign: disconnectedSignPng,
};

// v2.15: 옛 panda(v1) 와 panda-v2 삭제. 새 default 는 panda-v3.
// 기존 사용자의 store 에 "panda" 가 저장돼 있어도 findSkin 의 fallback
// (SKINS[0]) 으로 자동 panda-v3 로 떨어진다.
export const DEFAULT_SKIN_ID = "panda-v3";

export function findSkin(id: string): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS[0];
}
