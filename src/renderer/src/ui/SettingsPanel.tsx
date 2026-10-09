import { useEffect, useState } from 'react';
import type { AppSettings, SettingsState } from '../../../shared/settings-contract';
import { setRendererSettings } from './settings-store';

interface SettingsPanelProps {
  onState(state: SettingsState): void;
}

export function SettingsPanel({ onState }: SettingsPanelProps) {
  const [state, setState] = useState<SettingsState | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.tunnelNote
      .getSettings()
      .then((next) => {
        setState(next);
        setDraft(next.settings);
      })
      .catch((e: unknown) => setError(message(e)));
  }, []);

  if (!state || !draft) {
    return <section className="workspace-panel">{error ?? 'Loading settings…'}</section>;
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings);
  const restartNeeded =
    (state.settings.dataDirectory ?? state.paths.defaultDataDirectory) !==
    state.paths.activeDataDirectory;

  const patch = (change: Partial<AppSettings>): void => setDraft({ ...draft, ...change });
  const patchLog = (change: Partial<AppSettings['sessionLogging']>): void =>
    setDraft({ ...draft, sessionLogging: { ...draft.sessionLogging, ...change } });

  async function save(): Promise<void> {
    if (!draft) {
      return;
    }
    setError(null);
    try {
      const next = await window.tunnelNote.updateSettings(draft);
      setState(next);
      setDraft(next.settings);
      setRendererSettings(next.settings);
      onState(next);
      setNotice('Settings saved.');
    } catch (e: unknown) {
      setError(message(e));
      setNotice(null);
    }
  }

  async function pick(apply: (path: string) => void): Promise<void> {
    const result = await window.tunnelNote.chooseFolder();
    if (result.selected && result.path) {
      apply(result.path);
    }
  }

  const number = (value: string, fallback: number): number => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return (
    <section className="workspace-panel settings-panel" aria-labelledby="settings-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Preferences</p>
          <h2 id="settings-heading">Settings</h2>
        </div>
        <div className="button-row">
          <button disabled={!dirty} onClick={() => void save()} type="button">
            Save settings
          </button>
          <button
            className="secondary-button"
            disabled={!dirty}
            onClick={() => setDraft(state.settings)}
            type="button"
          >
            Reset changes
          </button>
        </div>
      </div>
      {notice ? <p className="status">{notice}</p> : null}
      {error ? <p className="status status-error">{error}</p> : null}

      <div className="settings-grid">
        <fieldset className="settings-group">
          <legend>Storage</legend>
          <p className="hint">
            Notes, snippets, forwarding rules and plugins are stored here as plain files. Hosts and
            credentials stay inside your encrypted vault files.
          </p>
          <label htmlFor="set-data">Data folder</label>
          <div className="path-row">
            <input
              id="set-data"
              onChange={(e) => patch({ dataDirectory: e.target.value.trim() || null })}
              placeholder={state.paths.defaultDataDirectory}
              value={draft.dataDirectory ?? ''}
            />
            <button
              className="secondary-button"
              onClick={() => void pick((path) => patch({ dataDirectory: path }))}
              type="button"
            >
              Browse…
            </button>
            <button
              className="secondary-button"
              onClick={() => patch({ dataDirectory: null })}
              type="button"
            >
              Default
            </button>
          </div>
          <p className="hint">Currently in use: {state.paths.activeDataDirectory}</p>
          {restartNeeded ? (
            <p className="status status-error">
              Restart TunnelNote to use the new data folder. Existing files are not moved; copy them
              over yourself if you want to keep them.
            </p>
          ) : null}
          <div className="button-row">
            <button
              className="secondary-button"
              onClick={() => void window.tunnelNote.openFolder('data')}
              type="button"
            >
              Open data folder
            </button>
          </div>
          <p className="hint">Settings file: {state.paths.settingsFile}</p>
        </fieldset>

        <fieldset className="settings-group">
          <legend>Security</legend>
          <label htmlFor="set-idle">Auto-lock vaults after (minutes of inactivity)</label>
          <input
            id="set-idle"
            max={240}
            min={1}
            onChange={(e) => patch({ idleLockMinutes: number(e.target.value, 5) })}
            type="number"
            value={draft.idleLockMinutes}
          />
          <label className="check-row">
            <input
              checked={draft.lockOnMinimize}
              onChange={(e) => patch({ lockOnMinimize: e.target.checked })}
              type="checkbox"
            />
            Lock all vaults when the window is minimized
          </label>
        </fieldset>

        <fieldset className="settings-group">
          <legend>Terminal</legend>
          <label htmlFor="set-font">Font size</label>
          <input
            id="set-font"
            max={32}
            min={8}
            onChange={(e) => patch({ terminalFontSize: number(e.target.value, 13) })}
            type="number"
            value={draft.terminalFontSize}
          />
          <label htmlFor="set-scroll">Scrollback lines</label>
          <input
            id="set-scroll"
            max={100000}
            min={500}
            onChange={(e) => patch({ terminalScrollback: number(e.target.value, 5000) })}
            step={500}
            type="number"
            value={draft.terminalScrollback}
          />
          <p className="hint">Applies to terminals opened after saving.</p>
        </fieldset>

        <fieldset className="settings-group">
          <legend>Session logging</legend>
          <label className="check-row">
            <input
              checked={draft.sessionLogging.enabled}
              onChange={(e) => patchLog({ enabled: e.target.checked })}
              type="checkbox"
            />
            Save SSH session output to log files
          </label>
          <label htmlFor="set-log-mode">Log layout</label>
          <select
            id="set-log-mode"
            onChange={(e) => patchLog({ mode: e.target.value as 'perSession' | 'single' })}
            value={draft.sessionLogging.mode}
          >
            <option value="perSession">One file per session (server-date-time.log)</option>
            <option value="single">All sessions in one file (tunnelnote-sessions.log)</option>
          </select>
          <label htmlFor="set-log-dir">Log folder</label>
          <div className="path-row">
            <input
              id="set-log-dir"
              onChange={(e) => patchLog({ directory: e.target.value.trim() || null })}
              placeholder={state.paths.logsDirectory}
              value={draft.sessionLogging.directory ?? ''}
            />
            <button
              className="secondary-button"
              onClick={() => void pick((path) => patchLog({ directory: path }))}
              type="button"
            >
              Browse…
            </button>
            <button
              className="secondary-button"
              onClick={() => patchLog({ directory: null })}
              type="button"
            >
              Default
            </button>
          </div>
          <label className="check-row">
            <input
              checked={draft.sessionLogging.stripAnsi}
              onChange={(e) => patchLog({ stripAnsi: e.target.checked })}
              type="checkbox"
            />
            Remove terminal color/control codes for readable text
          </label>
          <p className="hint">
            Logs are plain text and contain everything the server prints, including any secrets
            shown on screen. Keystrokes you type (such as passwords) are not recorded. Applies to
            sessions started after saving.
          </p>
          <div className="button-row">
            <button
              className="secondary-button"
              onClick={() => void window.tunnelNote.openFolder('logs')}
              type="button"
            >
              Open log folder
            </button>
          </div>
        </fieldset>
      </div>
    </section>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The settings operation failed.';
}
