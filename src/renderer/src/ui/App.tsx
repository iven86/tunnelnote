import { useEffect, useState } from 'react';
import type { AppInfo } from '../../../shared/app-info';
import type { VaultsState } from '../../../shared/vault-contract';
import { Logo } from './Logo';
import { SshWorkspace } from './SshWorkspace';
import { LockScreen } from './LockScreen';
import { getRendererSettings, setRendererSettings } from './settings-store';

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [vaults, setVaults] = useState<VaultsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.tunnelNote.onVaultState((state) => {
      if (active) {
        setVaults(state);
      }
    });
    Promise.all([
      window.tunnelNote.getAppInfo(),
      window.tunnelNote.getVaultState(),
      window.tunnelNote.getSettings(),
    ])
      .then(([info, state, loaded]) => {
        setRendererSettings(loaded.settings);
        if (active) {
          setAppInfo(info);
          setVaults(state);
        }
      })
      .catch((requestError: unknown) => {
        if (active) {
          setError(
            requestError instanceof Error ? requestError.message : 'Unable to load app info.',
          );
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  function applyState(state: VaultsState, notice?: string): void {
    setVaults(state);
    setMessage(notice ?? null);
  }

  function reportError(next: string | null): void {
    setError(next);
    if (next) {
      setMessage(null);
    }
  }

  const unlocked = vaults?.vaults.filter((entry) => entry.status === 'unlocked') ?? [];

  return (
    <main className="app-shell app-shell-wide">
      <header className="top-bar">
        <h1 className="brand" id="welcome-heading">
          <Logo />
        </h1>
        {unlocked.length > 0 ? (
          <span className="status">
            {unlocked.length} vault{unlocked.length === 1 ? '' : 's'} unlocked
          </span>
        ) : null}
      </header>
      {message ? (
        <p className="status global-notice" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="status status-error global-notice" role="alert">
          {error}
        </p>
      ) : null}
      {!appInfo ? <p className="hint app-version">Starting TunnelNote…</p> : null}
      {vaults && unlocked.length > 0 ? (
        <SshWorkspace enabled onError={reportError} onVaultState={applyState} vaults={vaults} />
      ) : vaults ? (
        <LockScreen
          idleMinutes={getRendererSettings().idleLockMinutes}
          onError={reportError}
          onState={applyState}
          vaults={vaults}
        />
      ) : null}
    </main>
  );
}
