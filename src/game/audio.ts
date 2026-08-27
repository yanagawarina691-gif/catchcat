import { settingsStore } from '../ui/settings';

const AUDIO_BASE = './audio/';
const BGM_FILE = 'bgm-main.mp3';
const BGM_VOL_FILE = 0.28;
const BGM_MASTER = 0.03;

const SFX_MP3 = {
  catLittle: 'cat-mew-little.mp3',
  catBrief: 'cat-mew-brief.mp3',
  catch: 'sfx-catch.mp3',
  win: 'sfx-win-chime.mp3',
} as const;

/** decodeAudioData 后的短音效，用 BufferSource 播，避免 HTML5 Audio 起播卡、跟手差 */
const sfxBuffers: Record<string, AudioBuffer> = {};
const sfxPreload: Record<string, HTMLAudioElement> = {};
let bgmAudioEl: HTMLAudioElement | null = null;
let sharedAudioCtx: AudioContext | null = null;

interface BgmChain {
  master: GainNode;
  filter: BiquadFilterNode;
  filter2: BiquadFilterNode;
  oscs: OscillatorNode[];
  gains: GainNode[];
}
let bgmChain: BgmChain | null = null;

function getAudioCtor(): typeof AudioContext | null {
  const Ctx = window.AudioContext;
  if (Ctx) return Ctx;
  return (
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? null
  );
}

/** 声音开关关闭时返回 null；开启时保证返回（尽量 running）的共享 AudioContext */
export function ensureAudio(): AudioContext | null {
  if (!settingsStore.value.sound) return null;
  const Ctx = getAudioCtor();
  if (!Ctx) return null;
  if (!sharedAudioCtx) {
    sharedAudioCtx = new Ctx();
  }
  if (sharedAudioCtx.state === 'suspended') {
    try {
      void sharedAudioCtx.resume();
    } catch {
      /* ignore */
    }
  }
  return sharedAudioCtx;
}

export function initSfxPreload(): void {
  for (const name of Object.values(SFX_MP3)) {
    try {
      const a = new Audio();
      a.preload = 'auto';
      a.src = AUDIO_BASE + name;
      a.load();
      sfxPreload[name] = a;
    } catch {
      /* ignore */
    }
  }
}

function decodeAb(ac: AudioContext, ab: ArrayBuffer): Promise<AudioBuffer> {
  const copy = ab.slice(0);
  const p = ac.decodeAudioData(copy);
  if (p && typeof p.then === 'function') {
    return p;
  }
  return new Promise((resolve, reject) => {
    ac.decodeAudioData(ab.slice(0), resolve, reject);
  });
}

export function initSfxDecode(): void {
  const ac = ensureAudio();
  if (!ac || typeof fetch !== 'function') {
    return;
  }
  const list = [SFX_MP3.catLittle, SFX_MP3.catBrief, SFX_MP3.catch, SFX_MP3.win];
  for (const fname of list) {
    fetch(AUDIO_BASE + fname)
      .then((r) => {
        if (!r.ok) throw new Error('sfx');
        return r.arrayBuffer();
      })
      .then((ab) => decodeAb(ac, ab))
      .then((buf) => {
        sfxBuffers[fname] = buf;
      })
      .catch(() => {
        /* ignore */
      });
  }
}

export function initBgmPreload(): void {
  try {
    bgmAudioEl = new Audio(AUDIO_BASE + BGM_FILE);
    bgmAudioEl.loop = true;
    bgmAudioEl.preload = 'auto';
    bgmAudioEl.volume = BGM_VOL_FILE;
    bgmAudioEl.load();
  } catch {
    bgmAudioEl = null;
  }
}

function playSfxFileHtmlInner(
  filename: string,
  volume?: number,
  playbackRate?: number,
  fallback?: () => void,
): void {
  const pr = typeof playbackRate === 'number' && !isNaN(playbackRate) ? playbackRate : 1;
  const base = sfxPreload[filename];
  if (base) {
    try {
      const pl = base.cloneNode() as HTMLAudioElement;
      pl.volume = typeof volume === 'number' ? volume : 1;
      if (Math.abs(pr - 1) > 0.001) {
        pl.playbackRate = pr;
      }
      const playP = pl.play();
      if (playP && playP.catch) {
        playP.catch(() => {
          fallback?.();
        });
      }
      return;
    } catch {
      fallback?.();
      return;
    }
  }
  fallback?.();
}

/**
 * 优先 WebAudio Buffer（同一段 MP3，已解码，跟手）；无缓冲或失败再 HTML5；最后 optional fallback（合成等）
 */
function playSfxFileInner(
  filename: string,
  volume?: number,
  playbackRate?: number,
  fallback?: () => void,
): void {
  const pr = typeof playbackRate === 'number' && !isNaN(playbackRate) ? playbackRate : 1;
  const ac = ensureAudio();
  const buf = sfxBuffers[filename];
  if (buf && ac) {
    const runBuf = (): void => {
      try {
        const t = ac.currentTime;
        const src = ac.createBufferSource();
        src.buffer = buf;
        if (Math.abs(pr - 1) > 0.001) {
          src.playbackRate.value = pr;
        }
        const g = ac.createGain();
        g.gain.setValueAtTime(typeof volume === 'number' ? volume : 1, t);
        src.connect(g);
        g.connect(ac.destination);
        src.start(t);
      } catch {
        playSfxFileHtmlInner(filename, volume, pr, fallback);
      }
    };
    if (ac.state === 'suspended') {
      ac.resume()
        .then(runBuf)
        .catch(() => {
          playSfxFileHtmlInner(filename, volume, pr, fallback);
        });
    } else {
      runBuf();
    }
    return;
  }
  playSfxFileHtmlInner(filename, volume, pr, fallback);
}

export function playSfxFile(filename: string, volume?: number, fallback?: () => void): void {
  if (!settingsStore.value.sound) return;
  playSfxFileInner(filename, volume, 1, fallback);
}

function stopBgmOsc(): void {
  if (!bgmChain) return;
  try {
    for (const o of bgmChain.oscs) {
      try {
        o.stop(0);
        o.disconnect();
      } catch {
        /* ignore */
      }
    }
    for (const g of bgmChain.gains) {
      try {
        g.disconnect();
      } catch {
        /* ignore */
      }
    }
    try {
      bgmChain.filter.disconnect();
    } catch {
      /* ignore */
    }
    try {
      bgmChain.filter2.disconnect();
    } catch {
      /* ignore */
    }
    try {
      bgmChain.master.disconnect();
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
  bgmChain = null;
}

export function stopBgm(): void {
  stopBgmOsc();
  if (bgmAudioEl) {
    try {
      bgmAudioEl.pause();
      bgmAudioEl.currentTime = 0;
    } catch {
      /* ignore */
    }
  }
}

export function pauseBgm(): void {
  if (bgmAudioEl) {
    try {
      bgmAudioEl.pause();
    } catch {
      /* ignore */
    }
  }
}

function startBgmOsc(): void {
  const ac = ensureAudio();
  if (!ac) return;
  stopBgmOsc();
  const t = ac.currentTime;
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 480;
  filter.Q.value = 0.2;
  const filter2 = ac.createBiquadFilter();
  filter2.type = 'lowpass';
  filter2.frequency.value = 900;
  filter2.Q.value = 0.15;
  const master = ac.createGain();
  master.gain.setValueAtTime(0, t);
  master.gain.linearRampToValueAtTime(BGM_MASTER, t + 1.2);
  const freqs = [130.81, 164.81, 196.0];
  const wts = [0.5, 0.38, 0.3];
  const oscs: OscillatorNode[] = [];
  const gNodes: GainNode[] = [];
  for (let j = 0; j < freqs.length; j += 1) {
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.value = freqs[j]!;
    const og = ac.createGain();
    og.gain.value = wts[j]!;
    o.connect(og);
    og.connect(filter);
    o.start(0);
    oscs.push(o);
    gNodes.push(og);
  }
  filter.connect(filter2);
  filter2.connect(master);
  master.connect(ac.destination);
  bgmChain = { master, filter, filter2, oscs, gains: gNodes };
}

/**
 * 开启/恢复 BGM。resume=true 时（如切后台回前台）保留播放位置，不从头开始。
 */
export function startBgm(resume = false): void {
  if (!settingsStore.value.sound) {
    stopBgm();
    return;
  }
  stopBgmOsc();
  if (bgmAudioEl) {
    try {
      bgmAudioEl.volume = BGM_VOL_FILE;
      if (!resume) {
        bgmAudioEl.currentTime = 0;
      }
      const pr = bgmAudioEl.play();
      if (pr && pr.catch) {
        pr.catch(() => {
          startBgmOsc();
        });
      }
      return;
    } catch {
      startBgmOsc();
      return;
    }
  }
  startBgmOsc();
}

function playCatchDingSynth(at?: number): void {
  try {
    const ac = ensureAudio();
    if (!ac) return;
    const t0 = at != null && isFinite(at) ? at : ac.currentTime;
    const m = ac.createGain();
    m.gain.setValueAtTime(0.95, t0);
    m.connect(ac.destination);
    [880, 1244, 1960].forEach((hz, k) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = hz;
      const pk = 0.14 * (1 - k * 0.22);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(pk, t0 + 0.006 + k * 0.018);
      g.gain.exponentialRampToValueAtTime(0.01, t0 + 0.1 + k * 0.04);
      o.connect(g);
      g.connect(m);
      o.start(t0 + k * 0.02);
      o.stop(t0 + 0.22);
    });
  } catch {
    /* ignore */
  }
}

function playWinJingle(): void {
  playSfxFileHtmlInner(SFX_MP3.win, 0.66, 1, () => {
    playSfxFileInner(SFX_MP3.win, 0.66, 1, () => {
      const a = ensureAudio();
      if (!a) return;
      if (a.state === 'suspended') {
        a.resume()
          .then(playWinJingleSynth)
          .catch(() => {
            /* ignore */
          });
        return;
      }
      playWinJingleSynth();
    });
  });
}

function playWinJingleSynth(): void {
  try {
    const ac = ensureAudio();
    if (!ac) return;
    const t0 = ac.currentTime;
    const bus = ac.createGain();
    bus.gain.setValueAtTime(0.38, t0);
    bus.connect(ac.destination);
    const notes = [523.25, 622.25, 698.46, 783.99, 932.33, 1046.5];
    notes.forEach((hz, k) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = hz;
      const st = t0 + k * 0.075;
      g.gain.setValueAtTime(0, st);
      g.gain.linearRampToValueAtTime(0.19, st + 0.018);
      g.gain.exponentialRampToValueAtTime(0.012, st + 0.22);
      o.connect(g);
      g.connect(bus);
      o.start(st);
      o.stop(st + 0.28);
    });
  } catch {
    /* ignore */
  }
}

function playWinSparkleSynth(depth = 0): void {
  try {
    const ac = ensureAudio();
    if (!ac) return;
    if (ac.state !== 'running') {
      if (depth < 1 && ac.state === 'suspended') {
        ac.resume()
          .then(() => playWinSparkleSynth(1))
          .catch(() => {
            /* ignore */
          });
      }
      return;
    }
    const t0 = ac.currentTime;
    const hzList = [2093, 2637, 3136, 3520, 2349];
    hzList.forEach((hz, k) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = hz;
      const st = t0 + k * 0.035;
      g.gain.setValueAtTime(0, st);
      g.gain.linearRampToValueAtTime(0.055, st + 0.008);
      g.gain.exponentialRampToValueAtTime(0.002, st + 0.1);
      o.connect(g);
      g.connect(ac.destination);
      o.start(st);
      o.stop(st + 0.12);
    });
  } catch {
    /* ignore */
  }
}

/** 通关：先琶音/MP3（HTML5 优先），再拉 WebAudio 播点缀。 */
function playWinCelebration(): void {
  const ac = ensureAudio();
  playWinJingle();
  if (!ac) return;
  const runSparkle = (): void => {
    playWinSparkleSynth();
  };
  if (ac.state === 'suspended') {
    ac.resume().then(runSparkle).catch(runSparkle);
  } else {
    runSparkle();
  }
}

function playKittenMewSynth(happy?: boolean, at?: number): void {
  try {
    const ac = ensureAudio();
    if (!ac) return;
    const t = at != null && isFinite(at) ? at : ac.currentTime;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = happy ? 3600 : 2400;
    lp.Q.value = 0.5;
    if (happy) {
      const oH = ac.createOscillator();
      oH.type = 'sine';
      oH.frequency.setValueAtTime(520, t);
      oH.frequency.exponentialRampToValueAtTime(420, t + 0.12);
      const gH = ac.createGain();
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
    const o = ac.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(760, t);
    o.frequency.exponentialRampToValueAtTime(300, t + 0.16);
    const g0 = ac.createGain();
    g0.gain.setValueAtTime(0, t);
    g0.gain.linearRampToValueAtTime(0.16, t + 0.025);
    g0.gain.exponentialRampToValueAtTime(0.015, t + 0.24);
    o.connect(lp);
    lp.connect(g0);
    g0.connect(ac.destination);
    o.start(t);
    o.stop(t + 0.28);
  } catch {
    /* ignore */
  }
}

function playKittenMewSynthAfterResume(happy?: boolean): void {
  const ac0 = ensureAudio();
  if (ac0 && ac0.state === 'suspended') {
    ac0
      .resume()
      .then(() => playKittenMewSynth(happy))
      .catch(() => playKittenMewSynth(happy));
    return;
  }
  playKittenMewSynth(happy);
}

export function playKittenMew(happy?: boolean): void {
  const v = happy ? 0.9 : 0.96;
  const pr = happy ? 1.1 : 1;
  playSfxFileInner(SFX_MP3.catLittle, v, pr, () => {
    playKittenMewSynthAfterResume(happy);
  });
}

function playMeowSynth(angry?: boolean): void {
  try {
    const ac = ensureAudio();
    if (!ac) return;
    const t = ac.currentTime;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(angry ? 480 : 400, t);
    o.frequency.exponentialRampToValueAtTime(angry ? 200 : 260, t + 0.22);
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.01, t + 0.22);
    o.connect(g);
    g.connect(ac.destination);
    o.start(t);
    o.stop(t + 0.24);
  } catch {
    /* ignore */
  }
}

function playMeowSynthAfterResume(angry?: boolean): void {
  const ac0 = ensureAudio();
  if (ac0 && ac0.state === 'suspended') {
    ac0
      .resume()
      .then(() => playMeowSynth(angry))
      .catch(() => playMeowSynth(angry));
    return;
  }
  playMeowSynth(angry);
}

export function playMeow(angry?: boolean): void {
  if (angry) {
    playSfxFileInner(SFX_MP3.catBrief, 0.92, 1, () => {
      playMeowSynthAfterResume(true);
    });
  } else {
    playMeowSynth(false);
  }
}

/** 抓到且未通关：先抓 SFX，再跟一声猫 */
export function playCatchWithHappyKittenMew(): void {
  playSfxFileInner(SFX_MP3.catch, 0.64, 1, () => {
    const acD = ensureAudio();
    if (acD && acD.state === 'suspended') {
      acD.resume().then(() => playCatchDingSynth());
      return;
    }
    playCatchDingSynth();
  });
  window.setTimeout(() => {
    playKittenMew(true);
  }, 90);
}

export { playWinCelebration };
