import type { GameResult } from '../game/session';
import { settingsStore } from './settings';
import { drawShareCardTime } from './share-card';
import { createWinEffects } from './win-effects';
/** 结算页虚拟排行榜（总用时秒数，与玩家合并后按时间升序，纯演示） */
const WIN_LEADERBOARD_VIRTUAL = [
  { name: '摸鱼第一名', timeSec: 8.4 },
  { name: '橘座本座', timeSec: 11.2 },
  { name: '猫爪印', timeSec: 14.6 },
  { name: '云吸猫大师', timeSec: 19.1 },
  { name: '路人小周', timeSec: 24.8 },
];

interface ResultElements {
  win: HTMLElement;
  card: HTMLElement;
  time: HTMLElement;
  leaderboard: HTMLElement;
  cardCanvas: HTMLCanvasElement;
  confettiCanvas: HTMLCanvasElement;
}
export function createResultView(elements: ResultElements) {
  const elWinLeaderboardList = elements.leaderboard;
  const effects = createWinEffects(elements.confettiCanvas);
  const image = new Image();
  const ctx = elements.cardCanvas.getContext('2d');
  let result: GameResult | null = null;
  let burstTimer = 0;
  let revision = 0;
  const drawCard = () => {
    if (result && ctx) drawShareCardTime(ctx, image, result.totalSeconds.toFixed(1));
  };
  image.addEventListener('load', () => {
    if (elements.card.style.display === 'flex') drawCard();
  });
  image.src = './images/喵分享卡片.png';
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

  function stopEffects() {
    effects.stop();
    clearTimeout(burstTimer);
    elements.win.classList.remove('win-burst');
  }
  function showWin() {
    if (!result) return;
    elements.card.style.display = 'none';
    elements.win.style.display = 'flex';
    if (!settingsStore.value.reducedMotion) effects.start();
  }
  return {
    setResult(value: GameResult, bestSeconds: number) {
      result = value;
      revision++;
      const seconds = value.totalSeconds.toFixed(1);
      const template = elements.time.getAttribute('data-time-template');
      elements.time.textContent =
        (template?.includes('{sec}')
          ? template.replace(/\{sec\}/g, seconds)
          : `总用时 ${seconds} 秒。猫猫终于投入你的怀抱啦。`) +
        ` 本机最佳 ${bestSeconds.toFixed(1)} 秒。`;
      renderWinLeaderboard(seconds);
    },
    showWin,
    stopEffects,
    celebrate() {
      showWin();
      elements.win.classList.remove('win-burst');
      void elements.win.offsetWidth;
      elements.win.classList.add('win-burst');
      clearTimeout(burstTimer);
      burstTimer = window.setTimeout(() => elements.win.classList.remove('win-burst'), 750);
    },
    openCard() {
      if (!result) return;
      stopEffects();
      elements.win.style.display = 'none';
      elements.card.style.display = 'flex';
      drawCard();
      const current = revision;
      if (typeof image.decode === 'function') {
        void image
          .decode()
          .catch(() => undefined)
          .then(() => {
            if (revision === current && elements.card.style.display === 'flex') drawCard();
          });
      }
    },
    reset() {
      result = null;
      revision++;
      stopEffects();
      elements.win.style.display = 'none';
      elements.card.style.display = 'none';
    },
  };
}
