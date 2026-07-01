const BEST_KEY = 'catchcat_best';

export function readBest(storage: Pick<Storage, 'getItem'>): number | null {
  try {
    const raw = storage.getItem(BEST_KEY);
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveBest(storage: Pick<Storage, 'getItem' | 'setItem'>, seconds: number): number {
  const previous = readBest(storage);
  const next = previous === null ? seconds : Math.min(previous, seconds);
  try {
    storage.setItem(BEST_KEY, String(next));
  } catch {
    // Private mode and storage quotas must not break the game.
  }
  return next;
}
