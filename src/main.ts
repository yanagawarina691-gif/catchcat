import * as THREE from 'three';
import { GAME_CONFIG, CAT_HIDE_SPOTS } from './game/config';
import { pickHideSpot, shouldThirdCatEscape, elapsedSeconds } from './game/rules';
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
import { drawShareCardTime } from './ui/share-card';

(function () {
  'use strict';

  const FOV_DEG = 60;
  const TWO_PI = Math.PI * 2;
  const HUNT_LIMIT_MS = GAME_CONFIG.huntLimitMs;
  const INTRO_MS = GAME_CONFIG.introMs;
  const FLUFF_MS = GAME_CONFIG.fluffMs;
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
  const WIN_FX_MS = 3200;
  const CAUGHT_IMAGE_MS = 500;
  const CAT_ESCAPE_SUB_MS = 1000;
  const dragThreshold = 14;

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

  /** 结算页虚拟排行榜（总用时秒数，与玩家合并后按时间升序，纯演示） */
  const WIN_LEADERBOARD_VIRTUAL = [
    { name: '摸鱼第一名', timeSec: 8.4 },
    { name: '橘座本座', timeSec: 11.2 },
    { name: '猫爪印', timeSec: 14.6 },
    { name: '云吸猫大师', timeSec: 19.1 },
    { name: '路人小周', timeSec: 24.8 },
  ];

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
    const cctx = cardCanvas.getContext('2d')!;

    const introSubDisplay = ((): string => {
      const t = elGameIntroSubWrap.getAttribute('data-intro-text');
      if (t && String(t).trim()) {
        return String(t).trim();
      }
      return INTRO_SUB_DEFAULT;
    })();

    let winConfettiRaf = 0;
    let catEscapeSubHideTimer = 0;
    let catEscapeSubCleanupTimer = 0;

    interface LeaderboardRow {
      name: string;
      timeSec: number;
      you: boolean;
    }

    function formatLeaderboardTime(sec: number): string {
      const t = Number(sec);
      const v = !isFinite(t) || t < 0 ? 0 : t;
      return String(Math.round(v * 10) / 10) + ' 秒';
    }

    function addLbSpan(parent: HTMLElement, cls: string, text: string): void {
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      parent.appendChild(s);
    }

    function renderWinLeaderboard(secStr: string): void {
      const sn = parseFloat(String(secStr));
      const psec = !isFinite(sn) || sn < 0 ? 20 : sn;
      const rows: LeaderboardRow[] = WIN_LEADERBOARD_VIRTUAL.map((v) => ({ ...v, you: false }));
      rows.push({ name: '你（本次）', timeSec: psec, you: true });
      rows.sort((a, b) => a.timeSec - b.timeSec);
      const top = rows.slice(0, 6);
      elWinLeaderboardList.textContent = '';
      for (let k = 0; k < top.length; k += 1) {
        const r = top[k]!;
        const li = document.createElement('li');
        li.className = 'win-leaderboard-row' + (r.you ? ' is-you' : '');
        addLbSpan(li, 'win-lb-rank', String(k + 1));
        addLbSpan(li, 'win-lb-name', r.name);
        addLbSpan(li, 'win-lb-time', formatLeaderboardTime(r.timeSec));
        elWinLeaderboardList.appendChild(li);
      }
    }

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

    /** 战绩分享卡底图（设计稿整图，见 images/ 喵分享卡片.png） */
    const SHARE_CARD_TEMPLATE = './images/喵分享卡片.png';
    const shareCardBgImg = new Image();
    shareCardBgImg.src = SHARE_CARD_TEMPLATE;

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

    function tryRedrawShareCardIfOpen(): void {
      try {
        if (getComputedStyle(elCardPanel).display === 'none') {
          return;
        }
        const wtx = document.getElementById('winTimeText');
        const tRaw = wtx ? wtx.textContent : '';
        const m2 = tRaw ? tRaw.match(/([\d.]+)\s*秒/) : null;
        if (m2) {
          drawShareCardTime(cctx, shareCardBgImg, m2[1]!);
        }
      } catch {
        /* ignore */
      }
    }
    shareCardBgImg.addEventListener('load', tryRedrawShareCardIfOpen, { passive: true });

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

    let gameStarted = false;
    type GamePhase = 'menu' | 'intro' | 'hunt' | 'fluff' | 'won';
    let phase: GamePhase = 'menu';
    let catches = 0;
    let tGameStart = 0;
    let tCatSpawn = 0;
    /** 本轮内最近一次猫在屏幕可见区内的时间；0 表示本局尚未看到猫 */
    let tLastSawCatOnScreen = 0;
    /** 第三只已「溜走」次数，最多 3 次，之后下一只必中通关 */
    let thirdCatEscapes = 0;
    let thirdCatEscapeCooldownTimer = 0;
    let catchCountedThisSpawn = false;
    const catchRoundTimesSec: number[] = [];
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
    let fluffT0 = 0;
    let lastFrame = 0;
    let tIntroEnd = 0;

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
      catchCountedThisSpawn = false;
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
      if (!gameStarted && panoReady && scene && camera && renderer) {
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

    function stopWinScreenAnimation(): void {
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

    function startWinScreenAnimation(): void {
      stopWinScreenAnimation();
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

    function triggerWinBurstClass(): void {
      try {
        elWin.classList.remove('win-burst');
        void elWin.offsetWidth;
        elWin.classList.add('win-burst');
        window.setTimeout(() => {
          try {
            elWin.classList.remove('win-burst');
          } catch {
            /* ignore */
          }
        }, 750);
      } catch {
        /* ignore */
      }
    }

    function drawScene2D(isFluff: boolean): void {
      ctx.clearRect(0, 0, w, h);
      const p = projectCatToScreen();
      if (p && phase === 'hunt') {
        tLastSawCatOnScreen = Date.now();
      }
      if (p && (phase === 'hunt' || phase === 'fluff')) {
        const cy = p.y + Math.sin(lastFrame * 0.006) * 2;
        const showCaught = phase === 'fluff' && Date.now() < catCaughtUntil;
        drawCatAtScreen(p.x, cy, 1, isFluff, showCaught);
      }
      drawHand();
      drawVignette();
      if (phase === 'hunt' && tCatSpawn > 0 && !p) {
        const refT2 = tLastSawCatOnScreen > 0 ? tLastSawCatOnScreen : tCatSpawn;
        if (Date.now() - refT2 >= CAT_HINT_NO_SIGHT_MS) {
          const hpt2 = getCatScreenHint();
          if (hpt2) {
            drawHintArrow(hpt2.x, hpt2.y, hpt2.ang);
          }
        }
      }
    }

    function updateCatchTimeHud(): void {
      if (!catchRoundTimesSec.length) {
        elCatchTimeHud.textContent = '';
        elCatchTimeHud.style.display = 'none';
        return;
      }
      elCatchTimeHud.style.display = 'block';
      elCatchTimeHud.textContent = catchRoundTimesSec
        .map((sec, i) => '第' + String(i + 1) + '次 ' + String(sec) + 's')
        .join(' · ');
    }

    /**
     * HUD 更新：计时条每帧更新（需要动画），但标题/统计文本只在状态变化时写入，
     * 避免 aria-live 区域被读屏反复播报。
     */
    let lastHudKey = '';
    function updateHUD(): void {
      if (!gameStarted) return;
      if (phase === 'intro') {
        const key = 'intro:' + String(catches) + ':' + String(gyroOn);
        if (key !== lastHudKey) {
          lastHudKey = key;
          elTitle.textContent = '找猫中 ' + String(catches) + '/3 · 即将开始';
          elStats.textContent = '全景 360° ·' + (gyroOn ? ' 陀螺仪已开' : ' 可点补开');
          elCatchTimeHud.textContent = '';
          elCatchTimeHud.style.display = 'none';
          elTimerWrap.style.display = 'block';
        }
        if (tIntroEnd > 0) {
          const leftIntro = Math.max(0, tIntroEnd - Date.now());
          const rIntro = Math.max(0, leftIntro / INTRO_MS);
          elTimerFill.style.transform = 'scaleX(' + String(rIntro) + ')';
        } else {
          elTimerFill.style.transform = 'scaleX(1)';
        }
        return;
      }
      const key =
        'hunt:' +
        String(catches) +
        ':' +
        String(gyroOn) +
        ':' +
        String(thirdCatEscapes) +
        ':' +
        phase;
      if (key !== lastHudKey) {
        lastHudKey = key;
        elTitle.textContent = '找猫中 ' + String(catches) + '/3';
        elStats.textContent =
          '全景 360° ·' +
          (gyroOn ? ' 陀螺仪已开' : ' 可点补开') +
          (catches === GAME_CONFIG.catchesToWin - 1 && thirdCatEscapes > 0
            ? ' · 第3只已溜走 ' +
              String(thirdCatEscapes) +
              '/' +
              String(GAME_CONFIG.maxThirdCatEscapes) +
              ' 次'
            : '');
        if (phase === 'hunt') {
          elTimerWrap.style.display = 'block';
        } else if (phase === 'fluff') {
          elTimerWrap.style.display = 'none';
          elTimerFill.style.transform = 'scaleX(0)';
        }
      }
      if (phase === 'hunt') {
        const left = HUNT_LIMIT_MS - (Date.now() - tCatSpawn);
        const r = Math.max(0, left / HUNT_LIMIT_MS);
        elTimerFill.style.transform = 'scaleX(' + String(r) + ')';
      }
    }

    let rafActive = false;
    function onFrame(): void {
      rafActive = false;
      if (!gameStarted) {
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
      if (phase === 'intro' && tIntroEnd > 0 && Date.now() >= tIntroEnd) {
        tIntroEnd = 0;
        endIntroToHunt();
      }
      if (phase === 'hunt' && tCatSpawn > 0) {
        if (Date.now() - tCatSpawn > HUNT_LIMIT_MS) {
          playMeow(true);
          pickCat();
          tCatSpawn = Date.now();
          tLastSawCatOnScreen = 0;
          window.setTimeout(() => {
            playKittenMew();
          }, 100);
          updateHUD();
        }
      }
      if (panoReady && scene && camera && renderer) {
        updateCamera();
        renderer.render(scene, camera);
      }
      let isFluff = phase === 'fluff';
      if (isFluff && Date.now() - fluffT0 > FLUFF_MS) {
        phase = 'hunt';
        pickCat();
        tCatSpawn = Date.now();
        tLastSawCatOnScreen = 0;
        isFluff = false;
        playKittenMew();
      }
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
      if (phase !== 'hunt' || !camera || !raycaster) return;
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
        tCatSpawn = Date.now();
        tLastSawCatOnScreen = 0;
        window.setTimeout(() => {
          playKittenMew();
        }, 100);
        return;
      }
      if (catchCountedThisSpawn) {
        return;
      }
      catchCountedThisSpawn = true;
      if (!E2E_MODE && shouldThirdCatEscape(catches, thirdCatEscapes)) {
        thirdCatEscapes += 1;
        pickCat();
        /** pickCat 会把 catchCountedThisSpawn 置 false；防同次操作二次 tryHit 误判通关，溜走后的短窗口内禁止再判抓 */
        catchCountedThisSpawn = true;
        if (thirdCatEscapeCooldownTimer) {
          clearTimeout(thirdCatEscapeCooldownTimer);
          thirdCatEscapeCooldownTimer = 0;
        }
        thirdCatEscapeCooldownTimer = window.setTimeout(() => {
          thirdCatEscapeCooldownTimer = 0;
          catchCountedThisSpawn = false;
        }, 420);
        tCatSpawn = Date.now();
        tLastSawCatOnScreen = 0;
        elTimerWrap.style.display = 'block';
        showCatEscapeSub();
        playMeow(true);
        window.setTimeout(() => {
          playKittenMew();
        }, 80);
        updateHUD();
        return;
      }
      catchRoundTimesSec.push(elapsedSeconds(tCatSpawn, Date.now()));
      updateCatchTimeHud();
      catches += 1;
      if (catches < GAME_CONFIG.catchesToWin) {
        playCatchWithHappyKittenMew();
        catCaughtUntil = Date.now() + CAUGHT_IMAGE_MS;
        phase = 'fluff';
        fluffT0 = Date.now();
        tCatSpawn = 0;
        elTimerWrap.style.display = 'none';
      } else {
        phase = 'won';
        gameStarted = false;
        tCatSpawn = 0;
        playCatchWithHappyKittenMew();
        const sec = ((Date.now() - tGameStart) / 1000).toFixed(1);
        const bestSec = saveBest(localStorage, Number(sec));
        window.setTimeout(() => {
          const _acW2 = ensureAudio();
          if (_acW2) {
            try {
              if (_acW2.state === 'suspended') {
                void _acW2.resume();
              }
            } catch {
              /* ignore */
            }
          }
          stopBgm();
          playWinCelebration();
          elStart.style.display = 'none';
          elWin.style.display = 'flex';
          try {
            const wh2 = elWin.querySelector<HTMLElement>('.win-hero');
            if (wh2) {
              wh2.classList.remove('win-hero');
              void wh2.offsetWidth;
              wh2.classList.add('win-hero');
            }
          } catch {
            /* ignore */
          }
          triggerWinBurstClass();
          startWinScreenAnimation();
          const wtx = document.getElementById('winTimeText');
          if (wtx) {
            const tplW = wtx.getAttribute('data-time-template');
            const ssec = String(sec);
            if (tplW && String(tplW).indexOf('{sec}') >= 0) {
              wtx.textContent = String(tplW).replace(/\{sec\}/g, ssec);
            } else {
              wtx.textContent = '总用时 ' + ssec + ' 秒。猫猫终于投入你的怀抱啦。';
            }
            wtx.textContent += ' 本机最佳 ' + bestSec.toFixed(1) + ' 秒。';
          }
          renderWinLeaderboard(String(sec));
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
      if (phase === 'hunt' || phase === 'fluff' || phase === 'intro' || (CAT_CAL && !gameStarted)) {
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
          (phase === 'intro' || !gameStarted)
        ) {
          logCatCalibration(lx, ly);
          ptrDown.id = -1;
          return;
        }
        if (isShortTap && gameStarted && phase === 'hunt' && Date.now() - ptrDown.time < 800) {
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

    function endIntroToHunt(): void {
      if (phase !== 'intro') {
        return;
      }
      phase = 'hunt';
      hideGameIntroSub();
      pickCat();
      tCatSpawn = Date.now();
      tLastSawCatOnScreen = 0;
      tGameStart = Date.now();
      elTimerWrap.style.display = 'block';
      updateHUD();
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
      gameStarted = true;
      catches = 0;
      thirdCatEscapes = 0;
      if (thirdCatEscapeCooldownTimer) {
        clearTimeout(thirdCatEscapeCooldownTimer);
        thirdCatEscapeCooldownTimer = 0;
      }
      catchRoundTimesSec.length = 0;
      updateCatchTimeHud();
      catCaughtUntil = 0;
      if (CAT_CAL || E2E_MODE) {
        phase = 'hunt';
        tGameStart = Date.now();
        pickCat();
        tCatSpawn = Date.now();
        tLastSawCatOnScreen = 0;
        elTimerWrap.style.display = 'block';
        elGameIntroSubWrap.style.display = 'none';
        elGameIntroSubWrap.classList.remove('show');
        elGameIntroSubWrap.setAttribute('aria-hidden', 'true');
      } else {
        phase = 'intro';
        tCatSpawn = 0;
        tIntroEnd = Date.now() + INTRO_MS;
        elTimerWrap.style.display = 'block';
        elTimerFill.style.transform = 'scaleX(1)';
        showGameIntroSub();
      }
      updateHUD();
      ensureFrameLoop();
    }

    function openCard(): void {
      stopWinScreenAnimation();
      const wtx = document.getElementById('winTimeText');
      const tRaw = wtx ? wtx.textContent : '';
      const m = tRaw ? tRaw.match(/([\d.]+)\s*秒/) : null;
      const sec = m ? m[1]! : '?';
      elWin.style.display = 'none';
      elCardPanel.style.display = 'flex';
      const draw = (): void => {
        drawShareCardTime(cctx, shareCardBgImg, sec);
      };
      const dec: Promise<unknown>[] = [];
      if (shareCardBgImg && typeof shareCardBgImg.decode === 'function') {
        dec.push(shareCardBgImg.decode().catch(() => undefined));
      }
      if (dec.length) {
        Promise.all(dec).then(draw).catch(draw);
      } else {
        window.requestAnimationFrame(draw);
      }
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
        } else if (gameStarted) {
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
          stopWinScreenAnimation();
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
        openCard();
      });
      btnBackWin.addEventListener('click', () => {
        elCardPanel.style.display = 'none';
        elWin.style.display = 'flex';
        triggerWinBurstClass();
        startWinScreenAnimation();
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
        } else if (gameStarted && settingsStore.value.sound) {
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
