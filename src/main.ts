// The runtime is being progressively typed; new modules remain under strict TypeScript.
// @ts-nocheck
import * as THREE from 'three';
import { settingsStore, applySettings } from './ui/settings';
import { saveBest } from './game/storage';
import { capPixelRatio } from './render/lifecycle';

(function () {
  'use strict';
  const FOV_DEG = 60;
  const TWO_PI = Math.PI * 2;
  /**
   * 陀螺仪：用 (alpha/beta/gamma) 构建设备四元数 + 与 Three 设备控制相同的屏幕补偿，
   * 再对相邻两帧做 q_prev^{-1} * q 取 YXZ 的 Y 为水平角增量。仅盯 alpha 在竖屏会与俯仰/横滚强耦合、极难用。
   */
  const GYRO_SMOOTH = 0.3;
  const GYRO_GAIN = 0.95;
  const GYRO_MAX_STEP_DEG = 7;
  const GYRO_APPLY_MIN = 0.03;
  const HUNT_LIMIT_MS = 7000;
  /** 本轮内若持续未在视野里看到猫（猫在屏外）达此时长，显示边缘方向箭头 */
  const CAT_HINT_NO_SIGHT_MS = 3000;
  const INTRO_MS = 2000;
  const INTRO_SUB_DEFAULT = '帮我找到猫猫，抓到可能也会跑哦';
  const FLUFF_MS = 1200;
  const TAP_MOVE_MAX = 40;
  const CAT_HIT_COS = Math.cos(0.22);
  const CAT_HIT_R_FRAC = 0.12;
  const CAT_DRAW_H_FRAC = 0.22;
  const ERROR_TEXT = '哎呀，出错了，请重启试试吧~';
  const AUDIO_BASE = './audio/';
  const SFX_MP3 = {
    catLittle: 'cat-mew-little.mp3',
    catBrief: 'cat-mew-brief.mp3',
    catch: 'sfx-catch.mp3',
    win: 'sfx-win-chime.mp3',
  };
  const BGM_FILE = 'bgm-main.mp3';
  const BGM_VOL_FILE = 0.28;
  var sfxPreload = {};
  /** decodeAudioData 后的短音效，用 BufferSource 播，避免 HTML5 Audio 起播卡、跟手差 */
  var sfxBuffers = {};
  var bgmAudioEl = null;
  const PANO_IMAGE = './images/M3_Anime_equirectangular-jpg_A_cozy_pink_anime_1020730682_15264727.jpg';

  /**
   * 躲藏点必须与「当前等距全景图（PANO_IMAGE）贴到球上的方向」一致，不能乱用水平随机角。
   * - theta / phi 与本页 Three.Spherical(1, phi, theta) 相同（与相机里看的方向一一对应）。
   * - 用浏览器打开 `index.html?catcal=1`，开一局后转动视角对准沙发/床底等，在目标位置**轻点一下**（不要拖），
   *   打开开发者工具 **控制台**，会打印一条 JSON，把其中的 theta/phi 复制进下表；改 id、label 即可。
   * - jitter*：该点附近随机偏移（弧度），避免永远同一像素；可改小更「贴地」。
   * - 每局/每次换猫时从本列表**随机**取一点；点≥2 时会尽量避免与**上一轮**同一点。
   */
  const CAT_HIDE_SPOTS = [
    {
      id: '柜子',
      label: '柜子',
      theta: 1.17523,
      phi: 1.663421,
      jitterTheta: 0.06,
      jitterPhi: 0.04,
    },
    {
      id: '电视旁',
      label: '电视旁',
      theta: -0.70737,
      phi: 1.252197,
      jitterTheta: 0.06,
      jitterPhi: 0.04,
    },
    {
      id: '白柜子',
      label: '白柜子',
      theta: -2.327066,
      phi: 1.008173,
      jitterTheta: 0.06,
      jitterPhi: 0.04,
    },
    {
      id: '脚蹬上',
      label: '脚蹬上',
      theta: 0.705269,
      phi: 2.392361,
      jitterTheta: 0.06,
      jitterPhi: 0.04,
    },
    {
      id: '床底',
      label: '床底',
      theta: 2.078554,
      phi: 1.933719,
      jitterTheta: 0.06,
      jitterPhi: 0.04,
    },
    {
      id: '柜子二',
      label: '柜子二',
      theta: 1.010068,
      phi: 1.366893,
      jitterTheta: 0.06,
      jitterPhi: 0.04,
    },
    {
      id: '桌子',
      label: '桌子',
      theta: 2.736616,
      phi: 2.031936,
      jitterTheta: 0.06,
      jitterPhi: 0.04,
    },
    {
      id: '沙发',
      label: '沙发',
      theta: -2.881147,
      phi: 1.641361,
      jitterTheta: 0.06,
      jitterPhi: 0.04,
    },
    {
      id: '沙发二',
      label: '沙发二',
      theta: -1.734814,
      phi: 1.851704,
      jitterTheta: 0.06,
      jitterPhi: 0.04,
    },
    {
      id: '白架子',
      label: '白架子',
      theta: -2.183788,
      phi: 1.30696,
      jitterTheta: 0.06,
      jitterPhi: 0.04,
    },
  ];
  const SPAWN_PHI_LO = 0.22 * Math.PI;
  const SPAWN_PHI_HI = 0.78 * Math.PI;
  const PITCH_PHI_COVER_RAD = THREE.MathUtils.degToRad(4.5);
  const PANO_PITCH_PHI = (function () {
    var minS = Infinity;
    var maxS = -Infinity;
    var i;
    for (i = 0; i < CAT_HIDE_SPOTS.length; i++) {
      var s0 = CAT_HIDE_SPOTS[i];
      var j0 = typeof s0.jitterPhi === 'number' ? s0.jitterPhi : 0.04;
      minS = Math.min(minS, s0.phi - j0);
      maxS = Math.max(maxS, s0.phi + j0);
    }
    return {
      min: THREE.MathUtils.clamp(minS - PITCH_PHI_COVER_RAD, SPAWN_PHI_LO, SPAWN_PHI_HI),
      max: THREE.MathUtils.clamp(maxS + PITCH_PHI_COVER_RAD, SPAWN_PHI_LO, SPAWN_PHI_HI),
    };
  })();
  const PANO_PITCH_PHI_MIN = PANO_PITCH_PHI.min;
  const PANO_PITCH_PHI_MAX = PANO_PITCH_PHI.max;
  const CAT_CAL = (function () {
    try {
      return /[?&]catcal=1(?:&|$)/.test(String(window.location && window.location.search));
    } catch (e) {
      return false;
    }
  })();
  const sphCal = new THREE.Spherical();

  const canvas = document.getElementById('gameCanvas');
  const overlay = document.getElementById('overlayCanvas');
  const ctx = overlay.getContext('2d');
  const elTitle = document.getElementById('titleLine');
  /** index.html 里 #titleLine 的初始文案，全景就绪后作 HUD 闲时标题（改 HTML 即生效，勿改 main 常量） */
  const HUD_TITLE_PANO_IDLE = elTitle && elTitle.textContent ? elTitle.textContent.trim() : '';
  const elStats = document.getElementById('statsLine');
  const elCatchTimeHud = document.getElementById('catchTimeHud');
  const elTimerWrap = document.getElementById('timerWrap');
  const elTimerFill = document.getElementById('timerFill');
  const elStart = document.getElementById('startPanel');
  const elWin = document.getElementById('winPanel');
  const winFxCanvas = document.getElementById('winFxCanvas');
  var winConfettiRaf = 0;
  const WIN_FX_MS = 3200;
  const WIN_CONFETTI_COLORS = [
    '#ff8fb3', '#ffe066', '#fff0e8', '#a8e6cf', '#e85d8a', '#ffd0e8', '#ffaa90', '#c8b5ff',
  ];
  /** 结算页虚拟排行榜（总用时秒数，与玩家合并后按时间升序，纯演示） */
  const WIN_LEADERBOARD_VIRTUAL = [
    { name: '摸鱼第一名', timeSec: 8.4 },
    { name: '橘座本座', timeSec: 11.2 },
    { name: '猫爪印', timeSec: 14.6 },
    { name: '云吸猫大师', timeSec: 19.1 },
    { name: '路人小周', timeSec: 24.8 },
  ];
  function formatLeaderboardTime(sec) {
    var t = Number(sec);
    if (!isFinite(t) || t < 0) {
      t = 0;
    }
    return String(Math.round(t * 10) / 10) + ' 秒';
  }
  function addLbSpan(parent, cls, text) {
    var s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    parent.appendChild(s);
  }
  function renderWinLeaderboard(secStr) {
    if (!elWinLeaderboardList) {
      return;
    }
    var sn = parseFloat(String(secStr), 10);
    if (!isFinite(sn) || sn < 0) {
      sn = 20;
    }
    var rows = [];
    for (var v = 0; v < WIN_LEADERBOARD_VIRTUAL.length; v += 1) {
      rows.push({
        name: WIN_LEADERBOARD_VIRTUAL[v].name,
        timeSec: WIN_LEADERBOARD_VIRTUAL[v].timeSec,
        you: false,
      });
    }
    rows.push({ name: '你（本次）', timeSec: sn, you: true });
    rows.sort(function (a, b) {
      return a.timeSec - b.timeSec;
    });
    var top = rows.slice(0, 6);
    elWinLeaderboardList.textContent = '';
    for (var k = 0; k < top.length; k += 1) {
      var r = top[k];
      var li = document.createElement('li');
      li.className = 'win-leaderboard-row' + (r.you ? ' is-you' : '');
      addLbSpan(li, 'win-lb-rank', String(k + 1));
      addLbSpan(li, 'win-lb-name', r.name);
      addLbSpan(li, 'win-lb-time', formatLeaderboardTime(r.timeSec));
      elWinLeaderboardList.appendChild(li);
    }
  }
  const elGameIntroSubWrap = document.getElementById('gameIntroSubWrap');
  const elGameIntroSub = document.getElementById('gameIntroSub');
  const introSubDisplay = (function () {
    var t = elGameIntroSubWrap && elGameIntroSubWrap.getAttribute('data-intro-text');
    if (t && String(t).trim()) {
      return String(t).trim();
    }
    return INTRO_SUB_DEFAULT;
  })();
  const elWinLeaderboardList = document.getElementById('winLeaderboardList');
  const elCatEscapeSub = document.getElementById('catEscapeSub');
  var catEscapeSubHideTimer = 0;
  var catEscapeSubCleanupTimer = 0;
  const CAT_ESCAPE_SUB_MS = 1000;
  const elCardPanel = document.getElementById('cardPanel');
  const elError = document.getElementById('errorMsg');
  const btnStart = document.getElementById('btnStart');
  const btnGyro = document.getElementById('gyroBtn');
  const btnCard = document.getElementById('btnCard');
  const btnAgain = document.getElementById('btnAgain');
  const btnBackWin = document.getElementById('btnBackWin');
  const btnSaveCard = document.getElementById('btnSaveCard');
  const cardCanvas = document.getElementById('cardCanvas');
  const cctx = cardCanvas.getContext('2d');

  const handImg = new Image();
  let handImageReady = false;
  /**
   * 手部2.png：唯一定位点 = 图片左上角 (像素 0,0) → 对应 drawImage 的 (dx,dy)，钉死不改。
   * 每帧用该点从「休息坐标」向「点击坐标 (handAim)」做插值，整张贴图只跟这一个点动。
   */
  const REST_ANCHOR_X_FRAC = -0.08;
  const REST_ANCHOR_Y_FRAC = 0.82;
  var handAimX = 0.5;
  var handAimY = 0.45;

  handImg.onload = function () {
    handImageReady = true;
  };
  handImg.onerror = function () {
    handImageReady = false;
  };
  handImg.src = './images/手部2.png';

  /** 战绩分享卡底图（设计稿整图，见 images/ 喵分享卡片.png） */
  const SHARE_CARD_TEMPLATE = './images/喵分享卡片.png';
  const shareCardBgImg = new Image();
  shareCardBgImg.src = SHARE_CARD_TEMPLATE;

  const CAUGHT_IMAGE_MS = 500;
  const CAT_IMG_PATHS = [
    './images/猫腰.png',
    './images/猫趴1.png',
    './images/猫躺1.png',
  ];
  const CAT_IMG_CAUGHT = './images/猫被抓.png';
  const catImgEls = [];
  for (var cpi = 0; cpi < CAT_IMG_PATHS.length; cpi++) {
    const ci = new Image();
    catImgEls.push(ci);
    ci.src = CAT_IMG_PATHS[cpi];
  }
  const catImgCaught = new Image();
  catImgCaught.src = CAT_IMG_CAUGHT;
  function tryRedrawShareCardIfOpen() {
    try {
      if (!elCardPanel) {
        return;
      }
      if (getComputedStyle(elCardPanel).display === 'none') {
        return;
      }
      var wtx = document.getElementById('winTimeText');
      var tRaw = wtx ? wtx.textContent : '';
      var m2 = tRaw.match(/([\d.]+)\s*秒/);
      if (m2) {
        drawShareCardTime(m2[1]);
      }
    } catch (e) { /*  */ }
  }
  shareCardBgImg.addEventListener('load', tryRedrawShareCardIfOpen, { passive: true });
  var catPicIndex = 0;
  var catCaughtUntil = 0;

  let w = 0;
  let h = 0;
  let dpr = 1;

  let camera;
  let scene;
  let renderer;
  let raycaster;
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
  let gyroQPrevValid = false;
  let panoReady = false;

  let gameStarted = false;
  let phase = 'menu';
  let catches = 0;
  let tGameStart = 0;
  let tCatSpawn = 0;
  /** 本轮内最近一次猫在屏幕可见区内的时间；0 表示本局尚未看到猫 */
  let tLastSawCatOnScreen = 0;
  /** 第三只单次点中仍「逃走」概率（0～1） */
  const THIRD_CAT_ESCAPE_P = 0.55;
  /** 第三只已「溜走」次数，最多 3 次，之后下一只必中通关 */
  let thirdCatEscapes = 0;
  var thirdCatEscapeCooldownTimer = 0;
  let catchCountedThisSpawn = false;
  var catchRoundTimesSec = [];
  let catTheta = 0;
  let catPhi = Math.PI / 2;
  let catSpotId = 0;
  let lastCatSpotIndex = -1;
  let yawTouch = 0;
  let yawGyro = 0;
  let pitchGyro = 0;
  let pitchTouch = 0;
  let gyroOn = false;
  let gyroDeltaSmooth = 0;
  let gyroDeltaSmoothPitch = 0;
  let gyroListenerAttached = false;
  let onOrientationChangeHandler = null;
  let handT = 0;
  let fluffT0 = 0;
  let lastFrame = 0;
  var tIntroEnd = 0;

  function showError() {
    elError.classList.add('show');
    elError.textContent = ERROR_TEXT;
  }

  function mod(a) {
    return ((a % TWO_PI) + TWO_PI) % TWO_PI;
  }

  function getPitchAllClamp() {
    return {
      min: Math.PI / 2 - PANO_PITCH_PHI_MAX,
      max: Math.PI / 2 - PANO_PITCH_PHI_MIN,
    };
  }

  function getScreenOrientationAngleRad() {
    try {
      if (window.screen && window.screen.orientation && typeof window.screen.orientation.angle === 'number') {
        return THREE.MathUtils.degToRad(window.screen.orientation.angle);
      }
    } catch (e) { /*  */ }
    if (typeof window.orientation === 'number') {
      return THREE.MathUtils.degToRad(window.orientation);
    }
    return 0;
  }

  /** 与 Three DeviceOrientationControls 一致：YXZ 欧拉 + 机背朝前 + 屏幕旋转 */
  function setDeviceQuaternionFromOrientationEvent(out, ev) {
    const a = ev.alpha != null && !isNaN(ev.alpha) ? THREE.MathUtils.degToRad(ev.alpha) : 0;
    const b = ev.beta != null && !isNaN(ev.beta) ? THREE.MathUtils.degToRad(ev.beta) : 0;
    const g = ev.gamma != null && !isNaN(ev.gamma) ? THREE.MathUtils.degToRad(ev.gamma) : 0;
    eulerGyro.set(b, a, -g, 'YXZ');
    out.setFromEuler(eulerGyro);
    out.multiply(q1Fix);
    out.multiply(q0Screen.setFromAxisAngle(vZee, -getScreenOrientationAngleRad()));
  }

  var sharedAudioCtx = null;
  var bgmChain = null;
  const BGM_MASTER = 0.03;

  function initSfxPreload() {
    var keys = Object.keys(SFX_MP3);
    for (var i = 0; i < keys.length; i += 1) {
      var name = SFX_MP3[keys[i]];
      try {
        var a = new Audio();
        a.preload = 'auto';
        a.src = AUDIO_BASE + name;
        a.load();
        sfxPreload[name] = a;
      } catch (e) { /*  */ }
    }
  }

  function decodeAb(ac, ab) {
    var copy = ab.slice(0);
    var p = ac.decodeAudioData(copy);
    if (p && typeof p.then === 'function') {
      return p;
    }
    return new Promise(function (resolve, reject) {
      ac.decodeAudioData(ab.slice(0), resolve, reject);
    });
  }

  function initSfxDecode() {
    var ac = ensureAudio();
    if (!ac || typeof fetch !== 'function') {
      return;
    }
    var list = [SFX_MP3.catLittle, SFX_MP3.catBrief, SFX_MP3.catch, SFX_MP3.win];
    for (var j = 0; j < list.length; j += 1) {
      (function (fname) {
        fetch(AUDIO_BASE + fname)
          .then(function (r) {
            if (!r.ok) {
              throw new Error('sfx');
            }
            return r.arrayBuffer();
          })
          .then(function (ab) {
            return decodeAb(ac, ab);
          })
          .then(function (buf) {
            sfxBuffers[fname] = buf;
          })
          .catch(function () { /*  */ });
      })(list[j]);
    }
  }

  function initBgmPreload() {
    try {
      bgmAudioEl = new Audio(AUDIO_BASE + BGM_FILE);
      bgmAudioEl.loop = true;
      bgmAudioEl.preload = 'auto';
      bgmAudioEl.volume = BGM_VOL_FILE;
      bgmAudioEl.load();
    } catch (e) {
      bgmAudioEl = null;
    }
  }

  function playSfxFileHtmlInner(filename, volume, playbackRate, fallback) {
    var pr = playbackRate;
    if (typeof pr !== 'number' || isNaN(pr)) {
      pr = 1;
    }
    var base = sfxPreload[filename];
    if (base) {
      try {
        var pl = base.cloneNode();
        pl.volume = typeof volume === 'number' ? volume : 1;
        if (Math.abs(pr - 1) > 0.001) {
          pl.playbackRate = pr;
        }
        var playP = pl.play();
        if (playP && playP.catch) {
          playP.catch(function () {
            if (fallback) {
              fallback();
            }
          });
        }
        return;
      } catch (e) {
        if (fallback) {
          fallback();
        }
        return;
      }
    }
    if (fallback) {
      fallback();
    }
  }

  /**
   * 优先 WebAudio Buffer（同一段 MP3，已解码，跟手）；无缓冲或失败再 HTML5；最后 optional fallback（合成等）
   */
  function playSfxFileInner(filename, volume, playbackRate, fallback) {
    var pr = playbackRate;
    if (typeof pr !== 'number' || isNaN(pr)) {
      pr = 1;
    }
    var ac = ensureAudio();
    var buf = sfxBuffers[filename];
    if (buf && ac) {
      var runBuf = function () {
        try {
          var t = ac.currentTime;
          var src = ac.createBufferSource();
          src.buffer = buf;
          if (Math.abs(pr - 1) > 0.001) {
            src.playbackRate.value = pr;
          }
          var g = ac.createGain();
          g.gain.setValueAtTime(typeof volume === 'number' ? volume : 1, t);
          src.connect(g);
          g.connect(ac.destination);
          src.start(t);
        } catch (e) {
          playSfxFileHtmlInner(filename, volume, pr, fallback);
        }
      };
      if (ac.state === 'suspended') {
        ac
          .resume()
          .then(function () {
            runBuf();
          })
          .catch(function () {
            playSfxFileHtmlInner(filename, volume, pr, fallback);
          });
      } else {
        runBuf();
      }
      return;
    }
    playSfxFileHtmlInner(filename, volume, pr, fallback);
  }

  function playSfxFile(filename, volume, fallback) {
    if (!settingsStore.value.sound) return;
    playSfxFileInner(filename, volume, 1, fallback);
  }

  function ensureAudio() {
    if (!settingsStore.value.sound) return null;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      return null;
    }
    if (!sharedAudioCtx) {
      sharedAudioCtx = new Ctx();
    }
    if (sharedAudioCtx.state === 'suspended') {
      try {
        sharedAudioCtx.resume();
      } catch (e) { /*  */ }
    }
    return sharedAudioCtx;
  }

  function stopBgmOsc() {
    if (!bgmChain) {
      return;
    }
    try {
      for (var i = 0; i < bgmChain.oscs.length; i += 1) {
        try {
          bgmChain.oscs[i].stop(0);
          bgmChain.oscs[i].disconnect();
        } catch (e) { /*  */ }
      }
      if (bgmChain.gains) {
        for (var g = 0; g < bgmChain.gains.length; g += 1) {
          try { bgmChain.gains[g].disconnect(); } catch (e4) { /*  */ }
        }
      }
      if (bgmChain.filter) {
        try { bgmChain.filter.disconnect(); } catch (e2) { /*  */ }
      }
      if (bgmChain.filter2) {
        try { bgmChain.filter2.disconnect(); } catch (e5) { /*  */ }
      }
      if (bgmChain.master) {
        try { bgmChain.master.disconnect(); } catch (e3) { /*  */ }
      }
    } catch (e) { /*  */ }
    bgmChain = null;
  }

  function stopBgm() {
    stopBgmOsc();
    if (bgmAudioEl) {
      try {
        bgmAudioEl.pause();
        bgmAudioEl.currentTime = 0;
      } catch (e) { /*  */ }
    }
  }

  function startBgmOsc() {
    var ac = ensureAudio();
    if (!ac) {
      return;
    }
    stopBgmOsc();
    var t = ac.currentTime;
    var filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 480;
    filter.Q.value = 0.2;
    var filter2 = ac.createBiquadFilter();
    filter2.type = 'lowpass';
    filter2.frequency.value = 900;
    filter2.Q.value = 0.15;
    var master = ac.createGain();
    master.gain.setValueAtTime(0, t);
    master.gain.linearRampToValueAtTime(BGM_MASTER, t + 1.2);
    var freqs = [130.81, 164.81, 196.0];
    var wts = [0.5, 0.38, 0.3];
    var oscs = [];
    var gNodes = [];
    for (var j = 0; j < freqs.length; j += 1) {
      var o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = freqs[j];
      var og = ac.createGain();
      og.gain.value = wts[j];
      o.connect(og);
      og.connect(filter);
      o.start(0);
      oscs.push(o);
      gNodes.push(og);
    }
    filter.connect(filter2);
    filter2.connect(master);
    master.connect(ac.destination);
    bgmChain = { master: master, filter: filter, filter2: filter2, oscs: oscs, gains: gNodes };
  }

  function startBgm() {
    if (!settingsStore.value.sound) {
      stopBgm();
      return;
    }
    stopBgmOsc();
    if (bgmAudioEl) {
      try {
        bgmAudioEl.volume = BGM_VOL_FILE;
        bgmAudioEl.currentTime = 0;
        var pr = bgmAudioEl.play();
        if (pr && pr.catch) {
          pr.catch(function () {
            startBgmOsc();
          });
        }
        return;
      } catch (e) {
        startBgmOsc();
        return;
      }
    }
    startBgmOsc();
  }

  function playCatchDingSynth(at) {
    try {
      var ac = ensureAudio();
      if (!ac) {
        return;
      }
      var t0 = at != null && isFinite(at) ? at : ac.currentTime;
      var m = ac.createGain();
      m.gain.setValueAtTime(0.95, t0);
      m.connect(ac.destination);
      [880, 1244, 1960].forEach(function (hz, k) {
        var o = ac.createOscillator();
        var g = ac.createGain();
        o.type = 'sine';
        o.frequency.value = hz;
        var pk = 0.14 * (1 - k * 0.22);
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(pk, t0 + 0.006 + k * 0.018);
        g.gain.exponentialRampToValueAtTime(0.01, t0 + 0.1 + k * 0.04);
        o.connect(g);
        g.connect(m);
        o.start(t0 + k * 0.02);
        o.stop(t0 + 0.22);
      });
    } catch (e) { /*  */ }
  }

  /**
   * 通关琶音：先 HTML5 克隆起播，失败再 WebAudio 缓冲/合成；与抓中/BGM 已起播时同一音频会话，易与结算页同刻出声。
   */
  function playWinJingle() {
    playSfxFileHtmlInner(SFX_MP3.win, 0.66, 1, function () {
      playSfxFileInner(SFX_MP3.win, 0.66, 1, function () {
        var a = ensureAudio();
        if (!a) {
          return;
        }
        if (a.state === 'suspended') {
          a
            .resume()
            .then(function () {
              playWinJingleSynth();
            })
            .catch(function () { /*  */ });
          return;
        }
        playWinJingleSynth();
      });
    });
  }
  function playWinJingleSynth() {
    try {
      var ac = ensureAudio();
      if (!ac) {
        return;
      }
      var t0 = ac.currentTime;
      var bus = ac.createGain();
      bus.gain.setValueAtTime(0.38, t0);
      bus.connect(ac.destination);
      var notes = [523.25, 622.25, 698.46, 783.99, 932.33, 1046.5];
      for (var n = 0; n < notes.length; n += 1) {
        (function (hz, k) {
          var o = ac.createOscillator();
          var g = ac.createGain();
          o.type = 'sine';
          o.frequency.value = hz;
          var st = t0 + k * 0.075;
          g.gain.setValueAtTime(0, st);
          g.gain.linearRampToValueAtTime(0.19, st + 0.018);
          g.gain.exponentialRampToValueAtTime(0.012, st + 0.22);
          o.connect(g);
          g.connect(bus);
          o.start(st);
          o.stop(st + 0.28);
        })(notes[n], n);
      }
    } catch (e) { /*  */ }
  }

  /** 通关时点缀：几星高音「叮叮」；Context 未 running 时尝试 resume 一次再播，避免与点按微任务错开时整段没声 */
  function playWinSparkleSynth(_depth) {
    var depth = _depth | 0;
    try {
      var ac = ensureAudio();
      if (!ac) {
        return;
      }
      if (ac.state !== 'running') {
        if (depth < 1 && ac.state === 'suspended') {
          ac
            .resume()
            .then(function () {
              playWinSparkleSynth(1);
            })
            .catch(function () { /*  */ });
        }
        return;
      }
      var t0 = ac.currentTime;
      var hzList = [2093, 2637, 3136, 3520, 2349];
      for (var s = 0; s < hzList.length; s += 1) {
        (function (hz, k) {
          var o = ac.createOscillator();
          var g = ac.createGain();
          o.type = 'sine';
          o.frequency.value = hz;
          var st = t0 + k * 0.035;
          g.gain.setValueAtTime(0, st);
          g.gain.linearRampToValueAtTime(0.055, st + 0.008);
          g.gain.exponentialRampToValueAtTime(0.002, st + 0.1);
          o.connect(g);
          g.connect(ac.destination);
          o.start(st);
          o.stop(st + 0.12);
        })(hzList[s], s);
      }
    } catch (e) { /*  */ }
  }

  /** 通关：在结算卡弹出时调用；先琶音/MP3（HTML5 优先），再拉 WebAudio 播点缀。 */
  function playWinCelebration() {
    var ac = ensureAudio();
    playWinJingle();
    if (!ac) {
      return;
    }
    var runSparkle = function () {
      playWinSparkleSynth();
    };
    if (ac.state === 'suspended') {
      ac.resume().then(runSparkle).catch(runSparkle);
    } else {
      runSparkle();
    }
  }

  /**
   * 仅走 HTML5 Audio 克隆播放（不经过可能需 await resume 的 WebAudio 缓冲层），
   * 与第三抓点按同栈同步 play()，避免 iOS/Safari 上猫叫被拦。
   */
  function playKittenMewHtml5Only(happy) {
    var v = happy ? 0.95 : 0.96;
    var pr = happy ? 1.1 : 1;
    playSfxFileHtmlInner(SFX_MP3.catLittle, v, pr, function () {
      playKittenMewSynthAfterResume(happy);
    });
  }

  function playKittenMew(happy) {
    var v = happy ? 0.9 : 0.96;
    var pr = happy ? 1.1 : 1;
    playSfxFileInner(
      SFX_MP3.catLittle,
      v,
      pr,
      function () {
        playKittenMewSynthAfterResume(happy);
      }
    );
  }
  function playKittenMewSynthAfterResume(happy) {
    var ac0 = ensureAudio();
    if (ac0 && ac0.state === 'suspended') {
      ac0
        .resume()
        .then(function () {
          playKittenMewSynth(happy);
        })
        .catch(function () {
          playKittenMewSynth(happy);
        });
      return;
    }
    playKittenMewSynth(happy);
  }
  function playKittenMewSynth(happy, at) {
    try {
      var ac = ensureAudio();
      if (!ac) {
        return;
      }
      var t = at != null && isFinite(at) ? at : ac.currentTime;
      var lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = happy ? 3600 : 2400;
      lp.Q.value = 0.5;
      if (happy) {
        var oH = ac.createOscillator();
        oH.type = 'sine';
        oH.frequency.setValueAtTime(520, t);
        oH.frequency.exponentialRampToValueAtTime(420, t + 0.12);
        var gH = ac.createGain();
        gH.gain.setValueAtTime(0, t);
        gH.gain.linearRampToValueAtTime(0.2, t + 0.02);
        gH.gain.exponentialRampToValueAtTime(0.02, t + 0.16);
        oH.connect(lp);
        lp.connect(gH);
        gH.connect(ac.destination);
        oH.start(t);
        oH.stop(t + 0.2);
        return;
      }
      var o = ac.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(760, t);
      o.frequency.exponentialRampToValueAtTime(300, t + 0.16);
      var g0 = ac.createGain();
      g0.gain.setValueAtTime(0, t);
      g0.gain.linearRampToValueAtTime(0.16, t + 0.025);
      g0.gain.exponentialRampToValueAtTime(0.015, t + 0.24);
      o.connect(lp);
      lp.connect(g0);
      g0.connect(ac.destination);
      o.start(t);
      o.stop(t + 0.28);
    } catch (e) { /*  */ }
  }

  /** 抓到且未通关：先抓 SFX，再跟一声猫 */
  function playCatchWithHappyKittenMew() {
    playSfxFileInner(SFX_MP3.catch, 0.64, 1, function () {
      var acD = ensureAudio();
      if (acD && acD.state === 'suspended') {
        acD.resume().then(function () {
          playCatchDingSynth();
        });
        return;
      }
      playCatchDingSynth();
    });
    window.setTimeout(function () {
      playKittenMew(true);
    }, 90);
  }

  function playMeow(angry) {
    if (angry) {
      playSfxFileInner(SFX_MP3.catBrief, 0.92, 1, function () {
        playMeowSynthAfterResume(true);
      });
    } else {
      playMeowSynth(false);
    }
  }
  function playMeowSynthAfterResume(angry) {
    var ac0 = ensureAudio();
    if (ac0 && ac0.state === 'suspended') {
      ac0
        .resume()
        .then(function () {
          playMeowSynth(angry);
        })
        .catch(function () {
          playMeowSynth(angry);
        });
      return;
    }
    playMeowSynth(angry);
  }
  function playMeowSynth(angry) {
    try {
      var ac = ensureAudio();
      if (!ac) {
        return;
      }
      var t = ac.currentTime;
      var o = ac.createOscillator();
      var g = ac.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(angry ? 480 : 400, t);
      o.frequency.exponentialRampToValueAtTime(angry ? 200 : 260, t + 0.22);
      g.gain.setValueAtTime(0.16, t);
      g.gain.exponentialRampToValueAtTime(0.01, t + 0.22);
      o.connect(g);
      g.connect(ac.destination);
      o.start(t);
      o.stop(t + 0.24);
    } catch (e) { /*  */ }
  }

  function pickCat() {
    catchCountedThisSpawn = false;
    var list = CAT_HIDE_SPOTS;
    if (!list || list.length < 1) {
      catSpotId = 'fallback';
      lastCatSpotIndex = -1;
      catPicIndex = catImgEls.length > 0
        ? (Math.floor(Math.random() * catImgEls.length) | 0)
        : 0;
      catTheta = mod(Math.random() * TWO_PI);
      catPhi = Math.PI * 0.5;
      catDir.setFromSpherical(new THREE.Spherical(1, catPhi, catTheta));
      return;
    }
    var n = list.length;
    var idx = Math.floor(Math.random() * n) | 0;
    if (n > 1) {
      var g = 0;
      while (idx === lastCatSpotIndex && g < 12) {
        idx = Math.floor(Math.random() * n) | 0;
        g += 1;
      }
    }
    lastCatSpotIndex = idx;
    const s = list[idx];
    catSpotId = s.id;
    catPicIndex = catImgEls.length > 0
      ? (Math.floor(Math.random() * catImgEls.length) | 0)
      : 0;
    var jt = typeof s.jitterTheta === 'number' ? s.jitterTheta : 0.07;
    var jp = typeof s.jitterPhi === 'number' ? s.jitterPhi : 0.05;
    catTheta = mod(s.theta + (Math.random() * 2 - 1) * jt);
    catPhi = THREE.MathUtils.clamp(
      s.phi + (Math.random() * 2 - 1) * jp,
      SPAWN_PHI_LO,
      SPAWN_PHI_HI,
    );
    catDir.setFromSpherical(new THREE.Spherical(1, catPhi, catTheta));
  }

  function logCatCalibration(lx, ly) {
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
    console.log('%c【躲藏点】复制下面 JSON 到 main.js 的 CAT_HIDE_SPOTS 里', 'color:#7d9fff;font-weight:bold');
    console.log(JSON.stringify(block, null, 2));
    console.log(
      '角度参考: theta=' + (sphCal.theta * 180 / Math.PI).toFixed(2) + '°  phi=' + (sphCal.phi * 180 / Math.PI).toFixed(2) + '°',
    );
  }

  function updateCamera() {
    if (!camera) return;
    var clP = getPitchAllClamp();
    var pitchAll = pitchTouch + pitchGyro;
    pitchAll = THREE.MathUtils.clamp(pitchAll, clP.min, clP.max);
    var phi = THREE.MathUtils.clamp(
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

  function initPano3D() {
    try {
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(FOV_DEG, w / Math.max(1, h), 0.1, 1000);
      camera.position.set(0, 0, 0.0001);
      raycaster = new THREE.Raycaster();
      renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
      renderer.setPixelRatio(dpr);
      canvas.addEventListener('webglcontextlost', function (event) {
        event.preventDefault();
        panoReady = false;
        elError.classList.add('show');
        elError.textContent = '图形环境暂时不可用，正在等待浏览器恢复…';
      });
      canvas.addEventListener('webglcontextrestored', function () {
        elError.classList.remove('show');
        window.location.reload();
      });
      var loader = new THREE.TextureLoader();
      loader.setCrossOrigin('anonymous');
      loader.load(
        PANO_IMAGE,
        function (tex) {
          if (THREE.SRGBColorSpace !== undefined) {
            tex.colorSpace = THREE.SRGBColorSpace;
          }
          var g = new THREE.SphereGeometry(20, 72, 48);
          g.scale(-1, 1, 1);
          var mat = new THREE.MeshBasicMaterial({ map: tex });
          scene.add(new THREE.Mesh(g, mat));
          panoReady = true;
          if (elTitle) {
            elTitle.textContent = CAT_CAL
              ? '校准：转动画面对准躲藏处，轻点一下 → 控制台复制 JSON'
              : (HUD_TITLE_PANO_IDLE || '转动手机，找到躲起来的小猫');
          }
        },
        undefined,
        function () {
          showError();
        },
      );
    } catch (e) {
      showError();
    }
  }

  function resize() {
    dpr = capPixelRatio(window.devicePixelRatio || 1);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    overlay.width = Math.floor(w * dpr);
    overlay.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (renderer) {
      renderer.setSize(w, h, false);
    }
    if (camera) {
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    }
  }

  function projectCatToScreen() {
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
  function getCatScreenHint() {
    if (!camera) {
      return null;
    }
    tempV.copy(catDir).multiplyScalar(12);
    tempV.project(camera);
    var nx = tempV.x;
    var ny = tempV.y;
    if (tempV.z > 1) {
      nx = -nx;
      ny = -ny;
    }
    var cx = w * 0.5;
    var cy = h * 0.5;
    var sx = (nx * 0.5 + 0.5) * w;
    var sy = (-ny * 0.5 + 0.5) * h;
    var dx = sx - cx;
    var dy = sy - cy;
    var len = Math.hypot(dx, dy);
    if (len < 1e-4) {
      len = 1e-4;
    }
    var edge = Math.min(w, h) * 0.38;
    return {
      x: cx + (dx / len) * edge,
      y: cy + (dy / len) * edge,
      ang: Math.atan2(dy, dx),
    };
  }

  function drawHintArrow(x, y, ang) {
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

  function drawHand() {
    if (handT <= 0 || !handImageReady) {
      return;
    }
    const source = handImg;
    const iw = handImg.naturalWidth;
    const ih = handImg.naturalHeight;
    if (iw < 1 || ih < 1) {
      return;
    }
    const p = handT;
    const reach = 1 - p;
    const t = 1 - (1 - reach) * (1 - reach);
    const maxH = h * 0.42;
    const drawH = maxH;
    const drawW = (iw / ih) * drawH;
    const restX = w * REST_ANCHOR_X_FRAC;
    const restY = h * REST_ANCHOR_Y_FRAC;
    const targetX = handAimX;
    const targetY = handAimY;
    const x = restX + (targetX - restX) * t;
    const y = restY + (targetY - restY) * t;
    ctx.save();
    ctx.globalAlpha = 0.99;
    ctx.drawImage(source, 0, 0, iw, ih, x, y, drawW, drawH);
    ctx.restore();
  }

  function drawCatAtScreen(cx, cy, scale, fluffed, showCaught) {
    const useFluff = fluffed && !showCaught;
    const fluffMul = useFluff ? 1.2 : 1;
    const baseH = h * CAT_DRAW_H_FRAC;
    const drawH = baseH * scale * fluffMul;
    ctx.save();
    if (showCaught && catImgCaught.naturalWidth > 0) {
      const src = catImgCaught;
      const drawW = (src.naturalWidth / src.naturalHeight) * drawH;
      ctx.drawImage(
        src, 0, 0, src.naturalWidth, src.naturalHeight,
        cx - drawW * 0.5, cy - drawH * 0.5, drawW, drawH,
      );
      ctx.restore();
      return;
    }
    const img = catImgEls[catPicIndex];
    if (img && img.naturalWidth > 0) {
      const drawW = (img.naturalWidth / img.naturalHeight) * drawH;
      ctx.translate(cx, cy);
      if (useFluff) {
        for (var i = 0; i < 10; i++) {
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
        img, 0, 0, img.naturalWidth, img.naturalHeight,
        -drawW * 0.5, -drawH * 0.5, drawW, drawH,
      );
    } else {
      const s0 = scale * fluffMul;
      ctx.translate(cx, cy);
      ctx.scale(s0, s0);
      if (useFluff) {
        for (var j = 0; j < 10; j++) {
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

  function drawVignette() {
    const r = Math.max(w, h) * 0.75;
    const g = ctx.createRadialGradient(
      w * 0.5, h * 0.45, 0, w * 0.5, h * 0.45, r
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.06)');
    g.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  function stopWinScreenAnimation() {
    if (winConfettiRaf) {
      cancelAnimationFrame(winConfettiRaf);
      winConfettiRaf = 0;
    }
    if (winFxCanvas) {
      var wctx = winFxCanvas.getContext('2d');
      if (wctx) {
        wctx.setTransform(1, 0, 0, 1, 0, 0);
        wctx.clearRect(0, 0, winFxCanvas.width, winFxCanvas.height);
      }
    }
  }

  function startWinScreenAnimation() {
    if (!winFxCanvas) return;
    stopWinScreenAnimation();
    var wctx = winFxCanvas.getContext('2d');
    if (!wctx) return;
    var parent = winFxCanvas.parentElement;
    var rect = parent ? parent.getBoundingClientRect() : { width: 400, height: 700 };
    var cw = Math.max(1, Math.floor(rect.width));
    var ch = Math.max(1, Math.floor(rect.height));
    var dpr = Math.min(typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1, 2);
    winFxCanvas.width = cw * dpr;
    winFxCanvas.height = ch * dpr;
    winFxCanvas.style.width = cw + 'px';
    winFxCanvas.style.height = ch + 'px';
    wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var cx = cw * 0.5;
    var cy = ch * 0.4;
    var P = [];
    var i;
    for (i = 0; i < 88; i++) {
      var ang = Math.random() * TWO_PI;
      var sp = 5 + Math.random() * 14;
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
        c: WIN_CONFETTI_COLORS[i % WIN_CONFETTI_COLORS.length],
      });
    }
    for (i = 0; i < 36; i++) {
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
        c: WIN_CONFETTI_COLORS[(i + 3) % WIN_CONFETTI_COLORS.length],
      });
    }
    var t0 = performance.now();
    function frame() {
      if (!wctx) return;
      var elapsed = performance.now() - t0;
      wctx.clearRect(0, 0, cw, ch);
      var j;
      var p;
      for (j = 0; j < P.length; j++) {
        p = P[j];
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
    }
    winConfettiRaf = requestAnimationFrame(frame);
  }

  function triggerWinBurstClass() {
    try {
      elWin.classList.remove('win-burst');
      if (typeof elWin.offsetWidth === 'number') {
        elWin.offsetWidth;
      }
      elWin.classList.add('win-burst');
      window.setTimeout(function () {
        try {
          elWin.classList.remove('win-burst');
        } catch (e2) { /*  */ }
      }, 750);
    } catch (e) { /*  */ }
  }

  function drawScene2D(isFluff) {
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
      var refT2 = tLastSawCatOnScreen > 0 ? tLastSawCatOnScreen : tCatSpawn;
      if (Date.now() - refT2 >= CAT_HINT_NO_SIGHT_MS) {
        const hpt2 = getCatScreenHint();
        if (hpt2) {
          drawHintArrow(hpt2.x, hpt2.y, hpt2.ang);
        }
      }
    }
  }

  function updateCatchTimeHud() {
    if (!elCatchTimeHud) {
      return;
    }
    if (!catchRoundTimesSec.length) {
      elCatchTimeHud.textContent = '';
      elCatchTimeHud.style.display = 'none';
      return;
    }
    elCatchTimeHud.style.display = 'block';
    elCatchTimeHud.textContent = catchRoundTimesSec
      .map(function (sec, i) {
        return '第' + String(i + 1) + '次 ' + String(sec) + 's';
      })
      .join(' · ');
  }

  function updateHUD() {
    if (!gameStarted) return;
    if (phase === 'intro') {
      elTitle.textContent = '找猫中 ' + String(catches) + '/3 · 即将开始';
      elStats.textContent =
        '全景 360° ·' + (gyroOn ? ' 陀螺仪已开' : ' 可点补开');
      if (tIntroEnd > 0) {
        const leftIntro = Math.max(0, tIntroEnd - Date.now());
        const rIntro = Math.max(0, leftIntro / INTRO_MS);
        elTimerFill.style.transform = 'scaleX(' + String(rIntro) + ')';
      } else {
        elTimerFill.style.transform = 'scaleX(1)';
      }
      elTimerWrap.style.display = 'block';
      if (elCatchTimeHud) {
        elCatchTimeHud.textContent = '';
        elCatchTimeHud.style.display = 'none';
      }
      return;
    }
    elTitle.textContent = '找猫中 ' + String(catches) + '/3';
    elStats.textContent =
      '全景 360° ·' +
      (gyroOn ? ' 陀螺仪已开' : ' 可点补开') +
      (catches === 2 && thirdCatEscapes > 0
        ? ' · 第3只已溜走 ' + String(thirdCatEscapes) + '/3 次'
        : '');
    if (phase === 'hunt') {
      const left = HUNT_LIMIT_MS - (Date.now() - tCatSpawn);
      const r = Math.max(0, left / HUNT_LIMIT_MS);
      elTimerFill.style.transform = 'scaleX(' + String(r) + ')';
      elTimerWrap.style.display = 'block';
    } else {
      elTimerFill.style.transform = 'scaleX(0)';
      if (phase === 'fluff') {
        elTimerWrap.style.display = 'none';
      }
    }
  }

  function onFrame() {
    if (!gameStarted) {
      if (ctx && w > 0) {
        ctx.clearRect(0, 0, w, h);
      }
      if (panoReady && scene && camera && renderer) {
        updateCamera();
        renderer.render(scene, camera);
      } else {
        if (ctx && w > 0) {
          ctx.fillStyle = '#1a1a20';
          ctx.fillRect(0, 0, w, h);
        }
      }
      requestAnimationFrame(onFrame);
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
        window.setTimeout(function () { playKittenMew(); }, 100);
        updateHUD();
      }
    }
    if (panoReady && scene && camera && renderer) {
      updateCamera();
      renderer.render(scene, camera);
    }
    var isFluff = phase === 'fluff';
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
    requestAnimationFrame(onFrame);
  }

  function tryHit(touchX, touchY) {
    if (phase !== 'hunt' || !camera) return;
    handAimX = touchX;
    handAimY = touchY;
    handT = 1;
    var ndcX = (touchX / w) * 2 - 1;
    var ndcY = -(touchY / h) * 2 + 1;
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const dirDot = raycaster.ray.direction.dot(catDir);
    const pCat = projectCatToScreen();
    const rHit = Math.max(96, CAT_HIT_R_FRAC * Math.min(w, h));
    const near2d = pCat && Math.hypot(pCat.x - touchX, pCat.y - touchY) < rHit;
    if (dirDot < CAT_HIT_COS && !near2d) {
      playMeow(true);
      pickCat();
      tCatSpawn = Date.now();
      tLastSawCatOnScreen = 0;
      window.setTimeout(function () { playKittenMew(); }, 100);
      return;
    }
    if (catchCountedThisSpawn) {
      return;
    }
    catchCountedThisSpawn = true;
    if (
      catches === 2 &&
      thirdCatEscapes < 3 &&
      Math.random() < THIRD_CAT_ESCAPE_P
    ) {
      thirdCatEscapes += 1;
      pickCat();
      /** pickCat 会把 catchCountedThisSpawn 置 false；若本机连发 pointerup/同次操作二次 tryHit，会立刻被当成「再中第三只」而误通关，故溜走后的短窗口内禁止再判抓 */
      catchCountedThisSpawn = true;
      if (thirdCatEscapeCooldownTimer) {
        clearTimeout(thirdCatEscapeCooldownTimer);
        thirdCatEscapeCooldownTimer = 0;
      }
      thirdCatEscapeCooldownTimer = window.setTimeout(function () {
        thirdCatEscapeCooldownTimer = 0;
        catchCountedThisSpawn = false;
      }, 420);
      tCatSpawn = Date.now();
      tLastSawCatOnScreen = 0;
      elTimerWrap.style.display = 'block';
      showCatEscapeSub();
      playMeow(true);
      window.setTimeout(function () {
        playKittenMew();
      }, 80);
      updateHUD();
      return;
    }
    var roundSec = (Date.now() - tCatSpawn) / 1000;
    if (!isFinite(roundSec) || roundSec < 0) {
      roundSec = 0;
    }
    catchRoundTimesSec.push(Math.round(roundSec * 10) / 10);
    updateCatchTimeHud();
    catches += 1;
    if (catches < 3) {
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
      var bestSec = saveBest(localStorage, Number(sec));
      window.setTimeout(function () {
        var _acW2 = ensureAudio();
        if (_acW2) {
          try {
            if (_acW2.state === 'suspended') {
              _acW2.resume();
            }
          } catch (e0) { /*  */ }
        }
        stopBgm();
        playWinCelebration();
        elStart.style.display = 'none';
        elWin.style.display = 'flex';
        try {
          var wh2 = elWin.querySelector('.win-hero');
          if (wh2) {
            wh2.classList.remove('win-hero');
            wh2.offsetWidth;
            wh2.classList.add('win-hero');
          }
        } catch (e2) { /*  */ }
        triggerWinBurstClass();
        startWinScreenAnimation();
        var wtx = document.getElementById('winTimeText');
        if (wtx) {
          var tplW = wtx.getAttribute('data-time-template');
          var ssec = String(sec);
          if (tplW && String(tplW).indexOf('{sec}') >= 0) {
            wtx.textContent = String(tplW).replace(/\{sec\}/g, ssec);
          } else {
            wtx.textContent =
              '总用时 ' + ssec + ' 秒。猫猫终于投入你的怀抱啦。';
          }
          wtx.textContent += ' 本机最佳 ' + bestSec.toFixed(1) + ' 秒。';
        }
        renderWinLeaderboard(String(sec));
      }, 500);
    }
  }

  const dragThreshold = 14;
  var ptrDown = { x: 0, y: 0, x0: 0, y0: 0, id: -1, time: 0, drag: false };
  function onPointerDown(e) {
    try {
      e.preventDefault();
      ptrDown = {
        x: e.clientX,
        y: e.clientY,
        x0: e.clientX,
        y0: e.clientY,
        id: e.pointerId,
        time: Date.now(),
        drag: false,
      };
      if (e.target && typeof e.target.setPointerCapture === 'function') {
        e.target.setPointerCapture(e.pointerId);
      }
    } catch (err) {
      showError();
    }
  }
  function onPointerMove(e) {
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
      var cl2 = getPitchAllClamp();
      var nextP = pitchTouch + dy * 0.003;
      var s2 = nextP + pitchGyro;
      s2 = THREE.MathUtils.clamp(s2, cl2.min, cl2.max);
      pitchTouch = s2 - pitchGyro;
    }
  }
  function onPointerUp(e) {
    try {
      e.preventDefault();
    } catch (er) { /*  */ }
    if (e.pointerId !== ptrDown.id) return;
    try {
      if (e.target && typeof e.target.releasePointerCapture === 'function') {
        e.target.releasePointerCapture(e.pointerId);
      }
    } catch (er) { /*  */ }
    try {
      const rect = canvas.getBoundingClientRect();
      const lx = e.clientX - rect.left;
      const ly = e.clientY - rect.top;
      const moveAll = Math.hypot(
        e.clientX - ptrDown.x0,
        e.clientY - ptrDown.y0,
      );
      const isShortTap = moveAll < TAP_MOVE_MAX;
      if (CAT_CAL && isShortTap && panoReady && camera && w > 0
        && (phase === 'intro' || !gameStarted)) {
        logCatCalibration(lx, ly);
        ptrDown.id = -1;
        return;
      }
      if (
        isShortTap &&
        gameStarted &&
        phase === 'hunt' &&
        Date.now() - ptrDown.time < 800
      ) {
        tryHit(lx, ly);
      }
    } catch (err) {
      showError();
    }
    ptrDown.id = -1;
  }
  function onPointerCancel() {
    ptrDown.id = -1;
  }

  function onOrientation(e) {
    if (!gyroOn) return;
    if (ptrDown && ptrDown.id !== -1) {
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
    var dYaw = eulerGyroDelta.y;
    if (dYaw > Math.PI) dYaw -= TWO_PI;
    if (dYaw < -Math.PI) dYaw += TWO_PI;
    var dPitch = eulerGyroDelta.x;
    if (dPitch > Math.PI) dPitch -= TWO_PI;
    if (dPitch < -Math.PI) dPitch += TWO_PI;
    qGyroPrev.copy(qGyro);
    var dRaw = dYaw * (180 / Math.PI);
    dRaw = Math.max(-GYRO_MAX_STEP_DEG, Math.min(GYRO_MAX_STEP_DEG, dRaw));
    gyroDeltaSmooth = gyroDeltaSmooth * (1 - GYRO_SMOOTH) + dRaw * GYRO_SMOOTH;
    if (Math.abs(gyroDeltaSmooth) >= GYRO_APPLY_MIN) {
      yawGyro = mod(
        yawGyro - gyroDeltaSmooth * (Math.PI / 180) * GYRO_GAIN,
      );
    }
    var dRawP = dPitch * (180 / Math.PI);
    dRawP = Math.max(-GYRO_MAX_STEP_DEG, Math.min(GYRO_MAX_STEP_DEG, dRawP));
    gyroDeltaSmoothPitch = gyroDeltaSmoothPitch * (1 - GYRO_SMOOTH) + dRawP * GYRO_SMOOTH;
    if (Math.abs(gyroDeltaSmoothPitch) >= GYRO_APPLY_MIN) {
      var dPrad = gyroDeltaSmoothPitch * (Math.PI / 180) * GYRO_GAIN;
      var sumP = pitchTouch + (pitchGyro + dPrad);
      var cl3 = getPitchAllClamp();
      sumP = THREE.MathUtils.clamp(sumP, cl3.min, cl3.max);
      pitchGyro = sumP - pitchTouch;
    }
  }

  function attachGyroSensors() {
    if (gyroListenerAttached) {
      gyroOn = true;
      return;
    }
    gyroListenerAttached = true;
    gyroOn = true;
    onOrientationChangeHandler = function () {
      gyroQPrevValid = false;
    };
    try {
      window.addEventListener('orientationchange', onOrientationChangeHandler, { passive: true });
    } catch (e) {
      window.addEventListener('orientationchange', onOrientationChangeHandler, false);
    }
    window.addEventListener('deviceorientation', onOrientation, { passive: true });
  }

  function tryRequestGyroInUserGesture() {
    if (!settingsStore.value.gyro) {
      gyroOn = false;
      return;
    }
    if (gyroListenerAttached) {
      attachGyroSensors();
      return;
    }
    const DOE = window.DeviceOrientationEvent;
    const DME = window.DeviceMotionEvent;
    if (!DOE && !DME) {
      return;
    }
    if (DOE && typeof DOE.requestPermission === 'function') {
      try {
        DOE.requestPermission()
          .then(function (st) {
            if (st === 'granted') {
              attachGyroSensors();
            }
          })
          .catch(function () { /*  */ });
      } catch (e) {
        attachGyroSensors();
      }
      return;
    }
    if (DME && typeof DME.requestPermission === 'function') {
      DME.requestPermission()
        .then(function (st) {
          if (st === 'granted') {
            attachGyroSensors();
          }
        })
        .catch(function () { /*  */ });
      return;
    }
    attachGyroSensors();
  }

  function showGameIntroSub() {
    if (!elGameIntroSub || !elGameIntroSubWrap) {
      return;
    }
    elGameIntroSub.textContent = introSubDisplay;
    elGameIntroSubWrap.setAttribute('aria-hidden', 'false');
    elGameIntroSubWrap.style.display = 'flex';
    window.requestAnimationFrame(function () {
      if (elGameIntroSubWrap) {
        elGameIntroSubWrap.classList.add('show');
      }
    });
  }

  function hideGameIntroSub() {
    if (!elGameIntroSubWrap) {
      return;
    }
    elGameIntroSubWrap.classList.remove('show');
    window.setTimeout(function () {
      if (elGameIntroSubWrap) {
        elGameIntroSubWrap.style.display = 'none';
        elGameIntroSubWrap.setAttribute('aria-hidden', 'true');
      }
    }, 320);
  }

  function showCatEscapeSub() {
    if (!elCatEscapeSub) {
      return;
    }
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
    window.requestAnimationFrame(function () {
      if (elCatEscapeSub) {
        elCatEscapeSub.classList.add('show');
      }
    });
    catEscapeSubHideTimer = window.setTimeout(function () {
      catEscapeSubHideTimer = 0;
      if (elCatEscapeSub) {
        elCatEscapeSub.classList.remove('show');
      }
      catEscapeSubCleanupTimer = window.setTimeout(function () {
        catEscapeSubCleanupTimer = 0;
        if (elCatEscapeSub) {
          elCatEscapeSub.style.display = 'none';
          elCatEscapeSub.setAttribute('aria-hidden', 'true');
        }
      }, 320);
    }, CAT_ESCAPE_SUB_MS);
  }

  function endIntroToHunt() {
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

  function startGame() {
    elStart.style.display = 'none';
    elWin.style.display = 'none';
    elCardPanel.style.display = 'none';
    var ac0 = ensureAudio();
    if (ac0) {
      ac0
        .resume()
        .then(function () {
          startBgm();
        })
        .catch(function () {
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
    if (CAT_CAL) {
      phase = 'hunt';
      tGameStart = Date.now();
      pickCat();
      tCatSpawn = Date.now();
      tLastSawCatOnScreen = 0;
      elTimerWrap.style.display = 'block';
      if (elGameIntroSubWrap) {
        elGameIntroSubWrap.style.display = 'none';
        elGameIntroSubWrap.classList.remove('show');
        elGameIntroSubWrap.setAttribute('aria-hidden', 'true');
      }
    } else {
      phase = 'intro';
      tCatSpawn = 0;
      tIntroEnd = Date.now() + INTRO_MS;
      elTimerWrap.style.display = 'block';
      elTimerFill.style.transform = 'scaleX(1)';
      showGameIntroSub();
    }
    updateHUD();
  }

  /** 底图 cover 铺满画布 */
  function drawShareCardImageCover(ctx, img, w, h) {
    var iw = img.naturalWidth;
    var ih = img.naturalHeight;
    if (iw <= 0 || ih <= 0) {
      return false;
    }
    var s = Math.max(w / iw, h / ih);
    var dw = iw * s;
    var dh = ih * s;
    ctx.drawImage(img, 0, 0, iw, ih, (w - dw) * 0.5, (h - dh) * 0.5, dw, dh);
    return true;
  }

  function drawShareCardTime(secStr) {
    const W = 720;
    const H = 1280;
    cctx.textAlign = 'center';
    cctx.textBaseline = 'middle';

    var hasBg = false;
    if (shareCardBgImg && shareCardBgImg.naturalWidth > 0) {
      hasBg = drawShareCardImageCover(cctx, shareCardBgImg, W, H);
    }
    if (!hasBg) {
      var gF = cctx.createLinearGradient(0, 0, W, H);
      gF.addColorStop(0, '#2a1a22');
      gF.addColorStop(1, '#1a1520');
      cctx.fillStyle = gF;
      cctx.fillRect(0, 0, W, H);
    }

    var cx = W * 0.5;
    /** 大号秒数几何中心约在整图高度 70% 处（相对 720×1280 导出画布） */
    var yTimeCenter = H * 0.7;
    var yLabel = yTimeCenter - 86;
    var ySec = yTimeCenter;
    var yUnit = yTimeCenter + 62;

    cctx.fillStyle = 'rgba(80, 55, 65, 0.88)';
    cctx.font = '22px "PingFang SC", "Hiragino Sans GB", sans-serif';
    cctx.fillText('总用时', cx, yLabel);

    cctx.save();
    cctx.lineWidth = 5;
    cctx.strokeStyle = 'rgba(255, 255, 255, 0.88)';
    cctx.lineJoin = 'round';
    cctx.miterLimit = 2;
    cctx.fillStyle = '#c73d5e';
    cctx.font = 'bold 96px "PingFang SC", "Hiragino Sans GB", sans-serif';
    cctx.strokeText(String(secStr), cx, ySec);
    cctx.fillText(String(secStr), cx, ySec);
    cctx.restore();

    cctx.textBaseline = 'alphabetic';
    cctx.fillStyle = 'rgba(95, 70, 78, 0.88)';
    cctx.font = '32px "PingFang SC", sans-serif';
    cctx.fillText('秒', cx, yUnit);
  }

  function openCard() {
    stopWinScreenAnimation();
    const txt = document.getElementById('winTimeText').textContent;
    const m = txt.match(/([\d.]+)\s*秒/);
    const sec = m ? m[1] : '?';
    elWin.style.display = 'none';
    elCardPanel.style.display = 'flex';
    var draw = function () {
      drawShareCardTime(sec);
    };
    var prim = [shareCardBgImg];
    var dec = [];
    for (var di = 0; di < prim.length; di += 1) {
      if (prim[di] && typeof prim[di].decode === 'function') {
        dec.push(
          prim[di]
            .decode()
            .catch(function () { return undefined; })
        );
      }
    }
    if (dec.length) {
      Promise.all(dec)
        .then(function () { draw(); })
        .catch(function () { draw(); });
    } else {
      window.requestAnimationFrame(draw);
    }
  }

  var lastStartUiAt = 0;
  var lastGyroBtnAt = 0;
  function onStartOrAgainTapped() {
    const t = Date.now();
    if (t - lastStartUiAt < 500) {
      return;
    }
    lastStartUiAt = t;
    try {
      tryRequestGyroInUserGesture();
    } catch (err) { /*  */ }
    try {
      playKittenMew();
    } catch (e) { /*  */ }
    window.setTimeout(function () {
      startGame();
    }, 0);
  }
  function onGyroButtonTapped() {
    const t = Date.now();
    if (t - lastGyroBtnAt < 500) {
      return;
    }
    lastGyroBtnAt = t;
    try {
      tryRequestGyroInUserGesture();
    } catch (err) { /*  */ }
  }

  function initSettings() {
    const button = document.getElementById('btnSettings');
    const panel = document.getElementById('settingsPanel');
    const sound = document.getElementById('settingSound');
    const gyro = document.getElementById('settingGyro');
    const motion = document.getElementById('settingMotion');
    if (!button || !panel || !sound || !gyro || !motion) return;

    applySettings(settingsStore.value);
    sound.checked = settingsStore.value.sound;
    gyro.checked = settingsStore.value.gyro;
    motion.checked = settingsStore.value.reducedMotion;

    button.addEventListener('click', function () {
      const open = panel.hidden;
      panel.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
    });
    sound.addEventListener('change', function () {
      settingsStore.update({ sound: sound.checked });
      if (!sound.checked) stopBgm();
      else if (gameStarted) startBgm();
    });
    gyro.addEventListener('change', function () {
      settingsStore.update({ gyro: gyro.checked });
      gyroOn = gyro.checked && gyroListenerAttached;
      if (gyro.checked) tryRequestGyroInUserGesture();
    });
    motion.addEventListener('change', function () {
      settingsStore.update({ reducedMotion: motion.checked });
      if (motion.checked) stopWinScreenAnimation();
    });
  }

  function initEvents() {
    window.addEventListener('resize', function () { resize(); });
    btnStart.addEventListener('click', onStartOrAgainTapped);
    btnAgain.addEventListener('click', onStartOrAgainTapped);
    btnCard.addEventListener('click', function () { openCard(); });
    btnBackWin.addEventListener('click', function () {
      elCardPanel.style.display = 'none';
      elWin.style.display = 'flex';
      triggerWinBurstClass();
    });
    btnSaveCard.addEventListener('click', function () {
      try {
        const url = cardCanvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.setAttribute('href', url);
        a.setAttribute('download', '寻喵大作战-战绩.png');
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch (err) {
        showError();
      }
    });
    btnGyro.addEventListener('click', onGyroButtonTapped);
    canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
    canvas.addEventListener('pointermove', onPointerMove, { passive: false });
    canvas.addEventListener('pointerup', onPointerUp, { passive: false });
    canvas.addEventListener('pointercancel', onPointerCancel, { passive: true });
    document.addEventListener('visibilitychange', function () {
      lastFrame = performance.now();
      if (document.hidden && bgmAudioEl) bgmAudioEl.pause();
      if (!document.hidden && gameStarted && settingsStore.value.sound) startBgm();
    });
  }

  function init() {
    resize();
    try {
      initSfxPreload();
    } catch (e) { /*  */ }
    try {
      ensureAudio();
    } catch (e) { /*  */ }
    try {
      initSfxDecode();
    } catch (e) { /*  */ }
    try {
      initBgmPreload();
    } catch (e) { /*  */ }
    try {
      initPano3D();
    } catch (e) {
      showError();
      return;
    }
    window.addEventListener('load', function () {
      try {
        resize();
      } catch (e) { /*  */ }
    });
    initSettings();
    initEvents();
    onFrame(0);
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
    } catch (e) { /*  */ }
  }

  try {
    {
      var _load = elTitle && elTitle.getAttribute('data-hud-loading');
      elTitle.textContent =
        (_load && String(_load).trim()) || '正在加载全景图…';
    }
    init();
  } catch (err) {
    showError();
  }
})();
