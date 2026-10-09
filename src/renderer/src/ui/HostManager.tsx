import { useEffect, useState, type FormEvent } from 'react';
import type { HostOs, SshHostSummary, UpsertSshHostRequest } from '../../../shared/ssh-contract';
import type { VaultsState } from '../../../shared/vault-contract';
import { OS_OPTIONS, OsIcon } from './OsIcon';

interface HostManagerProps {
  enabled: boolean;
  vaults: VaultsState;
  onConnect(host: SshHostSummary): void;
  onHostDeleted(hostId: string): void;
}

type AuthMethod = 'password' | 'privateKey' | 'agent' | 'keyboardInteractive';

export function HostManager({ enabled, vaults, onConnect, onHostDeleted }: HostManagerProps) {
  const [hosts, setHosts] = useState<SshHostSummary[]>([]);
  const [editing, setEditing] = useState<SshHostSummary | null>(null);
  const [name, setName] = useState('');
  const [hostname, setHostname] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [jumpHostId, setJumpHostId] = useState('');
  const [targetVaultId, setTargetVaultId] = useState('');
  const [os, setOs] = useState<HostOs>('linux');
  const [tagsText, setTagsText] = useState('');
  const [group, setGroup] = useState('');
  const [noteHost, setNoteHost] = useState<SshHostSummary | null>(null);
  const [noteText, setNoteText] = useState('');
  const [authMethod, setAuthMethod] = useState<AuthMethod>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlockedVaults = vaults.vaults.filter((entry) => entry.status === 'unlocked');
  const unlockedKey = unlockedVaults.map((entry) => entry.id).join(',');
  const groupNames = [...new Set(hosts.map((host) => host.group).filter(Boolean))] as string[];
  const sections = [...new Set(hosts.map((host) => host.group ?? ''))].sort((a, b) =>
    a === '' ? -1 : b === '' ? 1 : a.localeCompare(b),
  );
  const vaultName = (id?: string) => vaults.vaults.find((entry) => entry.id === id)?.name;

  useEffect(() => {
    let active = true;
    if (!enabled) {
      setHosts([]);
      return () => {
        active = false;
      };
    }
    window.tunnelNote
      .listSshHosts()
      .then((items) => {
        if (active) {
          setHosts(items);
        }
      })
      .catch((requestError: unknown) => {
        if (active) {
          setError(errorMessage(requestError));
        }
      });
    return () => {
      active = false;
    };
  }, [enabled, unlockedKey]);

  function resetForm(): void {
    setEditing(null);
    setName('');
    setHostname('');
    setPort('22');
    setUsername('');
    setJumpHostId('');
    setOs('linux');
    setTagsText('');
    setGroup('');
    setAuthMethod('password');
    setPassword('');
    setPrivateKey('');
    setPassphrase('');
  }

  function editHost(host: SshHostSummary): void {
    setEditing(host);
    setName(host.name);
    setHostname(host.hostname);
    setPort(String(host.port));
    setUsername(host.username);
    setJumpHostId(host.jumpHostId ?? '');
    setOs(host.os ?? 'other');
    setTagsText((host.tags ?? []).join(', '));
    setGroup(host.group ?? '');
    setNoteHost(null);
    setAuthMethod(host.authMethod);
    setPassword('');
    setPrivateKey('');
    setPassphrase('');
    setError(null);
  }

  async function saveHost(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setError('Port must be a number between 1 and 65535.');
      setBusy(false);
      return;
    }
    const request: UpsertSshHostRequest = {
      ...(editing ? { id: editing.id } : {}),
      ...(!editing && (targetVaultId || vaults.activeId)
        ? { vaultId: targetVaultId || (vaults.activeId as string) }
        : {}),
      name,
      hostname,
      port: parsedPort,
      username,
      authMethod,
      ...(jumpHostId ? { jumpHostId } : {}),
      os,
      group: group.trim(),
      tags: tagsText
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      ...(authMethod === 'password' && password ? { password } : {}),
      ...(authMethod === 'privateKey' && privateKey ? { privateKey } : {}),
      ...(authMethod === 'privateKey' && passphrase ? { passphrase } : {}),
    };

    try {
      const saved = await window.tunnelNote.upsertSshHost(request);
      setHosts((current) =>
        editing
          ? current.map((host) => (host.id === saved.id ? saved : host))
          : [...current, saved].sort((left, right) => left.name.localeCompare(right.name)),
      );
      resetForm();
    } catch (requestError: unknown) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  function openNote(host: SshHostSummary): void {
    setNoteHost(host);
    setNoteText(host.notes ?? '');
    setEditing(null);
    setError(null);
  }

  async function saveNote(): Promise<void> {
    if (!noteHost) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await window.tunnelNote.upsertSshHost({
        id: noteHost.id,
        name: noteHost.name,
        hostname: noteHost.hostname,
        port: noteHost.port,
        username: noteHost.username,
        authMethod: noteHost.authMethod,
        ...(noteHost.jumpHostId ? { jumpHostId: noteHost.jumpHostId } : {}),
        ...(noteHost.os ? { os: noteHost.os } : {}),
        tags: noteHost.tags ?? [],
        ...(noteHost.vaultId ? { vaultId: noteHost.vaultId } : {}),
        notes: noteText,
      });
      setHosts((current) => current.map((host) => (host.id === saved.id ? saved : host)));
      setNoteHost(null);
    } catch (requestError: unknown) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function deleteHost(hostId: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await window.tunnelNote.deleteSshHost(hostId);
      setHosts((current) => current.filter((host) => host.id !== hostId));
      onHostDeleted(hostId);
      if (editing?.id === hostId) {
        resetForm();
      }
      setDeleteCandidate(null);
    } catch (requestError: unknown) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="hosts-heading" className="workspace-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Connections</p>
          <h2 id="hosts-heading">SSH hosts</h2>
        </div>
        <span className="hint">Credentials are protected inside the vault.</span>
      </div>

      <div className="host-layout">
        <div className="host-list" aria-label="Saved SSH hosts">
          {hosts.length === 0 ? (
            <p className="hint">No SSH hosts yet. Add one to start a connection.</p>
          ) : (
            sections.map((section) => (
              <div className="host-section" key={section || 'ungrouped'}>
                {sections.length > 1 || section ? (
                  <h3 className="host-group-title">{section || 'Ungrouped'}</h3>
                ) : null}
                {hosts
                  .filter((host) => (host.group ?? '') === section)
                  .map((host) => (
                    <article className="host-card" key={host.id}>
                      <button
                        className="host-card-main"
                        disabled={busy}
                        onClick={() => onConnect(host)}
                        title={`Connect to ${host.name}`}
                        type="button"
                      >
                        <OsIcon os={host.os} />
                        <span className="host-card-copy">
                          <span className="host-card-name">{host.name}</span>
                          {unlockedVaults.length > 1 && vaultName(host.vaultId) ? (
                            <span className="host-vault-label">{vaultName(host.vaultId)}</span>
                          ) : null}
                          <span className="host-tags">
                            {(host.tags ?? []).length > 0 ? (
                              (host.tags ?? []).map((tag) => (
                                <span className="host-tag" key={tag}>
                                  {tag}
                                </span>
                              ))
                            ) : (
                              <span className="host-tag muted">ssh</span>
                            )}
                          </span>
                        </span>
                      </button>
                      <div className="host-card-actions">
                        <button
                          aria-label={`Edit ${host.name}`}
                          className="icon-button"
                          disabled={busy}
                          onClick={() => editHost(host)}
                          title="Edit"
                          type="button"
                        >
                          ✎
                        </button>
                        <button
                          aria-label={`Note for ${host.name}`}
                          className={`icon-button${host.notes ? ' has-note' : ''}`}
                          disabled={busy}
                          onClick={() => openNote(host)}
                          title={host.notes ? 'Edit note' : 'Add note'}
                          type="button"
                        >
                          ☰
                        </button>
                        {deleteCandidate === host.id ? (
                          <>
                            <button
                              className="danger-button"
                              disabled={busy}
                              onClick={() => void deleteHost(host.id)}
                              type="button"
                            >
                              Delete?
                            </button>
                            <button
                              className="icon-button"
                              onClick={() => setDeleteCandidate(null)}
                              title="Cancel"
                              type="button"
                            >
                              ×
                            </button>
                          </>
                        ) : (
                          <button
                            aria-label={`Delete ${host.name}`}
                            className="icon-button icon-danger"
                            disabled={busy}
                            onClick={() => setDeleteCandidate(host.id)}
                            title="Delete"
                            type="button"
                          >
                            🗑
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
              </div>
            ))
          )}
        </div>

        {noteHost ? (
          <div className="host-form">
            <div className="form-heading">
              <h3>Note · {noteHost.name}</h3>
              <button className="text-button" onClick={() => setNoteHost(null)} type="button">
                Cancel
              </button>
            </div>
            <label htmlFor="host-note">Note</label>
            <textarea
              id="host-note"
              maxLength={8000}
              onChange={(event) => setNoteText(event.target.value)}
              rows={10}
              value={noteText}
            />
            <button disabled={busy} onClick={() => void saveNote()} type="button">
              {busy ? 'Saving…' : 'Save note'}
            </button>
          </div>
        ) : (
          <form className="host-form" onSubmit={(event) => void saveHost(event)}>
            <div className="form-heading">
              <h3>{editing ? 'Edit host' : 'Add host'}</h3>
              {editing ? (
                <button className="text-button" onClick={resetForm} type="button">
                  Cancel edit
                </button>
              ) : null}
            </div>
            {!editing && unlockedVaults.length > 1 ? (
              <>
                <label htmlFor="host-vault">Save to vault</label>
                <select
                  id="host-vault"
                  onChange={(event) => setTargetVaultId(event.target.value)}
                  value={targetVaultId || vaults.activeId || ''}
                >
                  {unlockedVaults.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
            <label htmlFor="host-group">Group (optional, use / for subgroups)</label>
            <input
              autoComplete="off"
              id="host-group"
              list="host-group-list"
              maxLength={200}
              onChange={(event) => setGroup(event.target.value)}
              placeholder="Production/Web"
              value={group}
            />
            <datalist id="host-group-list">
              {groupNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <label htmlFor="host-name">Display name</label>
            <input
              autoComplete="off"
              id="host-name"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
            <div className="form-stack">
              <div>
                <label htmlFor="host-os">Operating system</label>
                <select
                  id="host-os"
                  onChange={(event) => setOs(event.target.value as HostOs)}
                  value={os}
                >
                  {OS_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="host-tags">Tags (comma separated)</label>
                <input
                  autoComplete="off"
                  id="host-tags"
                  onChange={(event) => setTagsText(event.target.value)}
                  placeholder="prod, db"
                  value={tagsText}
                />
              </div>
            </div>
            <div className="form-two-column">
              <div>
                <label htmlFor="host-address">Hostname or IP address</label>
                <input
                  autoComplete="off"
                  id="host-address"
                  maxLength={253}
                  onChange={(event) => setHostname(event.target.value)}
                  required
                  value={hostname}
                />
              </div>
              <div>
                <label htmlFor="host-port">Port</label>
                <input
                  id="host-port"
                  inputMode="numeric"
                  max="65535"
                  min="1"
                  onChange={(event) => setPort(event.target.value)}
                  required
                  type="number"
                  value={port}
                />
              </div>
            </div>
            <label htmlFor="host-username">Username</label>
            <input
              autoComplete="username"
              id="host-username"
              maxLength={128}
              onChange={(event) => setUsername(event.target.value)}
              required
              value={username}
            />
            <label htmlFor="host-jump-host">Connect through jump host (optional)</label>
            <select
              id="host-jump-host"
              onChange={(event) => setJumpHostId(event.target.value)}
              value={jumpHostId}
            >
              <option value="">Direct connection</option>
              {hosts
                .filter((host) => host.id !== editing?.id)
                .map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.name}
                  </option>
                ))}
            </select>
            <p className="hint">Jump-host chains may include up to three intermediate hosts.</p>
            <label htmlFor="host-auth">Authentication</label>
            <select
              id="host-auth"
              onChange={(event) => setAuthMethod(event.target.value as AuthMethod)}
              value={authMethod}
            >
              <option value="password">Password</option>
              <option value="privateKey">Private key</option>
              <option value="agent">SSH agent</option>
              <option value="keyboardInteractive">Keyboard-interactive (OTP/TOTP)</option>
            </select>
            {authMethod === 'password' ? (
              <>
                <label htmlFor="host-password">
                  {editing ? 'New password (leave blank to keep saved password)' : 'Password'}
                </label>
                <input
                  autoComplete="new-password"
                  id="host-password"
                  maxLength={4096}
                  onChange={(event) => setPassword(event.target.value)}
                  required={!editing}
                  type="password"
                  value={password}
                />
              </>
            ) : authMethod === 'privateKey' ? (
              <>
                <label htmlFor="host-private-key">
                  {editing ? 'New private key (leave blank to keep saved key)' : 'Private key'}
                </label>
                <textarea
                  autoComplete="off"
                  id="host-private-key"
                  maxLength={128 * 1024}
                  onChange={(event) => setPrivateKey(event.target.value)}
                  required={!editing}
                  rows={5}
                  spellCheck={false}
                  value={privateKey}
                />
                <label htmlFor="host-passphrase">Private-key passphrase (optional)</label>
                <input
                  autoComplete="new-password"
                  id="host-passphrase"
                  maxLength={4096}
                  onChange={(event) => setPassphrase(event.target.value)}
                  type="password"
                  value={passphrase}
                />
              </>
            ) : (
              <p className="hint auth-method-help">
                {authMethod === 'agent'
                  ? 'Uses the system SSH agent configured through SSH_AUTH_SOCK, or Pageant on Windows. TunnelNote does not read or store agent keys.'
                  : 'Uses the SSH server keyboard-interactive challenge. Password, OTP, and TOTP prompts are answered for each connection and are not saved.'}
              </p>
            )}
            <button disabled={busy} type="submit">
              {busy ? 'Saving…' : editing ? 'Save host' : 'Add host'}
            </button>
          </form>
        )}
      </div>
      {error ? (
        <p className="status status-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The SSH host operation failed.';
}
