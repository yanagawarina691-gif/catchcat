import { describe, expect, it } from 'vitest';
import { readBest, saveBest } from '../src/game/storage';

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe('best score storage', () => {
  it('keeps the fastest valid result', () => {
    const storage = memoryStorage();
    expect(saveBest(storage, 12.5)).toBe(12.5);
    expect(saveBest(storage, 15)).toBe(12.5);
    expect(saveBest(storage, 9.8)).toBe(9.8);
    expect(readBest(storage)).toBe(9.8);
  });

  it('treats malformed data as missing', () => {
    expect(readBest(memoryStorage('not-a-number'))).toBeNull();
  });
});
