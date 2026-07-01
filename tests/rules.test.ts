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

  it('only lets the third cat escape up to the configured limit', () => {
    expect(shouldThirdCatEscape(2, 0, () => 0)).toBe(true);
    expect(shouldThirdCatEscape(1, 0, () => 0)).toBe(false);
    expect(shouldThirdCatEscape(2, GAME_CONFIG.maxThirdCatEscapes, () => 0)).toBe(false);
    expect(shouldThirdCatEscape(2, 0, () => 1)).toBe(false);
  });

  it('calculates non-negative elapsed time to one decimal place', () => {
    expect(elapsedSeconds(1_000, 2_249)).toBe(1.2);
    expect(elapsedSeconds(2_000, 1_000)).toBe(0);
  });
});
