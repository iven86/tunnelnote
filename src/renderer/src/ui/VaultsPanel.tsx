import { useState } from 'react';
import type { VaultEntry, VaultsState } from '../../../shared/vault-contract';
import { VaultForm } from './VaultForm';

interface VaultsPanelProps {
  vaults: VaultsState;
  onState(state: VaultsState, message?: string): void;
  onError(message: string | null): void;
  onClosed?(vaultId: string): void;
}

export function VaultsPanel({ vaults, onState, onError, onClosed }: VaultsPanelProps) {
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<VaultsState>, message?: string): Promise<void> {
    setBusy(true);
    onError(null);
    try {
      onState(await action(), message);
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : 'The vault operation failed.');
    } finally {
      setBusy(false);
    }
  }

  function renderEntry(entry: VaultEntry) {
    const active = vaults.activeId === entry.id;
    return (
      <article className={active ? 'vault-card active' : 'vault-card'} key={entry.id}>
        <div className="vault-card-head">
          <span className={entry.status === 'unlocked' ? 'vault-dot on' : 'vault-dot'} />
          <div className="vault-card-copy">
            <span className="vault-card-name">{entry.name}</span>
            <span className="hint">
              {entry.status === 'unlocked' ? 'Unlocked' : 'Locked'}
              {active ? ' · default for new hosts' : ''}
            </span>
          </div>
        </div>
        <div className="vault-card-actions">
          {entry.status === 'unlocked' ? (
            <>
              {!active ? (
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void run(() => window.tunnelNote.setActiveVault(entry.id))}
                  type="button"
                >
                  Make default
                </button>
              ) : null}
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await window.tunnelNote.saveVault(entry.id);
                    return window.tunnelNote.getVaultState();
                  }, `${entry.name} saved.`)
                }
                type="button"
              >
                Save
              </button>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void run(() => window.tunnelNote.lockVault(entry.id))}
                type="button"
              >
                Lock
              </button>
            </>
          ) : unlocking === entry.id ? (
            <form
              className="vault-unlock-inline"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const next = await window.tunnelNote.unlockVault(entry.id, password);
                  setPassword('');
                  setUnlocking(null);
                  return next;
                });
              }}
            >
              <input
                aria-label={`Master password for ${entry.name}`}
                autoComplete="current-password"
                autoFocus
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Master password"
                required
                type="password"
                value={password}
              />
              <button disabled={busy} type="submit">
                Unlock
              </button>
            </form>
          ) : (
            <button
              disabled={busy}
              onClick={() => {
                setUnlocking(entry.id);
                setPassword('');
              }}
              type="button"
            >
              Unlock
            </button>
          )}
          <button
            aria-label={`Close ${entry.name}`}
            className="icon-button"
            disabled={busy}
            onClick={() => {
              onClosed?.(entry.id);
              void run(() => window.tunnelNote.closeVault(entry.id));
            }}
            title="Close vault"
            type="button"
          >
            ×
          </button>
        </div>
      </article>
    );
  }

  return (
    <section className="workspace-panel vaults-panel" aria-labelledby="vaults-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Security</p>
          <h2 id="vaults-heading">Vaults</h2>
        </div>
        <span className="hint">Open several encrypted vaults at the same time.</span>
      </div>
      <div className="host-layout">
        <div className="vault-list">
          {vaults.vaults.length === 0 ? (
            <p className="hint">No vault is open yet.</p>
          ) : (
            vaults.vaults.map(renderEntry)
          )}
        </div>
        <VaultForm
          onError={onError}
          onState={(next, message) => onState(next, message)}
          title={vaults.vaults.length === 0 ? 'Encrypted vault' : 'Add another vault'}
        />
      </div>
    </section>
  );
}
