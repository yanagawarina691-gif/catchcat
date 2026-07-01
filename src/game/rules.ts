import { GAME_CONFIG, type HideSpot } from './config';

export function pickHideSpot(
  spots: readonly HideSpot[],
  previousIndex: number,
  random = Math.random,
): number {
  if (spots.length === 0) throw new Error('At least one hide spot is required');
  if (spots.length === 1) return 0;
  const offset = Math.floor(random() * (spots.length - 1)) + 1;
  return ((previousIndex < 0 ? 0 : previousIndex) + offset) % spots.length;
}

export function shouldThirdCatEscape(
  caughtCount: number,
  escapeCount: number,
  random = Math.random,
): boolean {
  return (
    caughtCount === GAME_CONFIG.catchesToWin - 1 &&
    escapeCount < GAME_CONFIG.maxThirdCatEscapes &&
    random() < GAME_CONFIG.thirdCatEscapeChance
  );
}

export function elapsedSeconds(startMs: number, endMs: number): number {
  return Math.max(0, Math.round(((endMs - startMs) / 1000) * 10) / 10);
}
