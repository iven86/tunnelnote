import { useCallback, useEffect, useState } from 'react';
import type { RunResult, Snippet } from '../../../../shared/workspace-contract';
import { useAction } from './useAsync';

type Connected = Awaited<ReturnType<typeof window.tunnelNote.listConnectedSessions>>;

function variableNames(command: string): string[] {
  return [
    ...new Set(
      [...command.matchAll(/\{\{\s*prompt:([A-Za-z_][\w-]{0,63})\s*\}\}/g)].map((m) => m[1] ?? ''),
    ),
  ];
}

export function SnippetsPanel() {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [sessions, setSessions] = useState<Connected>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [command, setCommand] = useState('uname -a');
  const [timeout, setTimeoutSeconds] = useState('30');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [results, setResults] = useState<RunResult[]>([]);
  const [history, setHistory] = useState<RunResult[]>([]);
  const [historyOn, setHistoryOn] = useState(false);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const { error, busy, run } = useAction();

  const refresh = useCallback(async () => {
    const [s, c, h] = await Promise.all([
      window.tunnelNote.listSnippets(),
      window.tunnelNote.listConnectedSessions(),
      window.tunnelNote.getHistorySetting(),
    ]);
    setSnippets(s);
    setSessions(c);
    setHistoryOn(h.enabled);
  }, []);

  useEffect(() => {
    void run(refresh);
  }, [refresh, run]);

  const names = variableNames(command);

  return (
    <section className="tool-panel" aria-label="Snippets and runner">
      <h2>Snippets & multi-host runner</h2>
      <p className="hint">
        Use {'{{host}}'}, {'{{user}}'} and {'{{prompt:name}}'}. Values are shell-quoted. Commands
        run on sessions you have already connected.
      </p>
      <div className="tool-form">
        <input
          aria-label="Snippet name"
          placeholder="Name (to save)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          aria-label="Command"
          rows={3}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <input
          aria-label="Timeout seconds"
          inputMode="numeric"
          value={timeout}
          onChange={(e) => setTimeoutSeconds(e.target.value)}
        />
        <button
          className="secondary-button"
          disabled={busy || !name}
          onClick={() =>
            void run(async () => {
              await window.tunnelNote.saveSnippet({
                name,
                command,
                timeoutSeconds: Number(timeout) || 30,
              });
              await refresh();
            })
          }
          type="button"
        >
          Save snippet
        </button>
      </div>
      {names.map((n) => (
        <label className="tool-inline" key={n}>
          {n}
          <input
            value={variables[n] ?? ''}
            onChange={(e) => setVariables({ ...variables, [n]: e.target.value })}
          />
        </label>
      ))}
      <ul className="tool-list">
        {snippets.map((s) => (
          <li key={s.id}>
            <span>
              <strong>{s.name}</strong> <code>{s.command}</code>
            </span>
            <span className="button-row">
              <button
                className="secondary-button"
                onClick={() => {
                  setCommand(s.command);
                  setTimeoutSeconds(String(s.timeoutSeconds));
                  setName(s.name);
                }}
                type="button"
              >
                Load
              </button>
              <button
                className="danger-button"
                onClick={() =>
                  void run(async () => {
                    await window.tunnelNote.deleteSnippet(s.id);
                    await refresh();
                  })
                }
                type="button"
              >
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
      <h3>Run on</h3>
      {sessions.length === 0 ? (
        <p className="hint">No connected sessions. Connect to a host first.</p>
      ) : null}
      {sessions.map((s) => (
        <label className="tool-inline" key={s.sessionId}>
          <input
            checked={selected.has(s.sessionId)}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(s.sessionId);
              else next.delete(s.sessionId);
              setSelected(next);
            }}
            type="checkbox"
          />
          {s.hostName}
        </label>
      ))}
      <label className="tool-inline">
        <input
          checked={historyOn}
          onChange={(e) =>
            void run(async () =>
              setHistoryOn((await window.tunnelNote.setHistoryEnabled(e.target.checked)).enabled),
            )
          }
          type="checkbox"
        />
        Keep command history (memory only, cleared when disabled or on quit)
      </label>
      <div className="button-row">
        <button
          disabled={busy || selected.size === 0}
          onClick={() =>
            void run(async () => {
              setResults(
                await window.tunnelNote.runCommand({
                  command,
                  variables,
                  sessionIds: [...selected],
                  timeoutSeconds: Number(timeout) || 30,
                  recordHistory: historyOn,
                }),
              );
            })
          }
          type="button"
        >
          {busy ? 'Running…' : `Run on ${selected.size} host(s)`}
        </button>
        {results.length > 0 ? (
          <>
            <button
              className="secondary-button"
              onClick={() =>
                void run(async () =>
                  setNotice(
                    (await window.tunnelNote.exportResults(results, 'markdown')).saved
                      ? 'Saved.'
                      : null,
                  ),
                )
              }
              type="button"
            >
              Export Markdown
            </button>
            <button
              className="secondary-button"
              onClick={() =>
                void run(async () =>
                  setNotice(
                    (await window.tunnelNote.exportResults(results, 'csv')).saved ? 'Saved.' : null,
                  ),
                )
              }
              type="button"
            >
              Export CSV
            </button>
          </>
        ) : null}
      </div>
      {notice ? (
        <p className="status" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="status status-error" role="alert">
          {error}
        </p>
      ) : null}
      {results.length > 0 ? (
        <table className="results-table">
          <thead>
            <tr>
              <th>Host</th>
              <th>Exit</th>
              <th>Time</th>
              <th>Output</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.sessionId}>
                <td>{r.hostName}</td>
                <td>{r.timedOut ? 'timeout' : (r.exitCode ?? r.error ?? '—')}</td>
                <td>{r.durationMs} ms</td>
                <td>
                  <pre>{r.output}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {historyOn ? (
        <>
          <h3>History</h3>
          <input
            aria-label="Search history"
            placeholder="Search history"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              void run(async () =>
                setHistory(await window.tunnelNote.searchHistory(e.target.value)),
              );
            }}
          />
          <ul className="tool-list">
            {history.map((h, index) => (
              <li key={`${h.startedAt}-${index}`}>
                <span>
                  <strong>{h.hostName}</strong> <code>{h.command}</code> → {h.exitCode ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
