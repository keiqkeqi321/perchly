/**
 * 一次性收集桌宠需要的 DOM 引用（pet.html 中的静态骨架）。
 */

export interface PetDom {
  /** 状态 class（is-xxx / act-xxx）挂载点 */
  stage: HTMLElement;
  /** 说话气泡容器 */
  bubble: HTMLElement;
  /** 气泡文字 */
  bubbleText: HTMLElement;
  /** 鹦鹉身体命中区（透明椭圆，接收指针事件 + 用于穿透判定） */
  hit: SVGEllipseElement;
}

/** 查找必需元素，找不到直接抛错（骨架写错时尽早暴露） */
function required<T extends Element>(selector: string): T {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`[pet] 缺少必需元素: ${selector}`);
  return el as T;
}

export function getPetDom(): PetDom {
  return {
    stage: required<HTMLElement>("#pet-stage"),
    bubble: required<HTMLElement>("#pet-bubble"),
    bubbleText: required<HTMLElement>("#pet-bubble-text"),
    hit: required<SVGEllipseElement>(".pet-hit"),
  };
}
