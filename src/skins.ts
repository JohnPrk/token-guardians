import type { PetState } from "./types";

// 액세서리 PNG — 모든 스킨이 공유. 캐릭터 본체와 분리되어 idle 액션
// (scratch 의 대나무, run 의 apple/dumbbell 등) 과 disconnected overlay
// (연결 실패 표지판) 에서 쓴다.
import bambooPng from "./skins/_shared/bamboo.png";
import applePng from "./skins/_shared/apple.png";
import dumbbellPng from "./skins/_shared/dumbbell.png";
import disconnectedSignPng from "./skins/_shared/disconnected_sign.png";

// hamster-v2 — 주황+크림 햄스터. 8 포즈 시트(흰 배경) 를 border flood-fill
// 로 배경 제거 후 connected-component 8 분할. 전 포즈 균일 축소(서있는 높이
// ~590, 발끝 Y=630)로 다른 스킨과 비율 정렬. 9-state 표준 매핑
// (full=cheerful, high=idle, good=sit). 640×640 RGBA.
import hamsterV2Idle from "./skins/hamster-v2/idle.png";
import hamsterV2Cheerful from "./skins/hamster-v2/cheerful.png";
import hamsterV2Tired from "./skins/hamster-v2/tired.png";
import hamsterV2Weary from "./skins/hamster-v2/weary.png";
import hamsterV2Sleepy from "./skins/hamster-v2/sleepy.png";
import hamsterV2Sleep from "./skins/hamster-v2/sleep.png";
import hamsterV2Dead from "./skins/hamster-v2/dead.png";
import hamsterV2Sit from "./skins/hamster-v2/sit.png";

// cat-v2 — 회색+크림 고양이(오드아이 파/주, 분홍 귀/코). Gemini 9 포즈 시트
// (3×3, 흰 배경 2048²) 의 3행 중간(중복 dead 변형)을 흰색으로 마스킹해 8 포즈
// 로 만든 뒤 skin-sheet-split 으로 처리. 표준 매핑(full=cheerful, high=idle,
// good=sit) — hamster-v2 와 같음. 640×640 RGBA.
import catV2Idle from "./skins/cat-v2/idle.png";
import catV2Cheerful from "./skins/cat-v2/cheerful.png";
import catV2Tired from "./skins/cat-v2/tired.png";
import catV2Weary from "./skins/cat-v2/weary.png";
import catV2Sleepy from "./skins/cat-v2/sleepy.png";
import catV2Sleep from "./skins/cat-v2/sleep.png";
import catV2Dead from "./skins/cat-v2/dead.png";
import catV2Sit from "./skins/cat-v2/sit.png";

// panda-v4 — 정통 검은+흰 판다(눈주위 검은 반점, 발바닥). cat-v2 와 같은
// 처리(9 포즈 시트의 3행 중간 마스킹 → 8 포즈). 표준 매핑.
import pandaV4Idle from "./skins/panda-v4/idle.png";
import pandaV4Cheerful from "./skins/panda-v4/cheerful.png";
import pandaV4Tired from "./skins/panda-v4/tired.png";
import pandaV4Weary from "./skins/panda-v4/weary.png";
import pandaV4Sleepy from "./skins/panda-v4/sleepy.png";
import pandaV4Sleep from "./skins/panda-v4/sleep.png";
import pandaV4Dead from "./skins/panda-v4/dead.png";
import pandaV4Sit from "./skins/panda-v4/sit.png";

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
    id: "panda-v4",
    name: "Panda v4",
    frames: {
      full: pandaV4Cheerful,
      high: pandaV4Idle,
      good: pandaV4Sit,
      mid: pandaV4Tired,
      low: pandaV4Weary,
      tired: pandaV4Sleepy,
      sleepy: pandaV4Sleep,
      dead: pandaV4Dead,
      disconnected: pandaV4Dead,
    },
    actions: {},
  },
  {
    id: "cat-v2",
    name: "Cat v2",
    frames: {
      full: catV2Cheerful,
      high: catV2Idle,
      good: catV2Sit,
      mid: catV2Tired,
      low: catV2Weary,
      tired: catV2Sleepy,
      sleepy: catV2Sleep,
      dead: catV2Dead,
      disconnected: catV2Dead,
    },
    actions: {},
  },
  {
    id: "hamster-v2",
    name: "Hamster v2",
    frames: {
      full: hamsterV2Cheerful,
      high: hamsterV2Idle,
      good: hamsterV2Sit,
      mid: hamsterV2Tired,
      low: hamsterV2Weary,
      tired: hamsterV2Sleepy,
      sleepy: hamsterV2Sleep,
      dead: hamsterV2Dead,
      disconnected: hamsterV2Dead,
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

// 옛 panda-v3 / cat-v1 / penguin-v1 / penguin-v2 삭제. 새 default 는 panda-v4.
// 기존 사용자의 store 에 옛 id 가 저장돼 있어도 findSkin 의 fallback
// (SKINS[0]) 으로 자동 panda-v4 로 떨어진다.
export const DEFAULT_SKIN_ID = "panda-v4";

export function findSkin(id: string): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS[0];
}
