import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  appSettingsSchema,
  DEFAULT_SETTINGS,
  type AppSettings,
  type SettingsState,
} from '../../shared/settings-contract';

/**
 * Settings live in a fixed bootstrap file inside Electron's default userData
 * folder, so the (movable) data directory itself can be configured.
 */
export class SettingsService {
  private current: AppSettings;
  private readonly runningDataDirectory: string;
  private readonly listeners = new Set<(settings: AppSettings) => void>();

  constructor(
    private readonly defaultDataDirectory: string,
    private readonly file = join(defaultDataDirectory, 'settings.json'),
  ) {
    this.current = this.load();
    this.runningDataDirectory = this.current.dataDirectory ?? defaultDataDirectory;
  }

  get(): AppSettings {
    return this.current;
  }

  /** Directory used for notes, snippets, forwarding rules and plugins in this run. */
  dataDirectory(): string {
    return this.runningDataDirectory;
  }

  logsDirectory(settings = this.current): string {
    return settings.sessionLogging.directory ?? join(this.runningDataDirectory, 'logs');
  }

  state(): SettingsState {
    return {
      settings: this.current,
      paths: {
        defaultDataDirectory: this.defaultDataDirectory,
        activeDataDirectory: this.runningDataDirectory,
        logsDirectory: this.logsDirectory(),
        settingsFile: this.file,
      },
    };
  }

  onChange(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async update(next: unknown): Promise<SettingsState> {
    const parsed = appSettingsSchema.parse(next);
    for (const path of [parsed.dataDirectory, parsed.sessionLogging.directory]) {
      if (path !== null && !isAbsolute(path)) {
        throw new Error('Folders must be absolute paths.');
      }
    }
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    await rename(temporary, this.file);
    this.current = parsed;
    for (const listener of this.listeners) {
      listener(parsed);
    }
    return this.state();
  }

  private load(): AppSettings {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      const merged = {
        ...DEFAULT_SETTINGS,
        ...(raw as object),
        sessionLogging: {
          ...DEFAULT_SETTINGS.sessionLogging,
          ...((raw as { sessionLogging?: object }).sessionLogging ?? {}),
        },
      };
      return appSettingsSchema.parse(merged);
    } catch {
      return DEFAULT_SETTINGS;
    }
  }
}
