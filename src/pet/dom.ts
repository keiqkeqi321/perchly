/**
 * 一次性收集桌宠需要的 DOM 引用（pet.html 中的静态骨架）。
 */

export interface PetDom {
  /** 最外层全窗口容器（视频层挂这里，脱离 .pet-inner 形变容器） */
  root: HTMLElement;
  /** 状态 class（is-xxx / act-xxx）挂载点 */
  stage: HTMLElement;
  /** 说话气泡容器 */
  bubble: HTMLElement;
  /** 气泡文字 */
  bubbleText: HTMLElement;
  /** 鹦鹉身体命中区（透明椭圆，接收指针事件 + 用于穿透判定） */
  hit: SVGEllipseElement;
  /** 视频模式矩形命中层（220x220 全窗口，网易云皮肤时显示） */
  videoHit: HTMLElement;
  /** SVG 鹦鹉本体（网易视频模式时隐藏） */
  svg: SVGSVGElement;
  /** SVG 所在的内层容器（网易 stage 的插入位） */
  inner: HTMLElement;
}

/** 查找必需元素，找不到直接抛错（骨架写错时尽早暴露） */
function required<T extends Element>(selector: string): T {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`[pet] 缺少必需元素: ${selector}`);
  return el as T;
}

export function getPetDom(): PetDom {
  return {
    root: required<HTMLElement>("#pet-root"),
    stage: required<HTMLElement>("#pet-stage"),
    bubble: required<HTMLElement>("#pet-bubble"),
    bubbleText: required<HTMLElement>("#pet-bubble-text"),
    hit: required<SVGEllipseElement>(".pet-hit"),
    videoHit: ensureVideoHit(),
    svg: required<SVGSVGElement>("#pet-svg"),
    inner: required<HTMLElement>(".pet-inner"),
  };
}

/** 视频命中层：动态创建（老骨架无需改 pet.html），仅创建时初始隐藏 */
function ensureVideoHit(): HTMLElement {
  let el = document.querySelector<HTMLElement>("#pet-video-hit");
  if (!el) {
    el = document.createElement("div");
    el.id = "pet-video-hit";
    el.style.display = "none";
    document.body.appendChild(el);
  }
  return el;
}
