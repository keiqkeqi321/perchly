/**
 * 网易云桌宠动画资源播放器（直显模式）
 *
 * 资源特征（docs/NETEASE_PET_REVERSE.md）：
 * - WebM(VP9) 无 Alpha，背景为纯色但每条不同（39灰~255白）
 * - 正方形，~4s/动作循环，多分辨率档（640/960/1080/1440）
 *
 * 呈现策略：视频本体 + CSS 圆角（贴纸卡观感）。
 * 不做色距抠像——深灰背景视频的眼珠与背景色距过近，抠像必掉眼睛（实证见 DEVLOG）。
 */

export class NeteasePetPlayer {
  private video: HTMLVideoElement;

  /** @param src WebM URL */
  constructor(src: string) {
    this.video = document.createElement("video");
    Object.assign(this.video, {
      src, loop: true, muted: true, playsInline: true,
      crossOrigin: "anonymous",
      preload: "auto",
    });
    this.video.className = "netease-raw";
  }

  /** 挂载并就绪（返回是否成功；失败 false 走降级） */
  async attach(container: HTMLElement): Promise<boolean> {
    container.appendChild(this.video);
    await new Promise<void>((res) => {
      if (this.video.readyState >= 2) return res();
      this.video.addEventListener("loadeddata", () => res(), { once: true });
      this.video.addEventListener("error", () => res(), { once: true });
    });
    if (!this.video.videoWidth) return false; // 加载失败
    this.play();
    return true;
  }

  play() { void this.video.play(); }
  pause() { this.video.pause(); }

  /** 视频时长 ms（轮播调度用） */
  get durationMs(): number {
    return Number.isFinite(this.video.duration) ? this.video.duration * 1000 : 4000;
  }

  destroy() {
    this.pause();
    this.video.remove();
  }
}
