import { useState } from 'react';
import type { VaultsState } from '../../../shared/vault-contract';
import { VaultForm } from './VaultForm';

interface LockScreenProps {
  vaults: VaultsState;
  idleMinutes: number;
  onState(state: VaultsState, message?: string): void;
  onError(message: string | null): void;
}

/** Shown while no vault is unlocked: only the default vault is offered. */
export function LockScreen({ vaults, idleMinutes, onState, onError }: LockScreenProps) {
  const target = vaults.vaults.find((entry) => entry.id === vaults.activeId) ?? vaults.vaults[0];
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [showOther, setShowOther] = useState(false);
  const others = vaults.vaults.length - 1;

  async function unlock(): Promise<void> {
    if (!target) {
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const next = await window.tunnelNote.unlockVault(target.id, password);
      setPassword('');
      onState(next);
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : 'Unable to unlock the vault.');
    } finally {
      setBusy(false);
    }
  }

  if (!target || showOther) {
    return (
      <section className="lock-screen" aria-label="Open a vault">
        <VaultForm onError={onError} onState={(next, notice) => onState(next, notice)} />
        {target ? (
          <button className="text-button" onClick={() => setShowOther(false)} type="button">
            ← Back to {target.name}
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <section className="lock-screen" aria-label="Unlock TunnelNote">
      <p className="lock-title">{target.name}</p>
      <p className="hint">
        Locked · vaults lock after {idleMinutes} minute{idleMinutes === 1 ? '' : 's'} of inactivity
      </p>
      <form
        className="vault-form lock-form"
        onSubmit={(event) => {
          event.preventDefault();
          void unlock();
        }}
      >
        <label htmlFor="lock-password">Master password</label>
        <input
          autoComplete="current-password"
          autoFocus
          id="lock-password"
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
        <button disabled={busy} type="submit">
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
      <button className="text-button" onClick={() => setShowOther(true)} type="button">
        Open or create another vault
      </button>
      {others > 0 ? (
        <p className="hint">
          {others} other vault{others === 1 ? '' : 's'} can be unlocked from the Vaults tab.
        </p>
      ) : null}
    </section>
  );
}
