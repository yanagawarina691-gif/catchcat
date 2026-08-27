export const GAME_CONFIG = {
  catchesToWin: 3,
  huntLimitMs: 7_000,
  introMs: 2_000,
  fluffMs: 1_200,
  thirdCatEscapeChance: 0.55,
  maxThirdCatEscapes: 3,
} as const;

export interface HideSpot {
  id: string;
  label: string;
  theta: number;
  phi: number;
  jitterTheta: number;
  jitterPhi: number;
}

export const CAT_HIDE_SPOTS: readonly HideSpot[] = [
  { id: '柜子', label: '柜子', theta: 1.17523, phi: 1.663421, jitterTheta: 0.06, jitterPhi: 0.04 },
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
  { id: '床底', label: '床底', theta: 2.078554, phi: 1.933719, jitterTheta: 0.06, jitterPhi: 0.04 },
  {
    id: '柜子二',
    label: '柜子二',
    theta: 1.010068,
    phi: 1.366893,
    jitterTheta: 0.06,
    jitterPhi: 0.04,
  },
  { id: '桌子', label: '桌子', theta: 2.736616, phi: 2.031936, jitterTheta: 0.06, jitterPhi: 0.04 },
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
