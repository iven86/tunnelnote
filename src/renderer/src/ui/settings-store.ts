import { DEFAULT_SETTINGS, type AppSettings } from '../../../shared/settings-contract';

let current: AppSettings = DEFAULT_SETTINGS;

export function setRendererSettings(next: AppSettings): void {
  current = next;
}

export function getRendererSettings(): AppSettings {
  return current;
}
