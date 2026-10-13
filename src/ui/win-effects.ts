const WIN_CONFETTI_COLORS = [
  '#ff8fb3',
  '#ffe066',
  '#fff0e8',
  '#a8e6cf',
  '#e85d8a',
  '#ffd0e8',
  '#ffaa90',
  '#c8b5ff',
];

const TWO_PI = Math.PI * 2;
const WIN_FX_MS = 3200;
export function createWinEffects(winFxCanvas: HTMLCanvasElement) {
  let winConfettiRaf = 0;
  function stop(): void {
    if (winConfettiRaf) {
      cancelAnimationFrame(winConfettiRaf);
      winConfettiRaf = 0;
    }
    const wctx = winFxCanvas.getContext('2d');
    if (wctx) {
      wctx.setTransform(1, 0, 0, 1, 0, 0);
      wctx.clearRect(0, 0, winFxCanvas.width, winFxCanvas.height);
    }
  }

  interface ConfettiP {
    x: number;
    y: number;
    vx: number;
    vy: number;
    ay: number;
    rot: number;
    vr: number;
    w: number;
    h: number;
    c: string;
  }

  function start(): void {
    stop();
    const wctx = winFxCanvas.getContext('2d');
    if (!wctx) return;
    const parent = winFxCanvas.parentElement;
    const rect = parent ? parent.getBoundingClientRect() : { width: 400, height: 700 };
    const cw = Math.max(1, Math.floor(rect.width));
    const ch = Math.max(1, Math.floor(rect.height));
    const dprLocal = Math.min(
      typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1,
      2,
    );
    winFxCanvas.width = cw * dprLocal;
    winFxCanvas.height = ch * dprLocal;
    winFxCanvas.style.width = cw + 'px';
    winFxCanvas.style.height = ch + 'px';
    wctx.setTransform(dprLocal, 0, 0, dprLocal, 0, 0);
    const cx = cw * 0.5;
    const cy = ch * 0.4;
    const P: ConfettiP[] = [];
    for (let i = 0; i < 88; i++) {
      const ang = Math.random() * TWO_PI;
      const sp = 5 + Math.random() * 14;
      P.push({
        x: cx + (Math.random() - 0.5) * 24,
        y: cy + (Math.random() - 0.5) * 24,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 3.2,
        ay: 0.18 + Math.random() * 0.12,
        rot: Math.random() * TWO_PI,
        vr: (Math.random() - 0.5) * 0.14,
        w: 3 + Math.random() * 5,
        h: 4 + Math.random() * 7,
        c: WIN_CONFETTI_COLORS[i % WIN_CONFETTI_COLORS.length]!,
      });
    }
    for (let i = 0; i < 36; i++) {
      P.push({
        x: Math.random() * cw,
        y: -10 - Math.random() * 48,
        vx: (Math.random() - 0.5) * 1.4,
        vy: 1.4 + Math.random() * 2.2,
        ay: 0.045,
        rot: Math.random() * TWO_PI,
        vr: 0.03 * (Math.random() - 0.5),
        w: 3 + Math.random() * 4,
        h: 4 + Math.random() * 5,
        c: WIN_CONFETTI_COLORS[(i + 3) % WIN_CONFETTI_COLORS.length]!,
      });
    }
    const t0 = performance.now();
    const frame = (): void => {
      const elapsed = performance.now() - t0;
      wctx.clearRect(0, 0, cw, ch);
      for (const p of P) {
        p.vy += p.ay;
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.998;
        p.rot += p.vr;
        if (p.y > ch + 30 || p.x < -40 || p.x > cw + 40) {
          continue;
        }
        wctx.save();
        wctx.translate(p.x, p.y);
        wctx.rotate(p.rot);
        wctx.fillStyle = p.c;
        wctx.fillRect(-p.w * 0.5, -p.h * 0.5, p.w, p.h);
        wctx.restore();
      }
      if (elapsed < WIN_FX_MS) {
        winConfettiRaf = requestAnimationFrame(frame);
      } else {
        winConfettiRaf = 0;
        wctx.clearRect(0, 0, cw, ch);
      }
    };
    winConfettiRaf = requestAnimationFrame(frame);
  }

  return { start, stop };
}
