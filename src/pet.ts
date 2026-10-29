/**
 * pet.html 入口：组装桌宠。
 *
 * 职责拆分：
 *   dom.ts     静态骨架引用
 *   state.ts   基态状态机（is-xxx）
 *   tricks.ts  瞬时动作 + 气泡（act-xxx）
 *   bridge.ts  后端事件 → 状态翻译
 *   pointer.ts 拖拽 / 点击 / 右键菜单 / 鼠标穿透
 *
 * 启动即渲染（DOM 静态写在 pet.html 里，无动态构建），
 * 各异步模块失败时逐个降级，不让桌宠白屏。
 */

import "./styles/pet.css";
import { getPetDom } from "./pet/dom";
import { createStateMachine } from "./pet/state";
import { createTrickManager } from "./pet/tricks";
import { bindEvents } from "./pet/bridge";
import { setupPointer } from "./pet/pointer";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CLICK_QUOTES, PARTY_QUOTES, pick } from "./pet/quotes";
import { PetPackEngine, type PetPack } from "./pet/petpack";
import { setHitShape, isOnHitTarget } from "./pet/pointer";

/** 连击彩蛋：连续点击次数（超时窗口内） */
const COMBO_FOR_PARTY = 5;
/** 连击超时窗口：超过该间隔未点击则清零 */
const COMBO_WINDOW_MS = 2500;

function main(): void {
  const dom = getPetDom();

  /* ---------- 宠物包资源模式 + 皮肤热切换 ----------
   * 设置来源（优先级）：
   *   1. URL 参数 ?skin=svg|pack（调试用，覆盖设置；旧 ?pack=1 仍按 pack 理解）
   *   2. 设置项 petSkin（托盘/设置页切换，事件 pet-skin-changed 热切换）
   * 皮肤值：svg=自绘鹦鹉（模板惰性挂载）；pack=宠物包视频直显（圆角贴纸）
   */
  const params = new URLSearchParams(location.search);
  const urlSkin = params.get("skin") ?? params.get("pack");
  if (urlSkin) {
    // 调试参数：?skin=svg / ?skin=pack（?pack=1 等价 pack）强制指定皮肤
    void applySkin(urlSkin === "svg" ? "svg" : "pack");
  } else {
    // 初始皮肤：读设置；读不到也按默认 pack 走（SVG 不做兜底，失败=透明+自动重试）
    void invoke<{ petSkin?: string }>("get_settings")
      .then((s) => applySkin(s.petSkin ?? "pack"))
      .catch(() => applySkin("pack"));

    // 托盘/设置页切换 → 热切换
    listen<string>("pet-skin-changed", (ev) => {
      void applySkin(ev.payload);
    }).catch(() => {});
  }


  // 瞬时动作 + 气泡管理器
  const tricks = createTrickManager(dom);

  // 基态状态机（注入 hooks：小动作定时器与气泡都由 tricks 提供）
  const sm = createStateMachine(dom, {
    onRescheduleIdle: () => tricks.scheduleIdleFidgets(),
    onRescheduleSleepy: (active) => tricks.scheduleYawns(active),
    showBubble: (text, durationMs) => tricks.showBubble(text, durationMs),
  });

  // idle 小动作先跑起来（初始基态是 idle，状态机构造时不会触发 hooks）
  tricks.scheduleIdleFidgets();

  /* ---------- 点击反应：歪头 / 说话 + 5 连击彩蛋 ---------- */
  let combo = 0;
  let comboTimer = 0;

  function handlePetClick(): void {
    // 视频皮肤：点击 = 随机交互动作（背景/台词按 triggerRules 绑定）
    if (currentSkin !== "svg" && packEngine) {
      window.clearTimeout(comboTimer);
      comboTimer = window.setTimeout(() => { combo = 0; }, COMBO_WINDOW_MS);
      combo += 1;
      if (combo >= COMBO_FOR_PARTY) {
        combo = 0;
        window.clearTimeout(comboTimer);
        tricks.showBubble(pick(PARTY_QUOTES), 5000);
        void packEngine.interact().then((q) => { if (q.length) tricks.showBubble(pick(q)); });
        return;
      }
      void packEngine.interact().then((q) => {
        tricks.showBubble(q.length ? pick(q) : pick(CLICK_QUOTES));
      });
      return;
    }

    // SVG 皮肤：原点击反应
    window.clearTimeout(comboTimer);
    comboTimer = window.setTimeout(() => {
      combo = 0;
    }, COMBO_WINDOW_MS);

    combo += 1;
    if (combo >= COMBO_FOR_PARTY) {
      // 彩蛋：派对帽！
      combo = 0;
      window.clearTimeout(comboTimer);
      tricks.playAction("party");
      tricks.showBubble(pick(PARTY_QUOTES), 5000);
      return;
    }

    // 常规反应：歪头 / 说话二选一（原转圈 spin 属根节点旋转动画，已移除）
    if (Math.random() < 0.4) {
      tricks.playAction("tilt");
    } else {
      tricks.playAction("tilt");
      tricks.showBubble(pick(CLICK_QUOTES));
    }
  }

  /* ---------- 异步模块：事件桥 + 交互层，失败各自降级 ---------- */
  bindEvents(sm, tricks).catch((err) => {
    // 事件桥挂了：桌宠仍能展示与点击，只是收不到提醒
    console.warn("[pet] 事件绑定失败，桌宠将以纯观赏模式运行:", err);
  });

  setupPointer(dom, {
    onClick: handlePetClick,
    // 右键 → Rust 在光标处弹与托盘一致的菜单（显隐项文案随可见性翻转）
    onContextMenu: () => {
      void invoke("popup_pet_menu").catch((err) => console.warn("[pet] 右键菜单弹出失败:", err));
    },
    onDragStart: () => { void packEngine?.dragStart(); },
    onDragEnd: () => packEngine?.dragEnd(),
  }).catch((err) => {
    // 交互层挂了（极端情况，如非 Tauri 环境）：挂最简单的原生事件兜底，
    // 至少保留点击反应与彩蛋，不会变成点不动的白板
    console.warn("[pet] 交互层初始化失败，改用原生点击兜底:", err);
    // SVG 命中椭圆收在模板里（此刻可能未挂载），且矩形命中层挂在 body 而非 root 下——
    // 统一委托到 document + 命中判定，两个宿主无论挂在哪、何时出现都能收到
    document.addEventListener("click", (e) => {
      if (isOnHitTarget(e.target)) handlePetClick();
    });
    const onContextMenu = (e: Event): void => {
      if (!isOnHitTarget(e.target)) return;
      e.preventDefault();
      void invoke("popup_pet_menu").catch(() => {});
    };
    document.addEventListener("contextmenu", onContextMenu);
  });

  // 页面卸载时清理（透明窗口常驻，一般走不到，聊胜于无）
  window.addEventListener("pagehide", () => tricks.dispose(), { once: true });
}

/* ================= 皮肤系统（applySkin 统一入口） ================= */

/** 当前皮肤（点击行为分流用） */
let currentSkin = "svg";

/** 宠物包引擎（pack 皮肤时活动） */
let packEngine: PetPackEngine | null = null;
let packStage: HTMLElement | null = null;
let applySeq = 0; // 防竞态：只允许最后一次 applySkin 生效
const DEFAULT_PACK = "cockatiel";

/* ---------- 宠物包失败重试（不回退 SVG） ----------
 * 明确要求：SVG 不做任何兜底，加载空挡也不出场。失败时面纱保持全透明，
 * 指数退避重试——内存吃紧导致的加载/解码失败是瞬时性的，缓过来即自动恢复。 */
const PACK_RETRY_FIRST_MS = 2000;
const PACK_RETRY_MAX_MS = 60_000;
let packRetryTimer = 0;
let packRetryDelayMs = PACK_RETRY_FIRST_MS;

interface SkinOpts {
  pack?: string;
}

/** 切换桌宠皮肤。svg=自绘（模板克隆挂载）；pack=宠物包双层引擎。 */
async function applySkin(skin: string, opts: SkinOpts = {}): Promise<void> {
  const seq = ++applySeq;
  window.clearTimeout(packRetryTimer); // 挂起的重试作废（本次调用即最新意图）
  const dom = getPetDom();
  currentSkin = skin;

  // —— SVG 皮肤：清掉视频层，克隆模板挂回鹦鹉，解冻状态机动效 ——
  if (skin === "svg") {
    disposePack();
    dom.unmountSvg();
    dom.mountSvg();
    dom.stage.classList.remove("stage-frozen");
    setHitShape("ellipse");
    dom.videoHit.style.display = "none";
    dom.root.classList.remove("skin-pending");
    packRetryDelayMs = PACK_RETRY_FIRST_MS;
    console.info("[pet] 皮肤: SVG 鹦鹉");
    return;
  }

  // —— 宠物包皮肤：读 manifest → 建双层引擎 ——
  const packId = opts.pack ?? DEFAULT_PACK;
  // 半启动资源：成功才交付给全局；中途被顶掉/失败在各自路径就地清理
  let stage: HTMLElement | null = null;
  let engine: PetPackEngine | null = null;
  try {
    const res = await fetch(`/assets/pets/${packId}/manifest.json`);
    const pack: PetPack = await res.json();
    if (seq !== applySeq) return;
    if (!pack.assets.idle.length) throw new Error("宠物包没有待机动画");

    // 清旧引擎；SVG 彻底销毁。模板惰性挂载后 pack 模式下 SVG 节点从不存在，
    // 合成器没有任何 SVG 帧纹理可缓存/闪现（内存吃紧偶现闪 SVG 的根治点）；
    // 面纱继续兜住引擎启动等首帧的数百 ms 空挡——空挡保持全透明，不出场任何内容
    disposePack();
    dom.unmountSvg();
    dom.stage.classList.add("stage-frozen");

    stage = document.createElement("div");
    stage.className = "pack-stage";
    // 挂 #pet-root（与 .pet-stage 平级）：脱离 .pet-inner 形变容器——
    // SVG 状态机的 act-tilt/跳跃等 transform 作用于 .pet-inner，视频在里面会被带着形变
    dom.root.appendChild(stage);

    engine = new PetPackEngine(pack, stage);
    const ok = await engine.start();
    if (seq !== applySeq) {
      engine.dispose();
      stage.remove();
      return;
    }
    if (!ok) throw new Error("引擎启动失败");

    // 成功交付全局（之后 catch 不再清理）
    packEngine = engine;
    packStage = stage;
    stage = null;
    engine = null;

    // 视频模式接管：启用矩形命中层，揭面纱
    setHitShape("rect");
    dom.videoHit.style.display = "";
    dom.root.classList.remove("skin-pending");
    packRetryDelayMs = PACK_RETRY_FIRST_MS;

    console.info(`[pet] 皮肤: 宠物包「${pack.name}」(${pack.id}) 待机×${pack.assets.idle.length} 交互×${pack.assets.interact.length}`);
  } catch (err) {
    // 失败清理：半启动的引擎/舞台一并拆掉（此前只清全局引用，失败舞台会残留 DOM）
    engine?.dispose();
    stage?.remove();
    if (seq !== applySeq) return;
    // 不回退 SVG（明确要求）：面纱保持全透明，指数退避自动重试
    console.warn(`[pet] 宠物包不可用（${String(err)}），${packRetryDelayMs}ms 后自动重试`);
    schedulePackRetry(seq, opts);
  }
}

/** 排定一次宠物包重试（seq 失效则不执行；延迟翻倍封顶，成功后复位） */
function schedulePackRetry(seq: number, opts: SkinOpts): void {
  const delay = packRetryDelayMs;
  packRetryDelayMs = Math.min(packRetryDelayMs * 2, PACK_RETRY_MAX_MS);
  packRetryTimer = window.setTimeout(() => {
    if (seq !== applySeq) return;
    void applySkin("pack", opts);
  }, delay);
}

/** 清理宠物包引擎与舞台（SVG 归模板管，这里不碰） */
function disposePack(): void {
  packEngine?.dispose();
  packEngine = null;
  packStage?.remove();
  packStage = null;
}

main();
