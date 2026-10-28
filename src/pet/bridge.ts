/**
 * 事件桥：把 Tauri 后端的 "planner" / "status" 事件翻译成状态机与瞬时动作。
 *
 * 事件 type 一览（契约）：
 *   microbreak-notification / break-notification  休息前提醒（带 kind）
 *   microbreak-started  / break-started           休息开始 → happy
 *   micro-finished      / long-finished           休息结束（data 含 skipped/postponed）
 *   paused / resumed / status
 *
 * status 驱动的基态推导（工作期间）：
 *   remainingMs < 60000          → remind（优先）
 *   progressPercent > 60         → sleepy
 *   其余                          → idle
 * 休息进行中（收到 *-started 到 *-finished 之间）保持 happy，不受 status 干扰。
 */

import { listen } from "@tauri-apps/api/event";
import type { StateMachine } from "./state";
import type { TrickManager } from "./tricks";
import type { PlannerEvent, StatusPayload } from "./types";
import { asStatus, isFinishedData } from "./types";
import { PAUSED_QUOTES, POSTPONE_QUOTES, RESUMED_QUOTES, SKIP_QUOTES, pick } from "./quotes";

/** 进入 remind 的阈值 */
const REMIND_THRESHOLD_MS = 60_000;
/** 进入 sleepy 的进度阈值 */
const SLEEPY_PROGRESS = 60;

export interface BridgeHandle {
  /** 注销全部事件监听 */
  dispose(): void;
}

export async function bindEvents(sm: StateMachine, tricks: TrickManager): Promise<BridgeHandle> {
  /** 最近一次 status 告知的下一次休息类型（提醒气泡用词） */
  let nextKind: "Micro" | "Long" | null = null;
  /** 是否处于休息进行中（*-started → *-finished 之间） */
  let inBreak = false;
  /** 暂停气泡是否已展示过（paused 期间 status 可能高频到达，只说一次） */
  let pausedAnnounced = false;

  /** status → 基态推导 */
  function handleStatus(payload: StatusPayload): void {
    if (payload.nextBreakKind === "Micro" || payload.nextBreakKind === "Long") {
      nextKind = payload.nextBreakKind;
    }

    if (payload.paused) {
      if (!pausedAnnounced) {
        pausedAnnounced = true;
        tricks.showBubble(pick(PAUSED_QUOTES));
        // 暂停期间进入犯困姿态，避免一直保持提醒时的蹦跳
        sm.setBase("sleepy");
      }
      return; // 暂停时不做基态推导
    }
    pausedAnnounced = false;

    // 休息进行中保持 happy
    if (inBreak) return;

    if (payload.remainingMs < REMIND_THRESHOLD_MS) {
      sm.setBase("remind", { remindKind: nextKind ?? undefined });
    } else if (payload.progressPercent > SLEEPY_PROGRESS) {
      sm.setBase("sleepy");
    } else {
      sm.setBase("idle");
    }
  }

  /** planner 事件分发 */
  function handlePlanner(msg: PlannerEvent | StatusPayload): void {
    // 兼容 {type, data} 形状；status 事件也可能从 planner 通道来
    if ("type" in msg && typeof msg.type === "string") {
      if (msg.type === "status") {
        const s = asStatus(msg.data);
        if (s) handleStatus(s);
        return;
      }
      dispatchPlannerType(msg.type, msg.data);
    } else {
      // 直接就是裸 status 对象
      const s = asStatus(msg);
      if (s) handleStatus(s);
    }
  }

  function dispatchPlannerType(type: string, data: unknown): void {
    switch (type) {
      case "microbreak-notification":
      case "break-notification": {
        // 提醒通知：确认进入 remind 并刷新气泡（即使已在 remind 也重申一次）
        const kind: "Micro" | "Long" = type === "break-notification" ? "Long" : "Micro";
        nextKind = kind;
        sm.setBase("remind", { remindKind: kind });
        break;
      }
      case "microbreak-started":
      case "break-started":
        inBreak = true;
        sm.setBase("happy");
        break;
      case "micro-finished":
      case "long-finished":
        inBreak = false;
        if (isFinishedData(data)) {
          if (data.postponed) {
            // 推迟休息：皱眉 + 跺脚
            tricks.playAction("stomp");
            tricks.showBubble(pick(POSTPONE_QUOTES));
          } else if (data.skipped) {
            // 跳过休息：委屈说话 + 歪头
            tricks.playAction("tilt");
            tricks.showBubble(pick(SKIP_QUOTES));
          }
        }
        sm.setBase("idle");
        break;
      case "paused":
        pausedAnnounced = true; // 已播报，挡住后续 status(paused=true) 的重复气泡
        tricks.showBubble(pick(PAUSED_QUOTES));
        sm.setBase("sleepy"); // 暂停 = 眯一会儿
        break;
      case "resumed":
        pausedAnnounced = false;
        tricks.showBubble(pick(RESUMED_QUOTES));
        sm.setBase("idle"); // 恢复后由下一次 status 重新推导
        break;
      default:
        // 未知事件：安静忽略，保持当前状态
        break;
    }
  }

  const unlistenPlanner = await listen<PlannerEvent | StatusPayload>("planner", (ev) => {
    handlePlanner(ev.payload);
  });
  const unlistenStatus = await listen<unknown>("status", (ev) => {
    const s = asStatus(ev.payload);
    if (s) handleStatus(s);
  });

  return {
    dispose(): void {
      unlistenPlanner();
      unlistenStatus();
    },
  };
}
