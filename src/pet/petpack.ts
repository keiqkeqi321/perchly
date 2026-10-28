/**
 * 宠物包引擎（双层视频：主体层 + 背景层）
 *
 * 宠物包结构（public/assets/pets/<packId>/）：
 *   manifest.json —— 声明式资源与触发规则（见下方 PetPack 接口）
 *   *.webm        —— 动画资源，文件名即语义
 *
 * 设计目标：加新宠物 = 加一个文件夹 + manifest.json，引擎代码零改动。
 * 规则模式（triggerRules.when，先匹配先赢）：
 *   "idle"                     → 待机随机轮播
 *   "interact:<文件名>"        → 播特定交互动作时（背景/台词绑定）
 *   "interact:*"               → 兜底：任意交互动作
 *   "drag"                     → 拖动中（固定飞翔 + 光晕）
 */

import { NeteasePetPlayer } from "./netease";

export interface TriggerRule {
  when: string;
  bg: string | null;
  quotes: string[];
}

export interface PetPack {
  id: string;
  name: string;
  version: number;
  windowSize: number;
  layers: { body: { z: number }; bg: { z: number } };
  assets: {
    idle: string[];
    interact: string[];
    fly: string[];
  };
  backgrounds: Record<string, string>;
  triggerRules: TriggerRule[];
}

/** 背景播放请求（null=停背景） */
type BgRequest = { key: string | null };

/** 双层播放器：主体层独占换片，背景层独立循环 */
export class PetPackEngine {
  private pack: PetPack;
  private base: string;
  private bodyStage: HTMLElement;
  private bgStage: HTMLElement;
  private bodyPlayer: NeteasePetPlayer | null = null;
  private bgPlayer: NeteasePetPlayer | null = null;
  private idleTimer = 0;
  private idleQueue: string[] = [];
  private disposed = false;
  /** 拖动中标记（拖动时挂起 idle 轮播） */
  private dragging = false;
  onQuotes?: (quotes: string[]) => void;

  constructor(pack: PetPack, root: HTMLElement) {
    this.pack = pack;
    this.base = `/assets/pets/${pack.id}/`;

    // 双层舞台：body 在上（z 高），bg 在下
    this.bgStage = document.createElement("div");
    this.bgStage.className = "petpack-bg";
    this.bgStage.style.zIndex = String(pack.layers.bg.z);
    this.bodyStage = document.createElement("div");
    this.bodyStage.className = "petpack-body";
    this.bodyStage.style.zIndex = String(pack.layers.body.z);
    root.appendChild(this.bgStage);
    root.appendChild(this.bodyStage);
  }

  /** 启动：进入待机轮播 */
  async start(): Promise<boolean> {
    if (!this.pack.assets.idle.length) return false;
    // 预挂背景视频元素（隐藏），首次触发规则时才播
    const ok = await this.playBody(this.pickIdle(), "idle");
    this.scheduleIdleRotation();
    return ok;
  }

  /* ---------------- 主体层 ---------------- */

  private async playBody(file: string, state: "idle" | "interact" | "fly"): Promise<boolean> {
    if (this.disposed) return false;
    this.bodyBusy = true;
    // 无缝换片：新片预载到第一帧可呈现，再同帧交接（旧隐藏→新显示→旧移除）
    const oldPlayer = this.bodyPlayer;
    oldPlayer?.setHidden(true);
    const p = new NeteasePetPlayer(this.base + file);
    const ok = await p.attach(this.bodyStage, { waitForFrame: true });
    this.bodyBusy = false;
    if (!ok) {
      oldPlayer?.setHidden(false); // 新片失败：旧片退场回显
      return false;
    }
    this.bodyPlayer = p;
    this.currentBodyFile = file;
    this.currentState = state;
    oldPlayer?.destroy();
    return true;
  }

  private currentBodyFile = "";
  private currentState: "idle" | "interact" | "fly" = "idle";

  /** 待机队列：洗牌算法，不连续重复 */
  private pickIdle(): string {
    if (!this.idleQueue.length) {
      this.idleQueue = [...this.pack.assets.idle].sort(() => Math.random() - 0.5);
    }
    return this.idleQueue.pop()!;
  }

  /** 待机轮播：当前片段播完 → 下一条（每条只播一遍，节奏更自然） */
  private scheduleIdleRotation(): void {
    window.clearTimeout(this.idleTimer);
    const tick = (): void => {
      if (this.disposed || this.dragging) return;
      if (this.currentState !== "idle") return; // 交互/拖动接管中，暂停轮播
      if (this.bodyBusy) return; // 换片进行中（含 dragStart 的 fly attach），勿抢
      const file = this.pickIdle();
      void this.playBody(file, "idle").then((ok) => {
        if (!ok) console.warn(`[petpack] 待机片 ${file} 加载失败，跳过`);
      });
      const dur = this.bodyPlayer?.durationMs ?? 4000;
      this.idleTimer = window.setTimeout(tick, dur);
    };
    const first = this.bodyPlayer?.durationMs ?? 4000;
    this.idleTimer = window.setTimeout(tick, first);
  }

  /** playBody 进行中标记（防 idle 轮播抢拍） */
  private bodyBusy = false;

  /** 点击交互：随机挑一个交互动作，匹配 triggerRules 播背景+台词 */
  async interact(): Promise<string[]> {
    const pool = this.pack.assets.interact;
    if (!pool.length) return [];
    const file = pool[Math.floor(Math.random() * pool.length)];
    window.clearTimeout(this.idleTimer);
    this.dragging = false; // 兜底：拖拽桩异常时恢复可交互
    this.interactSeq++; // 换片代际：旧定时器作废
    const mySeq = this.interactSeq;

    const rule =
      this.pack.triggerRules.find((r) => r.when === `interact:${file}`) ??
      this.pack.triggerRules.find((r) => r.when === "interact:*");

    await this.playBody(file, "interact");
    if (mySeq !== this.interactSeq) return []; // 期间又有新交互/拖动，本代作废
    this.applyRule(rule);
    // 动作播完回待机（回调里再验代际：被更新的交互/拖动覆盖则不执行）
    const dur = this.bodyPlayer?.durationMs ?? 4000;
    this.idleTimer = window.setTimeout(() => {
      if (mySeq !== this.interactSeq || this.dragging) return;
      this.stopBg();
      void this.playBody(this.pickIdle(), "idle").then(() => this.scheduleIdleRotation());
    }, dur);
    return rule?.quotes ?? [];
  }

  private interactSeq = 0;

  /* ---------------- 拖动 ---------------- */

  /** 拖动开始：固定飞翔 + 光晕（规则 drag） */
  async dragStart(): Promise<void> {
    if (!this.pack.assets.fly.length) return;
    this.dragging = true;
    window.clearTimeout(this.idleTimer);
    this.interactSeq++; // 作废挂起的"回待机"定时器
    const rule = this.pack.triggerRules.find((r) => r.when === "drag");
    const file = this.pack.assets.fly[0];
    // 预加载（attach 后台进行，不动当前画面），拖动视觉立即生效
    await this.playBody(file, "fly");
    this.applyRule(rule);
  }

  /** 拖动结束：停背景，回待机 */
  dragEnd(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.stopBg();
    void this.playBody(this.pickIdle(), "idle").then(() => this.scheduleIdleRotation());
  }

  /* ---------------- 背景层 ---------------- */

  /** 应用规则背景（null=无背景）；重复请求同 key 不重播 */
  private async applyRule(rule: TriggerRule | undefined): Promise<void> {
    if (this.disposed) return;
    const req: BgRequest = { key: rule?.bg ?? null };
    if (this.lastBgKey === req.key) return; // 同背景连续触发不闪切
    this.lastBgKey = req.key;
    if (!req.key) return;
    const file = this.pack.backgrounds[req.key];
    if (!file) return;
    const p = new NeteasePetPlayer(this.base + file);
    const ok = await p.attach(this.bgStage);
    if (!ok) return;
    this.bgPlayer?.destroy();
    this.bgPlayer = p;
  }

  private lastBgKey: string | null = null;

  private stopBg(): void {
    this.bgPlayer?.destroy();
    this.bgPlayer = null;
    this.lastBgKey = null;
  }

  /* ---------------- 生命周期 ---------------- */

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.idleTimer);
    this.bodyPlayer?.destroy();
    this.bgPlayer?.destroy();
    this.bodyPlayer = null;
    this.bgPlayer = null;
    this.bodyStage.remove();
    this.bgStage.remove();
  }
}
