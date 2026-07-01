import { describe, expect, it } from 'vitest';
import { loadSettings, saveSettings, type GameSettings } from '../src/ui/settings';

describe('settings storage', () => {
  it('loads saved booleans and fills missing defaults', () => {
    const storage = { getItem: () => JSON.stringify({ sound: false, gyro: false }) };
    expect(loadSettings(storage)).toMatchObject({ sound: false, gyro: false });
  });

  it('survives malformed or unavailable storage', () => {
    expect(loadSettings({ getItem: () => '{broken' })).toMatchObject({
      sound: true,
      gyro: true,
    });
    const value: GameSettings = { sound: false, gyro: true, reducedMotion: true };
    expect(() => saveSettings(value, { setItem: () => { throw new Error('quota'); } })).not.toThrow();
  });
});
