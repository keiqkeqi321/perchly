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

import { PetVideoPlayer } from "./video";

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
  private bodyPlayer: PetVideoPlayer | null = null;
  private bgPlayer: PetVideoPlayer | null = null;
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

  /** 启动：进入待机轮播 + 预热关键资源（fly/背景，首帧就绪待命） */
  async start(): Promise<boolean> {
    if (!this.pack.assets.idle.length) return false;
    const ok = await this.playBody(this.pickIdle(), "idle");
    this.scheduleIdleRotation();
    void this.prewarm(); // 不阻塞启动
    return ok;
  }

  /** 资源预热：fly 与背景视频提前加载到首帧（隐藏挂载），触发时零延迟切换 */
  private async prewarm(): Promise<void> {
    // fly：热源（拖动触发最突然）
    for (const file of this.pack.assets.fly.slice(0, 1)) {
      await this.prewarmBody(file);
    }
    // 背景：规则引用的都热
    for (const key of new Set(
      this.pack.triggerRules.map((r) => r.bg).filter((k): k is string => !!k),
    )) {
      const file = this.pack.backgrounds[key];
      if (file) await this.prewarmBg(file);
    }
  }

  /** 预热一个主体视频（隐藏挂载到 bodyStage，不入 bodyPlayer 管辖） */
  private async prewarmBody(file: string): Promise<void> {
    if (this.warmBody.has(file)) return;
    this.warmBody.set(file, "loading");
    const p = new PetVideoPlayer(this.base + file);
    p.setHidden(true);
    const ok = await p.attach(this.bodyStage, { waitForFrame: true });
    if (!ok) { p.destroy(); this.warmBody.delete(file); return; }
    p.pause();
    // 加载期间被领养/销毁的边界：池里还是 "loading" 才入池，否则自毁
    if (this.disposed) { p.destroy(); return; }
    this.warmBody.set(file, p);
  }

  /** 预热一个背景视频（隐藏挂载到 bgStage） */
  private async prewarmBg(file: string): Promise<void> {
    if (this.warmBg.has(file)) return;
    const p = new PetVideoPlayer(this.base + file);
    p.setHidden(true);
    const ok = await p.attach(this.bgStage, { waitForFrame: true });
    if (!ok) { p.destroy(); return; }
    p.pause();
    this.warmBg.set(file, p);
  }

  private warmBody = new Map<string, PetVideoPlayer | "loading">();
  private warmBg = new Map<string, PetVideoPlayer>();

  /* ---------------- 主体层 ---------------- */

  private async playBody(file: string, state: "idle" | "interact" | "fly"): Promise<boolean> {
    if (this.disposed) return false;
    // 代际令牌：并发换片时只允许最新一代提交，被顶掉的一代自清理（不留孤儿视频）
    const gen = ++this.bodyGen;

    // 优先领养预热视频（首帧已就绪，零延迟上屏）
    const warm = this.warmBody.get(file);
    if (warm instanceof PetVideoPlayer) {
      this.warmBody.delete(file); // 出池即领养
      warm.setHidden(false);
      warm.play();
      this.bodyPlayer?.destroy();
      this.bodyPlayer = warm;
      this.currentBodyFile = file;
      this.currentState = state;
      return true;
    }

    const p = new PetVideoPlayer(this.base + file);
    p.setHidden(true); // 加载期间隐藏（视频绝对定位堆叠，隐藏片不推挤布局）
    const ok = await p.attach(this.bodyStage, { waitForFrame: true });
    if (!ok) {
      p.destroy();
      return false;
    }
    if (gen !== this.bodyGen || this.disposed) {
      p.destroy(); // 已被更新的换片顶掉：自杀，绝不上屏
      return false;
    }
    // 同帧交接：新片亮相 → 旧片移除
    p.setHidden(false);
    this.bodyPlayer?.destroy();
    this.bodyPlayer = p;
    this.currentBodyFile = file;
    this.currentState = state;
    return true;
  }

  private bodyGen = 0;

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

  /** 拖动开始：固定飞翔 + 光晕（规则 drag）。领养预热片，瞬时切换 */
  async dragStart(): Promise<void> {
    if (!this.pack.assets.fly.length) return;
    // 取消挂起的"回待机"（快速松手又立刻再拖的场景）
    window.clearTimeout(this.pendingReturnTimer);
    this.dragging = true;
    window.clearTimeout(this.idleTimer);
    this.interactSeq++; // 作废挂起的"回待机"定时器
    const rule = this.pack.triggerRules.find((r) => r.when === "drag");
    const file = this.pack.assets.fly[0];
    await this.playBody(file, "fly"); // 预热池命中则零延迟
    this.flyShownAt = Date.now();
    this.applyRule(rule);
  }

  /** 拖动结束：停背景，回待机；fly 回收进预热池（下次拖动零延迟）。
   *  带最小飞翔时长保护：即便上游误报松手，飞翔也至少展示 600ms */
  dragEnd(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.stopBg();
    const elapsed = Date.now() - this.flyShownAt;
    const delay = Math.max(0, 600 - elapsed);
    this.pendingReturnTimer = window.setTimeout(() => this.returnFromFly(), delay);
  }

  /** 真正切回待机（fly 回池） */
  private returnFromFly(): void {
    const flyFile = this.pack.assets.fly[0];
    if (this.bodyPlayer && this.currentBodyFile === flyFile) {
      const p = this.bodyPlayer;
      this.bodyPlayer = null;
      p.pause();
      p.setHidden(true);
      this.warmBody.set(flyFile, p);
    }
    void this.playBody(this.pickIdle(), "idle").then(() => this.scheduleIdleRotation());
  }

  private flyShownAt = 0;
  private pendingReturnTimer = 0;

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
    // 领养预热背景（首帧就绪，零延迟）
    const warm = this.warmBg.get(file);
    if (warm) {
      this.warmBg.delete(file);
      warm.setHidden(false);
      warm.play();
      this.bgPlayer?.destroy();
      this.bgPlayer = warm;
      return;
    }
    const p = new PetVideoPlayer(this.base + file);
    const ok = await p.attach(this.bgStage, { waitForFrame: true });
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
    window.clearTimeout(this.pendingReturnTimer);
    this.bodyPlayer?.destroy();
    this.bgPlayer?.destroy();
    for (const p of this.warmBody.values()) if (p instanceof PetVideoPlayer) p.destroy();
    for (const p of this.warmBg.values()) p.destroy();
    this.warmBody.clear();
    this.warmBg.clear();
    this.bodyPlayer = null;
    this.bgPlayer = null;
    this.bodyStage.remove();
    this.bgStage.remove();
  }
}
