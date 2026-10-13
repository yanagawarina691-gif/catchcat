import * as THREE from 'three';
import { GAME_CONFIG, CAT_HIDE_SPOTS } from './game/config';
import { pickHideSpot } from './game/rules';
import { GameSession } from './game/session';
import { createResultView } from './ui/result-view';
import { settingsStore, applySettings } from './ui/settings';
import { saveBest } from './game/storage';
import { capPixelRatio, bindWebGLLifecycle } from './render/lifecycle';
import {
  initSfxPreload,
  initSfxDecode,
  initBgmPreload,
  startBgm,
  stopBgm,
  pauseBgm,
  playKittenMew,
  playMeow,
  playCatchWithHappyKittenMew,
  playWinCelebration,
  ensureAudio,
} from './game/audio';

(function () {
  'use strict';

  const FOV_DEG = 60;
  const TWO_PI = Math.PI * 2;
  const HUNT_LIMIT_MS = GAME_CONFIG.huntLimitMs;
  const INTRO_MS = GAME_CONFIG.introMs;
  const CAT_HINT_NO_SIGHT_MS = 3000;
  const INTRO_SUB_DEFAULT = '帮我找到猫猫，抓到可能也会跑哦';
  const TAP_MOVE_MAX = 40;
  const CAT_HIT_COS = Math.cos(0.22);
  const CAT_HIT_R_FRAC = 0.12;
  const CAT_DRAW_H_FRAC = 0.22;
  const ERROR_TEXT = '哎呀，出错了，请重启试试吧~';
  const PANO_IMAGE =
    './images/M3_Anime_equirectangular-jpg_A_cozy_pink_anime_1020730682_15264727.jpg';
  const SPAWN_PHI_LO = 0.22 * Math.PI;
  const SPAWN_PHI_HI = 0.78 * Math.PI;
  const PITCH_PHI_COVER_RAD = THREE.MathUtils.degToRad(4.5);

  const GYRO_SMOOTH = 0.3;
  const GYRO_GAIN = 0.95;
  const GYRO_MAX_STEP_DEG = 7;
  const GYRO_APPLY_MIN = 0.03;
  const CAUGHT_IMAGE_MS = 500;
  const CAT_ESCAPE_SUB_MS = 1000;
  const dragThreshold = 14;

  /**
   * E2E 测试专用模式：仅在本机 localhost + ?e2e=1 时生效，生产环境带参访问也不会改变行为。
   * - 猫固定出现在视野正中央（便于 Playwright 稳定点击）
   * - 第三只不再逃跑（保证通关流程可断言）
   */
  const E2E_MODE =
    (location.hostname === 'localhost' || location.hostname === '127.0.0.1') &&
    /[?&]e2e=1(?:&|$)/.test(location.search);

  /** 统一取元素：缺失即抛错（由 boot() 顶层捕获并显示错误提示），避免散落的 null 判断不一致 */
  function getEl<T extends HTMLElement = HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) {
      throw new Error('missing element #' + id);
    }
    return node as T;
  }

  function showError(): void {
    const el = document.getElementById('errorMsg');
    if (el) {
      el.textContent = ERROR_TEXT;
      el.classList.add('show');
    }
  }

  function boot(): void {
    const canvas = getEl<HTMLCanvasElement>('gameCanvas');
    const overlay = getEl<HTMLCanvasElement>('overlayCanvas');
    const ctx = overlay.getContext('2d')!;
    const elTitle = getEl('titleLine');
    /** index.html 里 #titleLine 的初始文案，全景就绪后作 HUD 闲时标题（改 HTML 即生效） */
    const HUD_TITLE_PANO_IDLE = elTitle.textContent ? elTitle.textContent.trim() : '';
    const elStats = getEl('statsLine');
    const elCatchTimeHud = getEl('catchTimeHud');
    const elTimerWrap = getEl('timerWrap');
    const elTimerFill = getEl('timerFill');
    const elStart = getEl('startPanel');
    const elWin = getEl('winPanel');
    const winFxCanvas = getEl<HTMLCanvasElement>('winFxCanvas');
    const elGameIntroSubWrap = getEl('gameIntroSubWrap');
    const elGameIntroSub = getEl('gameIntroSub');
    const elWinLeaderboardList = getEl('winLeaderboardList');
    const elCatEscapeSub = getEl('catEscapeSub');
    const elCardPanel = getEl('cardPanel');
    const btnStart = getEl<HTMLButtonElement>('btnStart');
    const btnGyro = getEl<HTMLButtonElement>('gyroBtn');
    const btnCard = getEl<HTMLButtonElement>('btnCard');
    const btnAgain = getEl<HTMLButtonElement>('btnAgain');
    const btnBackWin = getEl<HTMLButtonElement>('btnBackWin');
    const btnSaveCard = getEl<HTMLButtonElement>('btnSaveCard');
    const cardCanvas = getEl<HTMLCanvasElement>('cardCanvas');
    const resultView = createResultView({
      win: elWin,
      card: elCardPanel,
      time: getEl('winTimeText'),
      leaderboard: elWinLeaderboardList,
      cardCanvas,
      confettiCanvas: winFxCanvas,
    });
    let resultTimer = 0;

    const introSubDisplay = ((): string => {
      const t = elGameIntroSubWrap.getAttribute('data-intro-text');
      if (t && String(t).trim()) {
        return String(t).trim();
      }
      return INTRO_SUB_DEFAULT;
    })();

    let catEscapeSubHideTimer = 0;
    let catEscapeSubCleanupTimer = 0;

    const handImg = new Image();
    let handImageReady = false;
    /**
     * 手部2.png：唯一定位点 = 图片左上角 (像素 0,0) → 对应 drawImage 的 (dx,dy)，钉死不改。
     * 每帧用该点从「休息坐标」向「点击坐标 (handAim)」做插值，整张贴图只跟这一个点动。
     */
    const REST_ANCHOR_X_FRAC = -0.08;
    const REST_ANCHOR_Y_FRAC = 0.82;
    let handAimX = 0.5;
    let handAimY = 0.45;

    handImg.onload = () => {
      handImageReady = true;
    };
    handImg.onerror = () => {
      handImageReady = false;
    };
    handImg.src = './images/手部2.png';

    const CAT_IMG_PATHS = ['./images/猫腰.png', './images/猫趴1.png', './images/猫躺1.png'];
    const CAT_IMG_CAUGHT = './images/猫被抓.png';
    const catImgEls: HTMLImageElement[] = [];
    for (const path of CAT_IMG_PATHS) {
      const ci = new Image();
      catImgEls.push(ci);
      ci.src = path;
    }
    const catImgCaught = new Image();
    catImgCaught.src = CAT_IMG_CAUGHT;

    let catPicIndex = 0;
    let catCaughtUntil = 0;

    let w = 0;
    let h = 0;
    let dpr = 1;

    let camera: THREE.PerspectiveCamera | null = null;
    let scene: THREE.Scene | null = null;
    let renderer: THREE.WebGLRenderer | null = null;
    let raycaster: THREE.Raycaster | null = null;
    const spherical = new THREE.Spherical(1, Math.PI / 2, 0);
    const lookTarget = new THREE.Vector3();
    const catDir = new THREE.Vector3();
    const tempV = new THREE.Vector3();
    const vZee = new THREE.Vector3(0, 0, 1);
    const qGyro = new THREE.Quaternion();
    const qGyroPrev = new THREE.Quaternion();
    const qGyroRel = new THREE.Quaternion();
    const q0Screen = new THREE.Quaternion();
    const q1Fix = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
    const eulerGyro = new THREE.Euler();
    const eulerGyroDelta = new THREE.Euler();
    const sphCal = new THREE.Spherical();
    let gyroQPrevValid = false;
    let panoReady = false;

    const session = new GameSession();
    let tLastSawCatOnScreen = 0;
    let catTheta = 0;
    let catPhi = Math.PI / 2;
    let lastCatSpotIndex = -1;
    let yawTouch = 0;
    let yawGyro = 0;
    let pitchGyro = 0;
    let pitchTouch = 0;
    let gyroOn = false;
    let gyroDeltaSmooth = 0;
    let gyroDeltaSmoothPitch = 0;
    let gyroListenerAttached = false;
    let onOrientationChangeHandler: (() => void) | null = null;
    let handT = 0;
    let lastFrame = 0;

    function mod(a: number): number {
      return ((a % TWO_PI) + TWO_PI) % TWO_PI;
    }

    function getPitchAllClamp(): { min: number; max: number } {
      return {
        min: Math.PI / 2 - PANO_PITCH_PHI_MAX,
        max: Math.PI / 2 - PANO_PITCH_PHI_MIN,
      };
    }

    function getScreenOrientationAngleRad(): number {
      try {
        if (
          window.screen &&
          window.screen.orientation &&
          typeof window.screen.orientation.angle === 'number'
        ) {
          return THREE.MathUtils.degToRad(window.screen.orientation.angle);
        }
      } catch {
        /* ignore */
      }
      const legacyOrientation = (window as unknown as { orientation?: number }).orientation;
      if (typeof legacyOrientation === 'number') {
        return THREE.MathUtils.degToRad(legacyOrientation);
      }
      return 0;
    }

    /** 与 Three DeviceOrientationControls 一致：YXZ 欧拉 + 机背朝前 + 屏幕旋转 */
    function setDeviceQuaternionFromOrientationEvent(
      out: THREE.Quaternion,
      ev: DeviceOrientationEvent,
    ): void {
      const a = ev.alpha != null && !isNaN(ev.alpha) ? THREE.MathUtils.degToRad(ev.alpha) : 0;
      const b = ev.beta != null && !isNaN(ev.beta) ? THREE.MathUtils.degToRad(ev.beta) : 0;
      const g = ev.gamma != null && !isNaN(ev.gamma) ? THREE.MathUtils.degToRad(ev.gamma) : 0;
      eulerGyro.set(b, a, -g, 'YXZ');
      out.setFromEuler(eulerGyro);
      out.multiply(q1Fix);
      out.multiply(q0Screen.setFromAxisAngle(vZee, -getScreenOrientationAngleRad()));
    }

    const PANO_PITCH_PHI = ((): { min: number; max: number } => {
      let minS = Infinity;
      let maxS = -Infinity;
      for (const s of CAT_HIDE_SPOTS) {
        minS = Math.min(minS, s.phi - s.jitterPhi);
        maxS = Math.max(maxS, s.phi + s.jitterPhi);
      }
      return {
        min: THREE.MathUtils.clamp(minS - PITCH_PHI_COVER_RAD, SPAWN_PHI_LO, SPAWN_PHI_HI),
        max: THREE.MathUtils.clamp(maxS + PITCH_PHI_COVER_RAD, SPAWN_PHI_LO, SPAWN_PHI_HI),
      };
    })();
    const PANO_PITCH_PHI_MIN = PANO_PITCH_PHI.min;
    const PANO_PITCH_PHI_MAX = PANO_PITCH_PHI.max;

    const CAT_CAL = ((): boolean => {
      try {
        return /[?&]catcal=1(?:&|$)/.test(String(window.location && window.location.search));
      } catch {
        return false;
      }
    })();

    /**
     * 躲藏点必须与「当前等距全景图（PANO_IMAGE）贴到球上的方向」一致，不能乱用水平随机角。
     * 用浏览器打开 `index.html?catcal=1`，开一局后转动视角对准目标位置，**轻点一下**（不要拖），
     * 打开开发者工具控制台，会打印一条 JSON，把其中的 theta/phi 复制进 src/game/config.ts 的 CAT_HIDE_SPOTS。
     */
    function pickCat(): void {
      const fallback = (): void => {
        catPicIndex = catImgEls.length > 0 ? Math.floor(Math.random() * catImgEls.length) : 0;
        catTheta = mod(Math.random() * TWO_PI);
        catPhi = Math.PI * 0.5;
        catDir.setFromSpherical(new THREE.Spherical(1, catPhi, catTheta));
      };
      if (CAT_HIDE_SPOTS.length < 1) {
        lastCatSpotIndex = -1;
        fallback();
        return;
      }
      if (E2E_MODE) {
        lastCatSpotIndex = -1;
        catPicIndex = catImgEls.length > 0 ? Math.floor(Math.random() * catImgEls.length) : 0;
        catTheta = Math.PI;
        catPhi = Math.PI / 2;
        catDir.setFromSpherical(new THREE.Spherical(1, catPhi, catTheta));
        return;
      }
      const idx = pickHideSpot(CAT_HIDE_SPOTS, lastCatSpotIndex);
      lastCatSpotIndex = idx;
      const s = CAT_HIDE_SPOTS[idx]!;
      catPicIndex = catImgEls.length > 0 ? Math.floor(Math.random() * catImgEls.length) : 0;
      catTheta = mod(s.theta + (Math.random() * 2 - 1) * s.jitterTheta);
      catPhi = THREE.MathUtils.clamp(
        s.phi + (Math.random() * 2 - 1) * s.jitterPhi,
        SPAWN_PHI_LO,
        SPAWN_PHI_HI,
      );
      catDir.setFromSpherical(new THREE.Spherical(1, catPhi, catTheta));
    }

    function logCatCalibration(lx: number, ly: number): void {
      if (!camera || !raycaster || w < 1 || h < 1) {
        return;
      }
      const ndcX = (lx / w) * 2 - 1;
      const ndcY = -(ly / h) * 2 + 1;
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
      const dir = raycaster.ray.direction.clone().normalize();
      sphCal.setFromVector3(dir);
      const block = {
        id: 'spot_id',
        label: '在这里写中文名，例如 床底',
        theta: Number(sphCal.theta.toFixed(6)),
        phi: Number(sphCal.phi.toFixed(6)),
        jitterTheta: 0.06,
        jitterPhi: 0.04,
      };
      console.log(
        '%c【躲藏点】复制下面 JSON 到 src/game/config.ts 的 CAT_HIDE_SPOTS 里',
        'color:#7d9fff;font-weight:bold',
      );
      console.log(JSON.stringify(block, null, 2));
      console.log(
        '角度参考: theta=' +
          ((sphCal.theta * 180) / Math.PI).toFixed(2) +
          '°  phi=' +
          ((sphCal.phi * 180) / Math.PI).toFixed(2) +
          '°',
      );
    }

    function updateCamera(): void {
      if (!camera) return;
      const clP = getPitchAllClamp();
      const pitchAll = THREE.MathUtils.clamp(pitchTouch + pitchGyro, clP.min, clP.max);
      const phi = THREE.MathUtils.clamp(
        Math.PI / 2 - pitchAll,
        PANO_PITCH_PHI_MIN,
        PANO_PITCH_PHI_MAX,
      );
      spherical.phi = phi;
      spherical.theta = mod(-(yawTouch + yawGyro) + Math.PI);
      lookTarget.setFromSpherical(spherical);
      camera.position.set(0, 0, 0);
      camera.up.set(0, 1, 0);
      camera.lookAt(lookTarget);
    }

    function initPano3D(): void {
      try {
        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(FOV_DEG, w / Math.max(1, h), 0.1, 1000);
        camera.position.set(0, 0, 0.0001);
        raycaster = new THREE.Raycaster();
        renderer = new THREE.WebGLRenderer({
          canvas,
          antialias: true,
          alpha: false,
          powerPreference: 'high-performance',
        });
        renderer.setPixelRatio(dpr);
        bindWebGLLifecycle(
          canvas,
          renderer,
          () => {
            panoReady = false;
            const el = document.getElementById('errorMsg');
            if (el) {
              el.classList.add('show');
              el.textContent = '图形环境暂时不可用，正在等待浏览器恢复…';
            }
          },
          () => {
            const el = document.getElementById('errorMsg');
            if (el) {
              el.classList.remove('show');
            }
            window.location.reload();
          },
        );
        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
        loader.load(
          PANO_IMAGE,
          (tex) => {
            if (THREE.SRGBColorSpace !== undefined) {
              tex.colorSpace = THREE.SRGBColorSpace;
            }
            const g = new THREE.SphereGeometry(20, 72, 48);
            g.scale(-1, 1, 1);
            const mat = new THREE.MeshBasicMaterial({ map: tex });
            scene?.add(new THREE.Mesh(g, mat));
            panoReady = true;
            elTitle.textContent = CAT_CAL
              ? '校准：转动画面对准躲藏处，轻点一下 → 控制台复制 JSON'
              : HUD_TITLE_PANO_IDLE || '转动手机，找到躲起来的小猫';
          },
          undefined,
          () => {
            showError();
          },
        );
      } catch {
        showError();
      }
    }

    function resize(): void {
      dpr = capPixelRatio(window.devicePixelRatio || 1);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      overlay.width = Math.floor(w * dpr);
      overlay.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (renderer) {
        renderer.setPixelRatio(dpr);
        renderer.setSize(w, h, false);
      }
      if (camera) {
        camera.aspect = w / Math.max(1, h);
        camera.updateProjectionMatrix();
      }
      // 菜单页（未开局）不常驻渲染，resize 后重绘一帧即可
      if (!session.active && panoReady && scene && camera && renderer) {
        updateCamera();
        renderer.render(scene, camera);
      }
    }

    function projectCatToScreen(): { x: number; y: number } | null {
      if (!camera) return null;
      tempV.copy(catDir).multiplyScalar(12);
      tempV.project(camera);
      if (tempV.z > 1) {
        return null;
      }
      if (Math.abs(tempV.x) > 1.15 || Math.abs(tempV.y) > 1.2) {
        return null;
      }
      return {
        x: (tempV.x * 0.5 + 0.5) * w,
        y: (tempV.y * -0.5 + 0.5) * h,
      };
    }

    /** 猫在屏外时：在画面中部偏外缘给出箭头位置与朝向 */
    function getCatScreenHint(): { x: number; y: number; ang: number } | null {
      if (!camera) {
        return null;
      }
      tempV.copy(catDir).multiplyScalar(12);
      tempV.project(camera);
      let nx = tempV.x;
      let ny = tempV.y;
      if (tempV.z > 1) {
        nx = -nx;
        ny = -ny;
      }
      const cx = w * 0.5;
      const cy = h * 0.5;
      const sx = (nx * 0.5 + 0.5) * w;
      const sy = (-ny * 0.5 + 0.5) * h;
      let dx = sx - cx;
      let dy = sy - cy;
      const len = Math.hypot(dx, dy) || 1e-4;
      dx /= len;
      dy /= len;
      const edge = Math.min(w, h) * 0.38;
      return {
        x: cx + dx * edge,
        y: cy + dy * edge,
        ang: Math.atan2(dy, dx),
      };
    }

    function drawHintArrow(x: number, y: number, ang: number): void {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang);
      ctx.fillStyle = 'rgba(255, 210, 150, 0.96)';
      ctx.strokeStyle = 'rgba(160, 80, 50, 0.92)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(24, 0);
      ctx.lineTo(-10, 15);
      ctx.lineTo(-3, 0);
      ctx.lineTo(-10, -15);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    function drawHand(): void {
      if (handT <= 0 || !handImageReady) {
        return;
      }
      const iw = handImg.naturalWidth;
      const ih = handImg.naturalHeight;
      if (iw < 1 || ih < 1) {
        return;
      }
      const reach = 1 - handT;
      const t = 1 - (1 - reach) * (1 - reach);
      const drawH = h * 0.42;
      const drawW = (iw / ih) * drawH;
      const restX = w * REST_ANCHOR_X_FRAC;
      const restY = h * REST_ANCHOR_Y_FRAC;
      const x = restX + (handAimX - restX) * t;
      const y = restY + (handAimY - restY) * t;
      ctx.save();
      ctx.globalAlpha = 0.99;
      ctx.drawImage(handImg, 0, 0, iw, ih, x, y, drawW, drawH);
      ctx.restore();
    }

    function drawCatAtScreen(
      cx: number,
      cy: number,
      scale: number,
      fluffed: boolean,
      showCaught: boolean,
    ): void {
      const useFluff = fluffed && !showCaught;
      const fluffMul = useFluff ? 1.2 : 1;
      const baseH = h * CAT_DRAW_H_FRAC;
      const drawH = baseH * scale * fluffMul;
      ctx.save();
      if (showCaught && catImgCaught.naturalWidth > 0) {
        const src = catImgCaught;
        const drawW = (src.naturalWidth / src.naturalHeight) * drawH;
        ctx.drawImage(
          src,
          0,
          0,
          src.naturalWidth,
          src.naturalHeight,
          cx - drawW * 0.5,
          cy - drawH * 0.5,
          drawW,
          drawH,
        );
        ctx.restore();
        return;
      }
      const img = catImgEls[catPicIndex];
      if (img && img.naturalWidth > 0) {
        const drawW = (img.naturalWidth / img.naturalHeight) * drawH;
        ctx.translate(cx, cy);
        if (useFluff) {
          for (let i = 0; i < 10; i++) {
            const ang = (i / 10) * TWO_PI;
            ctx.strokeStyle = 'rgba(255,180,200,.6)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(Math.cos(ang) * 36, Math.sin(ang) * 22);
            ctx.lineTo(Math.cos(ang) * 52, Math.sin(ang) * 32);
            ctx.stroke();
          }
        }
        ctx.drawImage(
          img,
          0,
          0,
          img.naturalWidth,
          img.naturalHeight,
          -drawW * 0.5,
          -drawH * 0.5,
          drawW,
          drawH,
        );
      } else {
        const s0 = scale * fluffMul;
        ctx.translate(cx, cy);
        ctx.scale(s0, s0);
        if (useFluff) {
          for (let j = 0; j < 10; j++) {
            const ang2 = (j / 10) * TWO_PI;
            ctx.strokeStyle = 'rgba(255,180,200,.6)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(Math.cos(ang2) * 36, Math.sin(ang2) * 22);
            ctx.lineTo(Math.cos(ang2) * 52, Math.sin(ang2) * 32);
            ctx.stroke();
          }
        }
        ctx.fillStyle = '#f5a87a';
        ctx.beginPath();
        ctx.ellipse(0, 5, 38, 28, 0, 0, TWO_PI);
        ctx.fill();
        ctx.fillStyle = '#e89560';
        ctx.beginPath();
        ctx.moveTo(-20, -15);
        ctx.lineTo(-28, -40);
        ctx.lineTo(-8, -22);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(20, -15);
        ctx.lineTo(28, -40);
        ctx.lineTo(8, -22);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.arc(-12, 2, 5, 0, TWO_PI);
        ctx.arc(12, 2, 5, 0, TWO_PI);
        ctx.fill();
        ctx.fillStyle = '#ff8899';
        ctx.beginPath();
        ctx.ellipse(0, 10, 6, 4, 0, 0, Math.PI);
        ctx.fill();
      }
      ctx.restore();
    }

    function drawVignette(): void {
      const r = Math.max(w, h) * 0.75;
      const g = ctx.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.45, r);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.55, 'rgba(0,0,0,0.06)');
      g.addColorStop(1, 'rgba(0,0,0,0.3)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    function drawScene2D(isFluff: boolean): void {
      ctx.clearRect(0, 0, w, h);
      const p = projectCatToScreen();
      if (p && session.phase === 'hunt') {
        tLastSawCatOnScreen = Date.now();
      }
      if (p && (session.phase === 'hunt' || session.phase === 'fluff')) {
        const cy = p.y + Math.sin(lastFrame * 0.006) * 2;
        const showCaught = session.phase === 'fluff' && Date.now() < catCaughtUntil;
        drawCatAtScreen(p.x, cy, 1, isFluff, showCaught);
      }
      drawHand();
      drawVignette();
      if (session.phase === 'hunt' && session.spawnedAt > 0 && !p) {
        const refT2 = tLastSawCatOnScreen > 0 ? tLastSawCatOnScreen : session.spawnedAt;
        if (Date.now() - refT2 >= CAT_HINT_NO_SIGHT_MS) {
          const hpt2 = getCatScreenHint();
          if (hpt2) {
            drawHintArrow(hpt2.x, hpt2.y, hpt2.ang);
          }
        }
      }
    }

    function updateCatchTimeHud(): void {
      if (!session.roundSeconds.length) {
        elCatchTimeHud.textContent = '';
        elCatchTimeHud.style.display = 'none';
        return;
      }
      elCatchTimeHud.style.display = 'block';
      elCatchTimeHud.textContent = session.roundSeconds
        .map((sec, i) => '第' + String(i + 1) + '次 ' + String(sec) + 's')
        .join(' · ');
    }

    /**
     * HUD 更新：计时条每帧更新（需要动画），但标题/统计文本只在状态变化时写入，
     * 避免 aria-live 区域被读屏反复播报。
     */
    let lastHudKey = '';
    function updateHUD(): void {
      if (!session.active) return;
      if (session.phase === 'intro') {
        const key = 'intro:' + String(session.catches) + ':' + String(gyroOn);
        if (key !== lastHudKey) {
          lastHudKey = key;
          elTitle.textContent = '找猫中 ' + String(session.catches) + '/3 · 即将开始';
          elStats.textContent = '全景 360° ·' + (gyroOn ? ' 陀螺仪已开' : ' 可点补开');
          elCatchTimeHud.textContent = '';
          elCatchTimeHud.style.display = 'none';
          elTimerWrap.style.display = 'block';
        }
        if (session.introEndsAt > 0) {
          const leftIntro = Math.max(0, session.introEndsAt - Date.now());
          const rIntro = Math.max(0, leftIntro / INTRO_MS);
          elTimerFill.style.transform = 'scaleX(' + String(rIntro) + ')';
        } else {
          elTimerFill.style.transform = 'scaleX(1)';
        }
        return;
      }
      const key =
        'hunt:' +
        String(session.catches) +
        ':' +
        String(gyroOn) +
        ':' +
        String(session.escapeCount) +
        ':' +
        session.phase;
      if (key !== lastHudKey) {
        lastHudKey = key;
        elTitle.textContent = '找猫中 ' + String(session.catches) + '/3';
        elStats.textContent =
          '全景 360° ·' +
          (gyroOn ? ' 陀螺仪已开' : ' 可点补开') +
          (session.catches === GAME_CONFIG.catchesToWin - 1 && session.escapeCount > 0
            ? ' · 第3只已溜走 ' +
              String(session.escapeCount) +
              '/' +
              String(GAME_CONFIG.maxThirdCatEscapes) +
              ' 次'
            : '');
        if (session.phase === 'hunt') {
          elTimerWrap.style.display = 'block';
        } else if (session.phase === 'fluff') {
          elTimerWrap.style.display = 'none';
          elTimerFill.style.transform = 'scaleX(0)';
        }
      }
      if (session.phase === 'hunt') {
        const left = HUNT_LIMIT_MS - (Date.now() - session.spawnedAt);
        const r = Math.max(0, left / HUNT_LIMIT_MS);
        elTimerFill.style.transform = 'scaleX(' + String(r) + ')';
      }
    }

    let rafActive = false;
    function onFrame(): void {
      rafActive = false;
      if (!session.active) {
        if (ctx && w > 0) {
          ctx.clearRect(0, 0, w, h);
        }
        if (panoReady && scene && camera && renderer) {
          updateCamera();
          renderer.render(scene, camera);
        } else if (ctx && w > 0) {
          ctx.fillStyle = '#1a1a20';
          ctx.fillRect(0, 0, w, h);
        }
        // 菜单页静态渲染一帧即可；校准模式需要拖拽实时预览，才保持循环
        if (CAT_CAL) {
          rafActive = true;
          requestAnimationFrame(onFrame);
        }
        return;
      }
      const frameNow = performance.now();
      const dt = lastFrame > 0 ? Math.min((frameNow - lastFrame) / 1000, 0.05) : 0.016;
      lastFrame = frameNow;
      if (handT > 0) {
        handT = Math.max(0, handT - dt * 1.2);
      }
      const transition = session.advance(Date.now());
      if (transition) {
        if (transition === 'intro-ended') hideGameIntroSub();
        if (transition === 'expired') playMeow(true);
        pickCat();
        tLastSawCatOnScreen = 0;
        playKittenMew();
        updateHUD();
      }
      if (panoReady && scene && camera && renderer) {
        updateCamera();
        renderer.render(scene, camera);
      }
      const isFluff = session.phase === 'fluff';
      drawScene2D(isFluff);
      updateHUD();
      rafActive = true;
      requestAnimationFrame(onFrame);
    }

    function ensureFrameLoop(): void {
      if (rafActive) return;
      rafActive = true;
      requestAnimationFrame(onFrame);
    }

    function tryHit(touchX: number, touchY: number): void {
      if (session.phase !== 'hunt' || !camera || !raycaster) return;
      handAimX = touchX;
      handAimY = touchY;
      handT = 1;
      const ndcX = (touchX / w) * 2 - 1;
      const ndcY = -(touchY / h) * 2 + 1;
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
      const dirDot = raycaster.ray.direction.dot(catDir);
      const pCat = projectCatToScreen();
      const rHit = Math.max(96, CAT_HIT_R_FRAC * Math.min(w, h));
      const near2d = pCat !== null && Math.hypot(pCat.x - touchX, pCat.y - touchY) < rHit;
      if (dirDot < CAT_HIT_COS && !near2d) {
        playMeow(true);
        pickCat();
        session.respawn(Date.now());
        tLastSawCatOnScreen = 0;
        window.setTimeout(() => {
          playKittenMew();
        }, 100);
        return;
      }
      const outcome = session.catch(Date.now(), !E2E_MODE);
      if (outcome === 'ignored') return;
      if (outcome === 'escaped') {
        pickCat();
        tLastSawCatOnScreen = 0;
        elTimerWrap.style.display = 'block';
        showCatEscapeSub();
        playMeow(true);
        updateHUD();
        return;
      }
      updateCatchTimeHud();
      playCatchWithHappyKittenMew();
      if (outcome === 'caught') {
        catCaughtUntil = Date.now() + CAUGHT_IMAGE_MS;
        elTimerWrap.style.display = 'none';
      } else {
        const result = session.result!;
        resultView.setResult(result, saveBest(localStorage, result.totalSeconds));
        clearTimeout(resultTimer);
        resultTimer = window.setTimeout(() => {
          if (session.result !== result) return;
          const audio = ensureAudio();
          if (audio?.state === 'suspended') void audio.resume().catch(() => undefined);
          stopBgm();
          playWinCelebration();
          elStart.style.display = 'none';
          resultView.celebrate();
        }, 500);
      }
    }

    interface PtrState {
      x: number;
      y: number;
      x0: number;
      y0: number;
      id: number;
      time: number;
      drag: boolean;
    }
    const ptrDown: PtrState = { x: 0, y: 0, x0: 0, y0: 0, id: -1, time: 0, drag: false };

    function onPointerDown(e: PointerEvent): void {
      try {
        e.preventDefault();
        ptrDown.x = e.clientX;
        ptrDown.y = e.clientY;
        ptrDown.x0 = e.clientX;
        ptrDown.y0 = e.clientY;
        ptrDown.id = e.pointerId;
        ptrDown.time = Date.now();
        ptrDown.drag = false;
        if (e.target instanceof Element) {
          e.target.setPointerCapture(e.pointerId);
        }
      } catch {
        showError();
      }
    }

    function onPointerMove(e: PointerEvent): void {
      if (e.pointerId !== ptrDown.id) return;
      if (Math.hypot(e.clientX - ptrDown.x, e.clientY - ptrDown.y) > dragThreshold) {
        ptrDown.drag = true;
      }
      if (!ptrDown.drag) return;
      if (
        session.phase === 'hunt' ||
        session.phase === 'fluff' ||
        session.phase === 'intro' ||
        (CAT_CAL && !session.active)
      ) {
        e.preventDefault();
        const dx = e.clientX - ptrDown.x;
        const dy = e.clientY - ptrDown.y;
        ptrDown.x = e.clientX;
        ptrDown.y = e.clientY;
        yawTouch = mod(yawTouch - dx * 0.0038);
        const cl2 = getPitchAllClamp();
        const nextP = pitchTouch + dy * 0.003;
        const s2 = THREE.MathUtils.clamp(nextP + pitchGyro, cl2.min, cl2.max);
        pitchTouch = s2 - pitchGyro;
      }
    }

    function onPointerUp(e: PointerEvent): void {
      try {
        e.preventDefault();
      } catch {
        /* ignore */
      }
      if (e.pointerId !== ptrDown.id) return;
      try {
        if (e.target instanceof Element) {
          e.target.releasePointerCapture(e.pointerId);
        }
      } catch {
        /* ignore */
      }
      try {
        const rect = canvas.getBoundingClientRect();
        const lx = e.clientX - rect.left;
        const ly = e.clientY - rect.top;
        const moveAll = Math.hypot(e.clientX - ptrDown.x0, e.clientY - ptrDown.y0);
        const isShortTap = moveAll < TAP_MOVE_MAX;
        if (
          CAT_CAL &&
          isShortTap &&
          panoReady &&
          camera &&
          w > 0 &&
          (session.phase === 'intro' || !session.active)
        ) {
          logCatCalibration(lx, ly);
          ptrDown.id = -1;
          return;
        }
        if (
          isShortTap &&
          session.active &&
          session.phase === 'hunt' &&
          Date.now() - ptrDown.time < 800
        ) {
          tryHit(lx, ly);
        }
      } catch {
        showError();
      }
      ptrDown.id = -1;
    }

    function onPointerCancel(): void {
      ptrDown.id = -1;
    }

    function onOrientation(e: DeviceOrientationEvent): void {
      if (!gyroOn) return;
      if (ptrDown.id !== -1) {
        setDeviceQuaternionFromOrientationEvent(qGyro, e);
        qGyroPrev.copy(qGyro);
        gyroQPrevValid = true;
        gyroDeltaSmooth *= 0.35;
        gyroDeltaSmoothPitch *= 0.35;
        return;
      }
      setDeviceQuaternionFromOrientationEvent(qGyro, e);
      if (!gyroQPrevValid) {
        qGyroPrev.copy(qGyro);
        gyroQPrevValid = true;
        gyroDeltaSmooth = 0;
        gyroDeltaSmoothPitch = 0;
        return;
      }
      qGyroRel.copy(qGyroPrev).invert().multiply(qGyro);
      eulerGyroDelta.setFromQuaternion(qGyroRel, 'YXZ');
      let dYaw = eulerGyroDelta.y;
      if (dYaw > Math.PI) dYaw -= TWO_PI;
      if (dYaw < -Math.PI) dYaw += TWO_PI;
      let dPitch = eulerGyroDelta.x;
      if (dPitch > Math.PI) dPitch -= TWO_PI;
      if (dPitch < -Math.PI) dPitch += TWO_PI;
      qGyroPrev.copy(qGyro);
      const dRaw = Math.max(
        -GYRO_MAX_STEP_DEG,
        Math.min(GYRO_MAX_STEP_DEG, dYaw * (180 / Math.PI)),
      );
      gyroDeltaSmooth = gyroDeltaSmooth * (1 - GYRO_SMOOTH) + dRaw * GYRO_SMOOTH;
      if (Math.abs(gyroDeltaSmooth) >= GYRO_APPLY_MIN) {
        yawGyro = mod(yawGyro - gyroDeltaSmooth * (Math.PI / 180) * GYRO_GAIN);
      }
      const dRawP = Math.max(
        -GYRO_MAX_STEP_DEG,
        Math.min(GYRO_MAX_STEP_DEG, dPitch * (180 / Math.PI)),
      );
      gyroDeltaSmoothPitch = gyroDeltaSmoothPitch * (1 - GYRO_SMOOTH) + dRawP * GYRO_SMOOTH;
      if (Math.abs(gyroDeltaSmoothPitch) >= GYRO_APPLY_MIN) {
        const dPrad = gyroDeltaSmoothPitch * (Math.PI / 180) * GYRO_GAIN;
        const sumP = THREE.MathUtils.clamp(
          pitchTouch + (pitchGyro + dPrad),
          getPitchAllClamp().min,
          getPitchAllClamp().max,
        );
        pitchGyro = sumP - pitchTouch;
      }
    }

    function attachGyroSensors(): void {
      if (gyroListenerAttached) {
        gyroOn = true;
        return;
      }
      gyroListenerAttached = true;
      gyroOn = true;
      onOrientationChangeHandler = () => {
        gyroQPrevValid = false;
      };
      try {
        window.addEventListener('orientationchange', onOrientationChangeHandler, { passive: true });
      } catch {
        window.addEventListener('orientationchange', onOrientationChangeHandler, false);
      }
      window.addEventListener('deviceorientation', onOrientation, { passive: true });
    }

    function tryRequestGyroInUserGesture(): void {
      if (!settingsStore.value.gyro) {
        gyroOn = false;
        return;
      }
      if (gyroListenerAttached) {
        attachGyroSensors();
        return;
      }
      const DOE = window.DeviceOrientationEvent as unknown as
        | {
            requestPermission?: () => Promise<string>;
          }
        | undefined;
      const DME = window.DeviceMotionEvent as unknown as
        | {
            requestPermission?: () => Promise<string>;
          }
        | undefined;
      if (!DOE && !DME) {
        return;
      }
      if (DOE && typeof DOE.requestPermission === 'function') {
        try {
          DOE.requestPermission()
            .then((st: string) => {
              if (st === 'granted') {
                attachGyroSensors();
              }
            })
            .catch(() => {
              /* ignore */
            });
        } catch {
          attachGyroSensors();
        }
        return;
      }
      if (DME && typeof DME.requestPermission === 'function') {
        DME.requestPermission()
          .then((st: string) => {
            if (st === 'granted') {
              attachGyroSensors();
            }
          })
          .catch(() => {
            /* ignore */
          });
        return;
      }
      attachGyroSensors();
    }

    function showGameIntroSub(): void {
      elGameIntroSub.textContent = introSubDisplay;
      elGameIntroSubWrap.setAttribute('aria-hidden', 'false');
      elGameIntroSubWrap.style.display = 'flex';
      window.requestAnimationFrame(() => {
        elGameIntroSubWrap.classList.add('show');
      });
    }

    function hideGameIntroSub(): void {
      elGameIntroSubWrap.classList.remove('show');
      window.setTimeout(() => {
        elGameIntroSubWrap.style.display = 'none';
        elGameIntroSubWrap.setAttribute('aria-hidden', 'true');
      }, 320);
    }

    function showCatEscapeSub(): void {
      if (catEscapeSubHideTimer) {
        clearTimeout(catEscapeSubHideTimer);
        catEscapeSubHideTimer = 0;
      }
      if (catEscapeSubCleanupTimer) {
        clearTimeout(catEscapeSubCleanupTimer);
        catEscapeSubCleanupTimer = 0;
      }
      elCatEscapeSub.textContent = '逃走了..';
      elCatEscapeSub.setAttribute('aria-hidden', 'false');
      elCatEscapeSub.style.display = 'block';
      elCatEscapeSub.classList.remove('show');
      window.requestAnimationFrame(() => {
        elCatEscapeSub.classList.add('show');
      });
      catEscapeSubHideTimer = window.setTimeout(() => {
        catEscapeSubHideTimer = 0;
        elCatEscapeSub.classList.remove('show');
        catEscapeSubCleanupTimer = window.setTimeout(() => {
          catEscapeSubCleanupTimer = 0;
          elCatEscapeSub.style.display = 'none';
          elCatEscapeSub.setAttribute('aria-hidden', 'true');
        }, 320);
      }, CAT_ESCAPE_SUB_MS);
    }

    function startGame(): void {
      elStart.style.display = 'none';
      elWin.style.display = 'none';
      elCardPanel.style.display = 'none';
      const ac0 = ensureAudio();
      if (ac0) {
        ac0
          .resume()
          .then(() => {
            startBgm();
          })
          .catch(() => {
            startBgm();
          });
      } else {
        startBgm();
      }
      yawTouch = 0;
      yawGyro = 0;
      pitchTouch = 0;
      pitchGyro = 0;
      gyroQPrevValid = false;
      gyroDeltaSmooth = 0;
      gyroDeltaSmoothPitch = 0;
      clearTimeout(resultTimer);
      resultView.reset();
      session.start(Date.now(), CAT_CAL || E2E_MODE);
      updateCatchTimeHud();
      catCaughtUntil = 0;
      tLastSawCatOnScreen = 0;
      if (session.phase === 'hunt') {
        pickCat();
        elTimerWrap.style.display = 'block';
        elGameIntroSubWrap.style.display = 'none';
        elGameIntroSubWrap.classList.remove('show');
        elGameIntroSubWrap.setAttribute('aria-hidden', 'true');
      } else {
        elTimerWrap.style.display = 'block';
        elTimerFill.style.transform = 'scaleX(1)';
        showGameIntroSub();
      }
      updateHUD();
      ensureFrameLoop();
    }

    let lastStartUiAt = 0;
    let lastGyroBtnAt = 0;
    function onStartOrAgainTapped(): void {
      const t = Date.now();
      if (t - lastStartUiAt < 500) {
        return;
      }
      lastStartUiAt = t;
      try {
        tryRequestGyroInUserGesture();
      } catch {
        /* ignore */
      }
      try {
        playKittenMew();
      } catch {
        /* ignore */
      }
      window.setTimeout(() => {
        startGame();
      }, 0);
    }
    function onGyroButtonTapped(): void {
      const t = Date.now();
      if (t - lastGyroBtnAt < 500) {
        return;
      }
      lastGyroBtnAt = t;
      try {
        tryRequestGyroInUserGesture();
      } catch {
        /* ignore */
      }
    }

    function initSettings(): void {
      const button = getEl<HTMLButtonElement>('btnSettings');
      const panel = getEl('settingsPanel');
      const sound = getEl<HTMLInputElement>('settingSound');
      const gyro = getEl<HTMLInputElement>('settingGyro');
      const motion = getEl<HTMLInputElement>('settingMotion');

      applySettings(settingsStore.value);
      sound.checked = settingsStore.value.sound;
      gyro.checked = settingsStore.value.gyro;
      motion.checked = settingsStore.value.reducedMotion;

      button.addEventListener('click', () => {
        const open = panel.hidden;
        panel.hidden = !open;
        button.setAttribute('aria-expanded', String(open));
      });
      sound.addEventListener('change', () => {
        settingsStore.update({ sound: sound.checked });
        if (!sound.checked) {
          stopBgm();
        } else if (session.active) {
          startBgm();
        }
      });
      gyro.addEventListener('change', () => {
        settingsStore.update({ gyro: gyro.checked });
        gyroOn = gyro.checked && gyroListenerAttached;
        if (gyro.checked) {
          tryRequestGyroInUserGesture();
        }
      });
      motion.addEventListener('change', () => {
        settingsStore.update({ reducedMotion: motion.checked });
        if (motion.checked) {
          resultView.stopEffects();
        }
      });
    }

    function initEvents(): void {
      window.addEventListener('resize', () => {
        resize();
      });
      btnStart.addEventListener('click', onStartOrAgainTapped);
      btnAgain.addEventListener('click', onStartOrAgainTapped);
      btnCard.addEventListener('click', () => {
        resultView.openCard();
      });
      btnBackWin.addEventListener('click', () => {
        resultView.celebrate();
      });
      btnSaveCard.addEventListener('click', async () => {
        try {
          const url = cardCanvas.toDataURL('image/png');
          // iOS Safari 对 <a download> 支持不稳定：优先 Web Share API 分享图片文件
          if (typeof navigator.share === 'function') {
            const blob = await (await fetch(url)).blob();
            const file = new File([blob], '寻喵大作战-战绩.png', { type: 'image/png' });
            if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
              await navigator.share({ files: [file], title: '寻喵大作战战绩' });
              return;
            }
          }
          const a = document.createElement('a');
          a.setAttribute('href', url);
          a.setAttribute('download', '寻喵大作战-战绩.png');
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        } catch (err) {
          // 用户取消系统分享面板不算失败
          if (err instanceof DOMException && err.name === 'AbortError') return;
          showError();
        }
      });
      btnGyro.addEventListener('click', onGyroButtonTapped);
      canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
      canvas.addEventListener('pointermove', onPointerMove, { passive: false });
      canvas.addEventListener('pointerup', onPointerUp, { passive: false });
      canvas.addEventListener('pointercancel', onPointerCancel, { passive: true });
      document.addEventListener('visibilitychange', () => {
        lastFrame = performance.now();
        if (document.hidden) {
          pauseBgm();
        } else if (session.active && settingsStore.value.sound) {
          startBgm(true);
        }
      });
    }

    function init(): void {
      resize();
      try {
        initSfxPreload();
      } catch {
        /* ignore */
      }
      try {
        ensureAudio();
      } catch {
        /* ignore */
      }
      try {
        initSfxDecode();
      } catch {
        /* ignore */
      }
      try {
        initBgmPreload();
      } catch {
        /* ignore */
      }
      try {
        initPano3D();
      } catch {
        showError();
        return;
      }
      window.addEventListener('load', () => {
        try {
          resize();
        } catch {
          /* ignore */
        }
      });
      initSettings();
      initEvents();
      ensureFrameLoop();
      if (window.DeviceOrientationEvent) {
        btnGyro.classList.add('show');
      }
      try {
        if (window.isSecureContext === false) {
          const pnote = document.getElementById('permNote');
          if (pnote) {
            pnote.classList.add('show');
          }
        }
      } catch {
        /* ignore */
      }
    }

    const _load = elTitle.getAttribute('data-hud-loading');
    elTitle.textContent = (_load && String(_load).trim()) || '正在加载全景图…';
    init();
  }

  try {
    boot();
  } catch {
    showError();
  }
})();
