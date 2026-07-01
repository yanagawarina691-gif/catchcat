export interface GameSettings {
  sound: boolean;
  gyro: boolean;
  reducedMotion: boolean;
}

const KEY = 'catchcat_settings_v1';

function systemReducedMotion(): boolean {
  return typeof window !== 'undefined'
    ? (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
    : false;
}

export function defaultSettings(): GameSettings {
  return { sound: true, gyro: true, reducedMotion: systemReducedMotion() };
}

export function loadSettings(storage: Pick<Storage, 'getItem'> = localStorage): GameSettings {
  const defaults = defaultSettings();
  try {
    const parsed = JSON.parse(storage.getItem(KEY) ?? '{}') as Partial<GameSettings>;
    return {
      sound: typeof parsed.sound === 'boolean' ? parsed.sound : defaults.sound,
      gyro: typeof parsed.gyro === 'boolean' ? parsed.gyro : defaults.gyro,
      reducedMotion:
        typeof parsed.reducedMotion === 'boolean' ? parsed.reducedMotion : defaults.reducedMotion,
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(
  value: GameSettings,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    storage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Settings remain valid for this session.
  }
}

export const settingsStore = {
  value: typeof window !== 'undefined' ? loadSettings() : defaultSettings(),
  update(patch: Partial<GameSettings>) {
    this.value = { ...this.value, ...patch };
    saveSettings(this.value);
    applySettings(this.value);
  },
};

export function applySettings(settings: GameSettings): void {
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('reduce-motion', settings.reducedMotion);
  }
}
