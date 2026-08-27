import { describe, expect, it } from 'vitest';
import { defaultSettings, loadSettings, saveSettings, type GameSettings } from '../src/ui/settings';

describe('settings storage', () => {
  it('loads saved booleans and fills missing defaults', () => {
    const storage = { getItem: () => JSON.stringify({ sound: false, gyro: false }) };
    expect(loadSettings(storage)).toMatchObject({ sound: false, gyro: false });
  });

  it('keeps reducedMotion when explicitly saved as false', () => {
    const storage = { getItem: () => JSON.stringify({ reducedMotion: false }) };
    expect(loadSettings(storage).reducedMotion).toBe(false);
  });

  it('round-trips through save then load', () => {
    const value: GameSettings = { sound: false, gyro: false, reducedMotion: true };
    let stored = '';
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, next: string) => {
        stored = next;
      },
    };
    saveSettings(value, storage);
    expect(loadSettings(storage)).toEqual(value);
  });

  it('survives malformed or unavailable storage', () => {
    expect(loadSettings({ getItem: () => '{broken' })).toMatchObject({
      sound: true,
      gyro: true,
    });
    const value: GameSettings = { sound: false, gyro: true, reducedMotion: true };
    expect(() =>
      saveSettings(value, {
        setItem: () => {
          throw new Error('quota');
        },
      }),
    ).not.toThrow();
  });

  it('provides sound and gyro defaults on', () => {
    const defaults = defaultSettings();
    expect(defaults.sound).toBe(true);
    expect(defaults.gyro).toBe(true);
  });
});
