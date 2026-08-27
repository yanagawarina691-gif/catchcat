import { describe, expect, it } from 'vitest';
import { CAT_HIDE_SPOTS, GAME_CONFIG } from '../src/game/config';
import { elapsedSeconds, pickHideSpot, shouldThirdCatEscape } from '../src/game/rules';

describe('game rules', () => {
  it('does not repeat the previous hide spot', () => {
    for (let previous = 0; previous < CAT_HIDE_SPOTS.length; previous += 1) {
      expect(pickHideSpot(CAT_HIDE_SPOTS, previous, () => 0)).not.toBe(previous);
      expect(pickHideSpot(CAT_HIDE_SPOTS, previous, () => 0.999)).not.toBe(previous);
    }
  });

  it('always returns a valid index for every previous spot and random seed', () => {
    const seeds = [0, 0.1, 0.333, 0.5, 0.777, 0.999];
    for (let previous = -1; previous < CAT_HIDE_SPOTS.length; previous += 1) {
      for (const seed of seeds) {
        const idx = pickHideSpot(CAT_HIDE_SPOTS, previous, () => seed);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(CAT_HIDE_SPOTS.length);
        expect(Number.isInteger(idx)).toBe(true);
      }
    }
  });

  it('rejects an empty spot list', () => {
    expect(() => pickHideSpot([], 0)).toThrow();
  });

  it('always picks the only spot when the list has one entry', () => {
    expect(pickHideSpot([CAT_HIDE_SPOTS[0]!], 0)).toBe(0);
  });

  it('only lets the third cat escape up to the configured limit', () => {
    expect(shouldThirdCatEscape(2, 0, () => 0)).toBe(true);
    expect(shouldThirdCatEscape(1, 0, () => 0)).toBe(false);
    expect(shouldThirdCatEscape(2, GAME_CONFIG.maxThirdCatEscapes, () => 0)).toBe(false);
    expect(shouldThirdCatEscape(2, 0, () => 1)).toBe(false);
  });

  it('calculates non-negative elapsed time to one decimal place', () => {
    expect(elapsedSeconds(1_000, 2_249)).toBe(1.2);
    expect(elapsedSeconds(2_000, 1_000)).toBe(0);
    expect(elapsedSeconds(1_000, 1_000)).toBe(0);
    expect(elapsedSeconds(0, 99)).toBe(0.1);
    expect(elapsedSeconds(0, -5_000)).toBe(0);
  });
});
