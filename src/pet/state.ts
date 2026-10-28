/**
 * 桌宠状态机（基态部分）。
 *
 * 基态 = 鹦鹉长期的"心情"，映射到 .pet-stage 上的 is-xxx class：
 *   idle   日常：呼吸 + 眨眼 + 偶尔歪头（眨眼/歪头由 tricks 层的定时器驱动）
 *   sleepy 犯困：progressPercent > 60 进入，耷拉眼皮 + 冠羽塌下 + Zzz + 定时打哈欠
 *   remind 提醒：remainingMs < 60000，跳起挥翅 + 气泡「该休息啦！」
 *   happy  开心：收到 *-started 事件，跳舞 + 气泡「休息真棒～」
 *
 * 基态之间互斥：同一时间只有一个 is-* class。
 * 瞬时动作（act-xxx）由 tricks.ts 管理，可叠加在任意基态之上。
 */

import type { PetDom } from "./dom";
import type { BaseState } from "./types";
import { HAPPY_QUOTES, REMIND_LONG_QUOTES, REMIND_MICRO_QUOTES, pick } from "./quotes";

/** 气泡驻留时长：提醒久一点，开心常规 */
const REMIND_BUBBLE_MS = 6000;
const HAPPY_BUBBLE_MS = 3200;

/** 由主入口注入的能力（避免状态机直接依赖 tricks 实例，防循环依赖） */
export interface StateHooks {
  /** 基态回到 idle/sleepy 时重排随机小动作 */
  onRescheduleIdle(): void;
  /** 基态进入/离开 sleepy 时重排打哈欠定时器 */
  onRescheduleSleepy(active: boolean): void;
  /** 展示说话气泡（带自动隐藏） */
  showBubble(text: string, durationMs?: number): void;
}

export interface StateMachine {
  /** 切换基态（同态幂等；remindKind 决定提醒用哪套语录） */
  setBase(next: BaseState, opts?: { remindKind?: "Micro" | "Long" }): void;
  /** 读取当前基态 */
  getBase(): BaseState;
}

export function createStateMachine(dom: PetDom, hooks: StateHooks): StateMachine {
  let current: BaseState = "idle";

  const BASE_CLASSES = ["is-idle", "is-sleepy", "is-remind", "is-happy"] as const;

  /** 写基态 class：先全部移除再挂目标（互斥保证） */
  function applyBase(next: BaseState): void {
    dom.stage.classList.remove(...BASE_CLASSES);
    dom.stage.classList.add(`is-${next}`);
  }

  function setBase(next: BaseState, opts?: { remindKind?: "Micro" | "Long" }): void {
    if (next === current) return; // 同态幂等
    current = next;
    applyBase(next);

    switch (next) {
      case "idle":
        hooks.onRescheduleIdle();
        hooks.onRescheduleSleepy(false);
        break;
      case "sleepy":
        hooks.onRescheduleIdle();
        hooks.onRescheduleSleepy(true);
        break;
      case "remind":
        hooks.onRescheduleSleepy(false);
        hooks.showBubble(
          pick(opts?.remindKind === "Long" ? REMIND_LONG_QUOTES : REMIND_MICRO_QUOTES),
          REMIND_BUBBLE_MS,
        );
        break;
      case "happy":
        hooks.onRescheduleSleepy(false);
        hooks.showBubble(pick(HAPPY_QUOTES), HAPPY_BUBBLE_MS);
        break;
    }
  }

  applyBase("idle");

  return { setBase, getBase: () => current };
}
