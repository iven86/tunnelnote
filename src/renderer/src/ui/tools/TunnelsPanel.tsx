import { useCallback, useEffect, useState } from 'react';
import type { SshHostSummary } from '../../../../shared/ssh-contract';
import type { ForwardRule, ForwardStatus } from '../../../../shared/workspace-contract';
import { useAction } from './useAsync';

type Connected = Awaited<ReturnType<typeof window.tunnelNote.listConnectedSessions>>;

export function TunnelsPanel() {
  const [hosts, setHosts] = useState<SshHostSummary[]>([]);
  const [rules, setRules] = useState<ForwardRule[]>([]);
  const [statuses, setStatuses] = useState<ForwardStatus[]>([]);
  const [sessions, setSessions] = useState<Connected>([]);
  const [form, setForm] = useState({
    hostId: '',
    label: '',
    type: 'local' as ForwardRule['type'],
    bindHost: '127.0.0.1',
    bindPort: '8080',
    destHost: '127.0.0.1',
    destPort: '80',
  });
  const { error, busy, run } = useAction();

  const refresh = useCallback(async () => {
    const [h, r, s, c] = await Promise.all([
      window.tunnelNote.listSshHosts(),
      window.tunnelNote.listForwardRules(),
      window.tunnelNote.getForwardStatuses(),
      window.tunnelNote.listConnectedSessions(),
    ]);
    setHosts(h);
    setRules(r);
    setStatuses(s);
    setSessions(c);
  }, []);

  useEffect(() => {
    void run(refresh);
  }, [refresh, run]);

  async function save(): Promise<void> {
    await run(async () => {
      await window.tunnelNote.saveForwardRule({
        hostId: form.hostId || hosts[0]?.id || '',
        label: form.label || `${form.type} ${form.bindPort}`,
        type: form.type,
        bindHost: form.bindHost,
        bindPort: Number(form.bindPort),
        destHost: form.type === 'dynamic' ? undefined : form.destHost,
        destPort: form.type === 'dynamic' ? undefined : Number(form.destPort),
      });
      await refresh();
    });
  }

  async function start(rule: ForwardRule): Promise<void> {
    const session = sessions.find((s) => s.hostId === rule.hostId);
    if (!session) {
      await run(() => Promise.reject(new Error('Connect to this rule’s host first.')));
      return;
    }
    const isPublic = !['127.0.0.1', '::1', 'localhost'].includes(rule.bindHost);
    if (
      isPublic &&
      !window.confirm(
        `Bind to ${rule.bindHost}? Other machines on your network will be able to use this tunnel.`,
      )
    ) {
      return;
    }
    await run(async () => {
      await window.tunnelNote.startForward(rule.id, session.sessionId, isPublic);
      await refresh();
    });
  }

  return (
    <section className="tool-panel" aria-label="Port forwarding">
      <h2>Tunnels</h2>
      <p className="hint">
        Local (-L), remote (-R) and dynamic SOCKS5 (-D) forwarding. Rules bind to 127.0.0.1 by
        default and start on a connected session of the same host.
      </p>
      <form
        className="tool-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <select
          aria-label="Host"
          value={form.hostId}
          onChange={(e) => setForm({ ...form, hostId: e.target.value })}
        >
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Type"
          value={form.type}
          onChange={(e) => setForm({ ...form, type: e.target.value as ForwardRule['type'] })}
        >
          <option value="local">Local (-L)</option>
          <option value="remote">Remote (-R)</option>
          <option value="dynamic">Dynamic SOCKS5 (-D)</option>
        </select>
        <input
          aria-label="Label"
          placeholder="Label"
          value={form.label}
          onChange={(e) => setForm({ ...form, label: e.target.value })}
        />
        <input
          aria-label="Bind address"
          value={form.bindHost}
          onChange={(e) => setForm({ ...form, bindHost: e.target.value })}
        />
        <input
          aria-label="Bind port"
          inputMode="numeric"
          value={form.bindPort}
          onChange={(e) => setForm({ ...form, bindPort: e.target.value })}
        />
        {form.type !== 'dynamic' ? (
          <>
            <input
              aria-label="Destination host"
              value={form.destHost}
              onChange={(e) => setForm({ ...form, destHost: e.target.value })}
            />
            <input
              aria-label="Destination port"
              inputMode="numeric"
              value={form.destPort}
              onChange={(e) => setForm({ ...form, destPort: e.target.value })}
            />
          </>
        ) : null}
        <button disabled={busy || hosts.length === 0} type="submit">
          Save rule
        </button>
      </form>
      {error ? (
        <p className="status status-error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="tool-list">
        {rules.map((rule) => {
          const status = statuses.find((s) => s.ruleId === rule.id);
          const hostName = hosts.find((h) => h.id === rule.hostId)?.name ?? 'unknown host';
          return (
            <li key={rule.id}>
              <span>
                <strong>{rule.label}</strong> · {hostName} · {rule.type} {rule.bindHost}:
                {rule.bindPort}
                {rule.destHost ? ` → ${rule.destHost}:${rule.destPort}` : ''}
                {status?.state === 'running' ? ` · running on :${status.boundPort}` : ''}
              </span>
              <span className="button-row">
                {status?.state === 'running' ? (
                  <button
                    className="secondary-button"
                    onClick={() =>
                      void run(async () => {
                        await window.tunnelNote.stopForward(rule.id);
                        await refresh();
                      })
                    }
                    type="button"
                  >
                    Stop
                  </button>
                ) : (
                  <button disabled={busy} onClick={() => void start(rule)} type="button">
                    Start
                  </button>
                )}
                <button
                  className="danger-button"
                  onClick={() =>
                    void run(async () => {
                      await window.tunnelNote.deleteForwardRule(rule.id);
                      await refresh();
                    })
                  }
                  type="button"
                >
                  Delete
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
