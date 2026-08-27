export const SHARE_CARD_W = 720;
export const SHARE_CARD_H = 1280;

/** 底图 cover 铺满画布；返回是否成功绘制了底图 */
export function drawShareCardImageCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
): boolean {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (iw <= 0 || ih <= 0) {
    return false;
  }
  const s = Math.max(w / iw, h / ih);
  const dw = iw * s;
  const dh = ih * s;
  ctx.drawImage(img, 0, 0, iw, ih, (w - dw) * 0.5, (h - dh) * 0.5, dw, dh);
  return true;
}

/**
 * 在分享卡画布上绘制「总用时 + 秒数」；底图缺失时回退为渐变背景。
 * 画布尺寸固定 720×1280（导出用），与 CSS 缩放显示无关。
 */
export function drawShareCardTime(
  ctx: CanvasRenderingContext2D,
  bgImg: HTMLImageElement | null,
  secStr: string,
): void {
  const W = SHARE_CARD_W;
  const H = SHARE_CARD_H;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let hasBg = false;
  if (bgImg && bgImg.naturalWidth > 0) {
    hasBg = drawShareCardImageCover(ctx, bgImg, W, H);
  }
  if (!hasBg) {
    const gF = ctx.createLinearGradient(0, 0, W, H);
    gF.addColorStop(0, '#2a1a22');
    gF.addColorStop(1, '#1a1520');
    ctx.fillStyle = gF;
    ctx.fillRect(0, 0, W, H);
  }

  const cx = W * 0.5;
  /** 大号秒数几何中心约在整图高度 70% 处（相对 720×1280 导出画布） */
  const yTimeCenter = H * 0.7;
  const yLabel = yTimeCenter - 86;
  const ySec = yTimeCenter;
  const yUnit = yTimeCenter + 62;

  ctx.fillStyle = 'rgba(80, 55, 65, 0.88)';
  ctx.font = '22px "PingFang SC", "Hiragino Sans GB", sans-serif';
  ctx.fillText('总用时', cx, yLabel);

  ctx.save();
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.88)';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.fillStyle = '#c73d5e';
  ctx.font = 'bold 96px "PingFang SC", "Hiragino Sans GB", sans-serif';
  ctx.strokeText(String(secStr), cx, ySec);
  ctx.fillText(String(secStr), cx, ySec);
  ctx.restore();

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(95, 70, 78, 0.88)';
  ctx.font = '32px "PingFang SC", sans-serif';
  ctx.fillText('秒', cx, yUnit);
}
