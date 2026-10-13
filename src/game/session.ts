import { GAME_CONFIG } from './config';
import { elapsedSeconds, shouldThirdCatEscape } from './rules';

export type GamePhase = 'menu' | 'intro' | 'hunt' | 'fluff' | 'won';
export interface GameResult {
  readonly totalSeconds: number;
  readonly roundSeconds: readonly number[];
}

/** Game transitions and scoring have no dependency on the DOM, rendering or real time. */
export class GameSession {
  phase: GamePhase = 'menu';
  catches = 0;
  escapeCount = 0;
  startedAt = 0;
  spawnedAt = 0;
  introEndsAt = 0;
  private fluffStartedAt = 0;
  private catchBlockedUntil = 0;
  readonly roundSeconds: number[] = [];
  result: GameResult | null = null;

  get active(): boolean {
    return this.phase !== 'menu' && this.phase !== 'won';
  }

  start(now: number, skipIntro = false): void {
    this.catches = 0;
    this.escapeCount = 0;
    this.roundSeconds.length = 0;
    this.result = null;
    this.catchBlockedUntil = 0;
    this.fluffStartedAt = 0;
    this.startedAt = skipIntro ? now : 0;
    this.spawnedAt = skipIntro ? now : 0;
    this.introEndsAt = skipIntro ? 0 : now + GAME_CONFIG.introMs;
    this.phase = skipIntro ? 'hunt' : 'intro';
  }

  respawn(now: number): void {
    this.phase = 'hunt';
    this.spawnedAt = now;
  }

  advance(now: number): 'intro-ended' | 'expired' | 'fluff-ended' | null {
    if (this.phase === 'intro' && now >= this.introEndsAt) {
      this.introEndsAt = 0;
      this.startedAt = now;
      this.respawn(now);
      return 'intro-ended';
    }
    if (this.phase === 'hunt' && now - this.spawnedAt > GAME_CONFIG.huntLimitMs) {
      this.respawn(now);
      return 'expired';
    }
    if (this.phase === 'fluff' && now - this.fluffStartedAt > GAME_CONFIG.fluffMs) {
      this.respawn(now);
      return 'fluff-ended';
    }
    return null;
  }

  catch(
    now: number,
    allowEscape = true,
    random = Math.random,
  ): 'ignored' | 'escaped' | 'caught' | 'won' {
    if (this.phase !== 'hunt' || now < this.catchBlockedUntil) return 'ignored';
    if (allowEscape && shouldThirdCatEscape(this.catches, this.escapeCount, random)) {
      this.escapeCount++;
      this.respawn(now);
      this.catchBlockedUntil = now + 420;
      return 'escaped';
    }
    this.roundSeconds.push(elapsedSeconds(this.spawnedAt, now));
    this.catches++;
    this.spawnedAt = 0;
    if (this.catches < GAME_CONFIG.catchesToWin) {
      this.phase = 'fluff';
      this.fluffStartedAt = now;
      return 'caught';
    }
    this.phase = 'won';
    this.result = Object.freeze({
      totalSeconds: elapsedSeconds(this.startedAt, now),
      roundSeconds: Object.freeze([...this.roundSeconds]),
    });
    return 'won';
  }
}
