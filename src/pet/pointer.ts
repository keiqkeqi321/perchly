/**
 * 交互层：拖拽 / 点击判定 / 双击隐藏 / 鼠标穿透。
 *
 * 穿透策略（重要）：
 *   本机 @tauri-apps/api 2.12.4 的 setIgnoreCursorEvents 只有单参数版本，
 *   不存在 Electron 式的 forward 选项；穿透后本窗口收不到任何鼠标事件。
 *   因此采用两段式：
 *     1) 穿透期间：以 250ms 轮询 cursorPosition()（物理坐标），
 *        与窗口 rect 换算比较，判断光标是否落在鹦鹉身体椭圆内；
 *     2) 一旦落在身体上 → setIgnoreCursorEvents(false) 切回接收模式，
 *        并挂 mousemove 快速路径：事件 target 不在 .pet-hit 上时立刻恢复穿透。
 *   API 报错（平台不支持/无权限）则降级为常驻可点击。
 *
 * 点击 / 拖拽：
 *   pointerdown 记录起点；move 位移 ≥ 5px 判定拖拽 → startDragging()
 *   （Windows 上该调用阻塞至松开），resolve 后用 outerPosition()（物理坐标）
 *   invoke("save_pet_position") 持久化；pointerup 位移 < 5px 计为点击，
 *   400ms 内两次点击 = 双击 → hide() 回托盘。
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, cursorPosition } from "@tauri-apps/api/window";
import type { PetDom } from "./dom";

/** 区分点击与拖拽的位移阈值（px） */
const DRAG_THRESHOLD_PX = 5;
/** 双击判定窗口（ms） */
const DOUBLE_CLICK_MS = 400;
/** 穿透期间探测光标的轮询间隔（ms）。非 rAF，仅 4 次/秒的轻量 IPC 轮询 */
const HOVER_POLL_MS = 250;

/** 身体命中椭圆（SVG viewBox 坐标，与 pet.html 中 .pet-hit 保持一致） */
const HIT_ELLIPSE = { cx: 104, cy: 152, rx: 60, ry: 64 } as const;

/** 当前命中区形状：ellipse=SVG 鹦鹉身体；rect=视频全窗口（网易云皮肤 200x200 居中） */
type HitShape = "ellipse" | "rect";
let hitShape: HitShape = "ellipse";

/** 皮肤切换时由 pet.ts 调用：改命中区（rect 模式整个 220x220 窗口都可命中） */
export function setHitShape(shape: HitShape): void {
  hitShape = shape;
}

/** 命中元素的判定（事件 target 在椭圆或矩形命中层上都算"在身上"） */
function isHitTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    (target.closest(".pet-hit") !== null || target.closest("#pet-video-hit") !== null)
  );
}

export interface PointerHandlers {
  /** 有效单击（非拖拽、非双击的第二下） */
  onClick(): void;
  /** 双击 → 隐藏到托盘 */
  onDoubleClick(): void;
  /** 拖拽判定成立（位移过阈值，startDragging 前） */
  onDragStart?(): void;
  /** 系统拖拽结束（savePosition 之后） */
  onDragEnd?(): void;
}

/** 穿透子系统当前模式 */
type PassthroughMode = "passthrough" | "interactive" | "unsupported";

export async function setupPointer(dom: PetDom, handlers: PointerHandlers): Promise<void> {
  const win = getCurrentWindow();

  /* =========================================================
   * 鼠标穿透
   * ========================================================= */
  let mode: PassthroughMode = "passthrough";
  let pollTimer = 0; // 穿透期间的轮询句柄
  let mousemoveBound = false; // 接收模式下 mousemove 快速路径是否挂着
  let entering = false; // setIgnore 调用进行中（防重入）

  /** 物理坐标 → 窗口内逻辑坐标（÷devicePixelRatio，与 webview 缩放一致） */
  function physicalToWindowLogical(
    cursor: { x: number; y: number },
    origin: { x: number; y: number },
    dpr: number,
  ): { x: number; y: number } {
    return { x: (cursor.x - origin.x) / dpr, y: (cursor.y - origin.y) / dpr };
  }

  /** 逻辑坐标是否在命中区内（ellipse=SVG 身体椭圆；rect=全窗口，网易云视频模式） */
  function insideBodyEllipse(p: { x: number; y: number }): boolean {
    if (hitShape === "rect") {
      return p.x >= 0 && p.x <= 220 && p.y >= 0 && p.y <= 220;
    }
    const dx = (p.x - HIT_ELLIPSE.cx) / HIT_ELLIPSE.rx;
    const dy = (p.y - HIT_ELLIPSE.cy) / HIT_ELLIPSE.ry;
    return dx * dx + dy * dy <= 1;
  }

  /** 穿透模式：轮询光标，进入身体 → 切接收模式 */
  function startPolling(): void {
    stopPolling();
    const tick = (): void => {
      pollTimer = window.setTimeout(async () => {
        try {
          const [cursor, origin] = await Promise.all([cursorPosition(), win.outerPosition()]);
          const dpr = window.devicePixelRatio || 1;
          const local = physicalToWindowLogical(cursor, origin, dpr);
          if (insideBodyEllipse(local)) {
            await enterInteractive();
          }
        } catch {
          // 轮询出错（无权限等）：降级常驻可点击，别让桌宠点不了
          await degradeToAlwaysInteractive();
          return;
        }
        if (mode === "passthrough") tick(); // 链式续期
      }, HOVER_POLL_MS);
    };
    tick();
  }

  function stopPolling(): void {
    window.clearTimeout(pollTimer);
    pollTimer = 0;
  }

  /** 底层切换：只在实际需要变化时调用 */
  async function setIgnore(ignore: boolean): Promise<void> {
    await win.setIgnoreCursorEvents(ignore);
  }

  /** 进入接收模式（可点击） */
  async function enterInteractive(): Promise<void> {
    if (entering || mode === "interactive" || mode === "unsupported") return;
    entering = true;
    try {
      await setIgnore(false);
      mode = "interactive";
      stopPolling();
      bindMousemove();
    } catch (err) {
      console.warn("[pet] 关闭穿透失败，降级为常驻可点击:", err);
      await degradeToAlwaysInteractive();
    } finally {
      entering = false;
    }
  }

  /** 回到穿透模式 */
  async function enterPassthrough(): Promise<void> {
    if (entering || mode === "passthrough" || mode === "unsupported") return;
    entering = true;
    try {
      await setIgnore(true);
      mode = "passthrough";
      unbindMousemove();
      startPolling();
    } catch (err) {
      console.warn("[pet] 恢复穿透失败，降级为常驻可点击:", err);
      await degradeToAlwaysInteractive();
    } finally {
      entering = false;
    }
  }

  /** 降级：常驻可点击（穿透 API 不可用） */
  async function degradeToAlwaysInteractive(): Promise<void> {
    mode = "unsupported";
    stopPolling();
    unbindMousemove();
    try {
      await setIgnore(false);
    } catch {
      /* 连 false 都设置不了，说明本来就没开穿透，保持现状 */
    }
  }

  /** 接收模式下的 mousemove 快速路径：target 离开命中区 → 立刻恢复穿透 */
  function onFastMousemove(e: MouseEvent): void {
    if (!isHitTarget(e.target)) void enterPassthrough();
  }

  function bindMousemove(): void {
    if (mousemoveBound) return;
    mousemoveBound = true;
    document.addEventListener("mousemove", onFastMousemove, { capture: true });
  }

  function unbindMousemove(): void {
    if (!mousemoveBound) return;
    mousemoveBound = false;
    document.removeEventListener("mousemove", onFastMousemove, { capture: true });
  }

  // 初始化：尝试整窗穿透；失败则降级
  try {
    await setIgnore(true);
    startPolling();
  } catch (err) {
    console.warn("[pet] setIgnoreCursorEvents 不可用，降级为常驻可点击:", err);
    await degradeToAlwaysInteractive();
  }

  /* =========================================================
   * 点击 / 拖拽 / 双击
   * ========================================================= */
  let downX = 0;
  let downY = 0;
  let pressed = false;
  let dragged = false; // 本轮按下是否已判定为拖拽
  let lastClickAt = 0; // 上一次有效点击时间戳（双击判定）

  function savePositionAfterDrag(): void {
    // startDragging() 在 Windows 上阻塞至松开；resolve 后再取位置就是拖拽终点
    win
      .outerPosition()
      .then((pos) => invoke("save_pet_position", { x: pos.x, y: pos.y }))
      .catch((err) => console.warn("[pet] save_pet_position 失败:", err));
  }

  // pointerdown：记录起点；等 move 超阈值再 startDragging，< 5px 仍算点击
  // 双宿主：SVG 椭圆 + 视频矩形层（网易云皮肤时椭圆在 display:none 的 SVG 里收不到事件）
  const hitHosts: (Element & GlobalEventHandlers)[] = [dom.hit, dom.videoHit];
  for (const host of hitHosts) {
    host.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return; // 只处理左键
      pressed = true;
      dragged = false;
      downX = e.clientX;
      downY = e.clientY;
    });
    host.addEventListener("pointermove", (e: PointerEvent) => {
      if (!pressed || dragged) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) >= DRAG_THRESHOLD_PX) {
        dragged = true;
        handlers.onDragStart?.();
        void invoke("set_pet_drag", { active: true }).catch(() => {});
        win
          .startDragging()
          .then(() => void confirmDragEnd())
          .catch((err) => {
            console.warn("[pet] startDragging 失败:", err);
            void finishDrag();
          });
      }
    });

    /** 拖动结束确认：startDragging 可能因事件竞争提前 resolve（人还按着），
     *  用左键物理状态确认真正松手后才触发 onDragEnd（防飞翔被提前切走） */
    async function confirmDragEnd(): Promise<void> {
      for (let i = 0; i < 125; i++) { // 最多 ~10s 保险
        try {
          const down = await invoke<boolean>("left_button_down");
          if (!down) break; // 左键真的抬起了
        } catch {
          break; // 查询失败（非 Windows 真机）：退化为立即结束
        }
        await new Promise((r) => setTimeout(r, 80));
      }
      await finishDrag();
    }

    async function finishDrag(): Promise<void> {
      savePositionAfterDrag();
      void invoke("set_pet_drag", { active: false }).catch(() => {});
      handlers.onDragEnd?.();
    }
    host.addEventListener("pointerup", (e: PointerEvent) => {
      if (!pressed) return;
      pressed = false;
      if (dragged) return; // 拖拽结束不算点击
      if (Math.hypot(e.clientX - downX, e.clientY - downY) >= DRAG_THRESHOLD_PX) return; // 保险

      const now = Date.now();
      if (now - lastClickAt <= DOUBLE_CLICK_MS) {
        lastClickAt = 0; // 防三连击再触发
        handlers.onDoubleClick();
      } else {
        lastClickAt = now;
        handlers.onClick();
      }
    });
    host.addEventListener("pointercancel", () => {
      pressed = false;
      dragged = false;
    });
  }
}
