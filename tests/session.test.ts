import { describe, expect, it } from 'vitest';
import { GameSession } from '../src/game/session';
import { GAME_CONFIG } from '../src/game/config';

describe('game session', () => {
  it('excludes the intro from scoring and prevents counting one catch twice', () => {
    const session = new GameSession();
    session.start(1000);
    expect(session.catch(1200)).toBe('ignored');
    expect(session.advance(2999)).toBeNull();
    expect(session.advance(3000)).toBe('intro-ended');
    expect(session.catch(4000, false)).toBe('caught');
    expect(session.catch(4001, false)).toBe('ignored');
    expect(session.catches).toBe(1);
    expect(session.advance(5201)).toBe('fluff-ended');
    expect(session.catch(6201, false)).toBe('caught');
    session.advance(7402);
    expect(session.catch(8402, false)).toBe('won');
    expect(session.active).toBe(false);
    expect(session.result).toEqual({ totalSeconds: 5.4, roundSeconds: [1, 1, 1] });
    const result = session.result;
    session.start(10000);
    expect(session.result).toBeNull();
    expect(session.roundSeconds).toEqual([]);
    expect(result?.roundSeconds).toEqual([1, 1, 1]);
  });
  it('handles timeout and the real third-cat escape path with a bounded cooldown', () => {
    const session = new GameSession();
    session.start(1000, true);
    expect(session.advance(8001)).toBe('expired');
    expect(session.spawnedAt).toBe(8001);
    session.catch(9000);
    session.advance(10201);
    session.catch(11000);
    session.advance(12201);
    for (let attempt = 0; attempt < GAME_CONFIG.maxThirdCatEscapes; attempt++) {
      const time = 13000 + attempt * 500;
      expect(session.catch(time, true, () => 0)).toBe('escaped');
      expect(session.catch(time + 419, true, () => 0)).toBe('ignored');
    }
    expect(session.catch(14500, true, () => 0)).toBe('won');
    expect(session.escapeCount).toBe(3);
  });
});
