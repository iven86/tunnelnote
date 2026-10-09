import { useState, type FormEvent } from 'react';
import type { VaultsState } from '../../../shared/vault-contract';

interface VaultFormProps {
  onState(state: VaultsState, message: string): void;
  onError(message: string | null): void;
  title?: string;
}

type VaultMode = 'create' | 'open';

export function VaultForm({ onState, onError, title = 'Encrypted vault' }: VaultFormProps) {
  const [mode, setMode] = useState<VaultMode>('open');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    onError(null);
    if (mode === 'create' && password !== confirmation) {
      onError('The passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const next =
        mode === 'create'
          ? await window.tunnelNote.createVault(password)
          : await window.tunnelNote.openVault(password);
      setPassword('');
      setConfirmation('');
      onState(next, `Vault ${mode === 'create' ? 'created' : 'opened'} successfully.`);
    } catch (error: unknown) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="vault-panel" aria-label={title}>
      <h2>{title}</h2>
      <div aria-label="Vault action" className="mode-switch" role="group">
        {(['open', 'create'] as const).map((value) => (
          <button
            aria-pressed={mode === value}
            className={mode === value ? 'mode-button selected' : 'mode-button'}
            disabled={busy}
            key={value}
            onClick={() => {
              setMode(value);
              setPassword('');
              setConfirmation('');
              onError(null);
            }}
            type="button"
          >
            {value === 'open' ? 'Open existing' : 'Create new'}
          </button>
        ))}
      </div>
      <form className="vault-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor={`pw-${title}`}>Master password</label>
        <input
          autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
          id={`pw-${title}`}
          maxLength={1024}
          minLength={mode === 'create' ? 12 : 1}
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
        {mode === 'create' ? (
          <>
            <label htmlFor={`pw2-${title}`}>Confirm master password</label>
            <input
              autoComplete="new-password"
              id={`pw2-${title}`}
              maxLength={1024}
              minLength={12}
              onChange={(event) => setConfirmation(event.target.value)}
              required
              type="password"
              value={confirmation}
            />
          </>
        ) : null}
        <button disabled={busy} type="submit">
          {busy ? 'Please wait…' : mode === 'create' ? 'Create vault' : 'Open vault'}
        </button>
      </form>
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The vault operation failed.';
}
