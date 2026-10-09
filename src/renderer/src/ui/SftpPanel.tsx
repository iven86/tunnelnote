import { useEffect, useState } from 'react';
import type { SftpDirectoryEntry, SftpTransferEvent } from '../../../shared/ssh-contract';

interface SftpPanelProps {
  sessionId: string;
  hidden: boolean;
}

interface Listing {
  path: string;
  entries: SftpDirectoryEntry[];
}

export function SftpPanel({ sessionId, hidden }: SftpPanelProps) {
  const [root, setRoot] = useState<{ rootId: string; displayName: string } | null>(null);
  const [local, setLocal] = useState<Listing | null>(null);
  const [remote, setRemote] = useState<Listing | null>(null);
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const [remoteSelection, setRemoteSelection] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [resume, setResume] = useState(false);
  const [transfers, setTransfers] = useState<SftpTransferEvent[]>([]);
  const [edit, setEdit] = useState<{
    remotePath: string;
    text: string;
    revision: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRoot(null);
    setLocal(null);
    setRemote(null);
    setLocalSelection(null);
    setRemoteSelection(null);
    setTransfers([]);
    setEdit(null);
    setError(null);
    setStatus(null);
  }, [sessionId]);

  useEffect(
    () =>
      window.tunnelNote.onSftpEvent((event) => {
        if (event.sessionId !== sessionId) {
          return;
        }
        setTransfers((current) => [
          event,
          ...current.filter((item) => item.transferId !== event.transferId),
        ]);
      }),
    [sessionId],
  );

  async function selectLocalRoot(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const selected = await window.tunnelNote.chooseSftpLocalRoot(sessionId);
      setRoot(selected);
      setLocalSelection(null);
      setLocal(await window.tunnelNote.listSftpLocal(sessionId, selected.rootId, ''));
    } catch (requestError: unknown) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function refreshRemote(path = remote?.path ?? '.'): Promise<void> {
    setError(null);
    try {
      setRemote(await window.tunnelNote.listSftpRemote(sessionId, path));
      setRemoteSelection(null);
    } catch (requestError: unknown) {
      setError(errorMessage(requestError));
    }
  }

  async function openLocalDirectory(path: string): Promise<void> {
    if (!root) {
      return;
    }
    setError(null);
    try {
      setLocal(await window.tunnelNote.listSftpLocal(sessionId, root.rootId, path));
      setLocalSelection(null);
    } catch (requestError: unknown) {
      setError(errorMessage(requestError));
    }
  }

  async function transfer(direction: 'upload' | 'download'): Promise<void> {
    if (!root) {
      return;
    }
    const name = direction === 'upload' ? localSelection : remoteSelection;
    if (!name) {
      setError(`Select a regular ${direction === 'upload' ? 'local' : 'remote'} file first.`);
      return;
    }
    const localPath = joinRelative(local?.path ?? '', direction === 'upload' ? name : name);
    const remotePath = joinRemote(remote?.path ?? '.', direction === 'upload' ? name : name);
    setError(null);
    setStatus(null);
    try {
      await window.tunnelNote.startSftpTransfer({
        sessionId,
        rootId: root.rootId,
        direction,
        localPath,
        remotePath,
        overwrite,
        resume,
      });
      setStatus(`${direction === 'upload' ? 'Upload' : 'Download'} queued.`);
    } catch (requestError: unknown) {
      setError(errorMessage(requestError));
    }
  }

  async function openEditor(): Promise<void> {
    if (!remote || !remoteSelection) {
      return;
    }
    setError(null);
    setStatus(null);
    try {
      setEdit(
        await window.tunnelNote.readSftpRemoteText(
          sessionId,
          joinRemote(remote.path, remoteSelection),
        ),
      );
    } catch (requestError: unknown) {
      setError(errorMessage(requestError));
    }
  }

  async function saveEdit(): Promise<void> {
    if (!edit) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await window.tunnelNote.writeSftpRemoteText(
        sessionId,
        edit.remotePath,
        edit.text,
        edit.revision,
      );
      setEdit({ ...edit, revision: saved.revision });
      setStatus('Remote file saved.');
    } catch (requestError: unknown) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function cancelTransfer(transferId: string): Promise<void> {
    setError(null);
    try {
      await window.tunnelNote.cancelSftpTransfer(sessionId, transferId);
    } catch (requestError: unknown) {
      setError(errorMessage(requestError));
    }
  }

  const localLocation = local?.path ? `${root?.displayName}/${local.path}` : root?.displayName;

  return (
    <section aria-label="SFTP file browser" className="sftp-panel" hidden={hidden}>
      <div className="sftp-header">
        <div>
          <p className="eyebrow">SFTP</p>
          <h3>File transfer</h3>
        </div>
        <div className="button-row">
          <button disabled={busy} onClick={() => void selectLocalRoot()} type="button">
            {root ? 'Change local folder' : 'Choose local folder'}
          </button>
          <button
            className="secondary-button"
            onClick={() => void refreshRemote(remote?.path ?? '.')}
            type="button"
          >
            {remote ? 'Refresh remote' : 'Open remote'}
          </button>
        </div>
      </div>

      <div className="sftp-columns">
        <DirectoryBrowser
          entries={local?.entries ?? []}
          onBack={() => void openLocalDirectory(parentRelative(local?.path ?? ''))}
          onOpen={(entry) => {
            if (entry.type === 'directory') {
              void openLocalDirectory(joinRelative(local?.path ?? '', entry.name));
            } else if (entry.type === 'file') {
              setLocalSelection(entry.name);
            }
          }}
          path={localLocation ?? 'Choose a folder'}
          selected={localSelection}
          title="Local"
        />
        <DirectoryBrowser
          entries={remote?.entries ?? []}
          onBack={() => void refreshRemote(parentRemote(remote?.path ?? '.'))}
          onOpen={(entry) => {
            if (entry.type === 'directory') {
              void refreshRemote(joinRemote(remote?.path ?? '.', entry.name));
            } else if (entry.type === 'file') {
              setRemoteSelection(entry.name);
            }
          }}
          path={remote?.path ?? 'Open remote to browse'}
          selected={remoteSelection}
          title="Remote"
        />
      </div>

      <div className="sftp-controls">
        <button
          disabled={!localSelection || !remote}
          onClick={() => void transfer('upload')}
          type="button"
        >
          Upload selected local file
        </button>
        <button
          className="secondary-button"
          disabled={!remoteSelection || !root}
          onClick={() => void transfer('download')}
          type="button"
        >
          Download selected remote file
        </button>
        <button
          className="secondary-button"
          disabled={!remoteSelection}
          onClick={() => void openEditor()}
          type="button"
        >
          Edit remote text file
        </button>
        <label className="sftp-option">
          <input
            checked={overwrite}
            onChange={(event) => setOverwrite(event.target.checked)}
            type="checkbox"
          />
          Replace existing destination
        </label>
        <label className="sftp-option">
          <input
            checked={resume}
            onChange={(event) => setResume(event.target.checked)}
            type="checkbox"
          />
          Resume matching partial transfer
        </label>
      </div>

      {edit ? (
        <div className="sftp-editor">
          <label htmlFor="sftp-remote-editor">Editing {edit.remotePath}</label>
          <textarea
            id="sftp-remote-editor"
            maxLength={1_048_576}
            onChange={(event) => setEdit({ ...edit, text: event.target.value })}
            spellCheck={false}
            value={edit.text}
          />
          <div className="button-row">
            <button disabled={busy} onClick={() => void saveEdit()} type="button">
              Save and sync
            </button>
            <button className="secondary-button" onClick={() => setEdit(null)} type="button">
              Close editor
            </button>
          </div>
        </div>
      ) : null}

      {transfers.length > 0 ? (
        <div className="sftp-transfers" aria-label="SFTP transfers">
          <h3>Transfers</h3>
          {transfers.slice(0, 20).map((item) => (
            <div className="sftp-transfer" key={item.transferId}>
              <span>{item.direction}</span>
              <progress
                max={item.totalBytes || 1}
                value={item.totalBytes ? Math.min(item.transferredBytes, item.totalBytes) : 0}
              />
              <span>
                {item.status}
                {item.totalBytes
                  ? ` · ${Math.round((item.transferredBytes / item.totalBytes) * 100)}%`
                  : ''}
              </span>
              {item.status === 'queued' || item.status === 'transferring' ? (
                <button
                  className="secondary-button"
                  onClick={() => void cancelTransfer(item.transferId)}
                  type="button"
                >
                  Cancel
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {status ? (
        <p className="status" role="status">
          {status}
        </p>
      ) : null}
      {error ? (
        <p className="status status-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function DirectoryBrowser({
  title,
  path,
  entries,
  selected,
  onBack,
  onOpen,
}: {
  title: string;
  path: string;
  entries: SftpDirectoryEntry[];
  selected: string | null;
  onBack: () => void;
  onOpen: (entry: SftpDirectoryEntry) => void;
}) {
  return (
    <div className="sftp-browser">
      <h4>{title}</h4>
      <div className="sftp-path" title={path}>
        {path}
      </div>
      <button className="sftp-parent" onClick={onBack} type="button">
        Parent folder
      </button>
      <ul>
        {entries.map((entry) => (
          <li key={entry.name}>
            <button
              aria-pressed={selected === entry.name}
              className={selected === entry.name ? 'selected' : ''}
              disabled={entry.type !== 'directory' && entry.type !== 'file'}
              onClick={() => onOpen(entry)}
              title={`${entry.type} · ${entry.size} bytes`}
              type="button"
            >
              <span>{entry.type === 'directory' ? '📁' : entry.type === 'file' ? '📄' : '🔒'}</span>
              <span>{entry.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function joinRelative(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function parentRelative(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

function joinRemote(parent: string, child: string): string {
  return parent === '/' ? `/${child}` : `${parent.replace(/\/+$/, '')}/${child}`;
}

function parentRemote(path: string): string {
  if (path === '/' || path === '.') {
    return path;
  }
  const separator = path.lastIndexOf('/');
  if (separator < 0) {
    return '.';
  }
  return separator === 0 ? '/' : path.slice(0, separator);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The SFTP operation failed.';
}
