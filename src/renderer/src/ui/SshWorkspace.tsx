import { useRef, useState } from 'react';
import type { SshHostSummary } from '../../../shared/ssh-contract';
import { HostManager } from './HostManager';
import { SshTerminal } from './SshTerminal';
import { NotesPanel } from './tools/NotesPanel';
import { SnippetsPanel } from './tools/SnippetsPanel';
import { TunnelsPanel } from './tools/TunnelsPanel';
import { TabIcon, type TabIconName } from './TabIcon';
import { SettingsPanel } from './SettingsPanel';
import { VaultsPanel } from './VaultsPanel';
import type { VaultsState } from '../../../shared/vault-contract';

type ToolView = 'vaults' | 'settings' | 'tunnels' | 'snippets' | 'notes';
const TOOLS: [ToolView, string][] = [
  ['vaults', 'Vaults'],
  ['tunnels', 'Tunnels'],
  ['snippets', 'Snippets'],
  ['notes', 'Notes'],
  ['settings', 'Settings'],
];

const NAV: [TabIconName & (ToolView | 'hosts'), string][] = [
  ['vaults', 'Vaults'],
  ['hosts', 'Hosts'],
  ['tunnels', 'Tunnels'],
  ['snippets', 'Snippets'],
  ['notes', 'Notes'],
  ['settings', 'Settings'],
];

interface SshWorkspaceProps {
  enabled: boolean;
  vaults: VaultsState;
  onVaultState(state: VaultsState, message?: string): void;
  onError(message: string | null): void;
}

interface WorkspaceTab {
  id: string;
  host: SshHostSummary;
}

export function SshWorkspace({ enabled, vaults, onVaultState, onError }: SshWorkspaceProps) {
  const nextTabId = useRef(0);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [splitView, setSplitView] = useState(false);
  const [splitTabId, setSplitTabId] = useState<string | null>(null);
  const [view, setView] = useState<'hosts' | 'session' | ToolView>('hosts');

  function openHost(host: SshHostSummary): void {
    const id = `ssh-tab-${++nextTabId.current}`;
    setTabs((current) => [...current, { id, host }]);
    setActiveTabId(id);
    setView('session');
  }

  function closeTab(tabId: string): void {
    const closedIndex = tabs.findIndex((tab) => tab.id === tabId);
    const remaining = tabs.filter((tab) => tab.id !== tabId);
    setTabs(remaining);
    const nextActiveTabId =
      activeTabId === tabId
        ? (remaining[Math.min(closedIndex, remaining.length - 1)]?.id ?? null)
        : activeTabId;
    setActiveTabId(nextActiveTabId);
    if (remaining.length === 0) {
      setView('hosts');
    }
    if (
      splitTabId === tabId ||
      splitTabId === nextActiveTabId ||
      !remaining.some((tab) => tab.id === splitTabId)
    ) {
      setSplitTabId(remaining.find((tab) => tab.id !== nextActiveTabId)?.id ?? null);
    }
  }

  function removeHostTabs(hostId: string): void {
    const remaining = tabs.filter((tab) => tab.host.id !== hostId);
    setTabs(remaining);
    const nextActiveTabId = remaining.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : (remaining[0]?.id ?? null);
    setActiveTabId(nextActiveTabId);
    if (!remaining.some((tab) => tab.id === splitTabId) || splitTabId === nextActiveTabId) {
      setSplitTabId(remaining.find((tab) => tab.id !== nextActiveTabId)?.id ?? null);
    }
  }

  function activateTab(tabId: string): void {
    setActiveTabId(tabId);
    setView('session');
    if (splitTabId === tabId) {
      setSplitTabId(tabs.find((tab) => tab.id !== tabId)?.id ?? null);
    }
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  const showSessions = view === 'session' && tabs.length > 0;
  const tool = TOOLS.some(([key]) => key === view) ? (view as ToolView) : null;

  return (
    <div className="ssh-workspace">
      <div className="session-toolbar">
        <div aria-label="Open SSH sessions" className="session-tabs" role="tablist">
          {NAV.map(([key, label]) => (
            <button
              aria-selected={view === key}
              className={view === key ? 'session-tab-button selected' : 'session-tab-button'}
              key={key}
              onClick={() => setView(key)}
              role="tab"
              type="button"
            >
              <TabIcon name={key} />
              {label}
            </button>
          ))}
        </div>
        {showSessions && tabs.length > 1 ? (
          <div className="button-row split-controls">
            <button
              aria-pressed={splitView}
              className={splitView ? 'secondary-button split-selected' : 'secondary-button'}
              onClick={() => {
                const next = !splitView;
                setSplitView(next);
                if (next && !tabs.some((tab) => tab.id === splitTabId && tab.id !== activeTabId)) {
                  setSplitTabId(tabs.find((tab) => tab.id !== activeTabId)?.id ?? null);
                }
              }}
              type="button"
            >
              {splitView ? 'Exit split' : 'Split view'}
            </button>
            {splitView ? (
              <label className="split-session-picker">
                <span className="sr-only">Second pane session</span>
                <select
                  onChange={(event) => setSplitTabId(event.target.value)}
                  value={splitTabId ?? ''}
                >
                  {tabs
                    .filter((tab) => tab.id !== activeTabId)
                    .map((tab) => (
                      <option key={tab.id} value={tab.id}>
                        {tab.host.name}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="workspace-main">
        {tabs.length > 0 ? (
          <aside aria-label="Connected hosts" className="conn-sidebar">
            <p className="conn-title">Connected</p>
            {tabs.map((tab) => (
              <div
                className={
                  showSessions && tab.id === activeTabId ? 'conn-item selected' : 'conn-item'
                }
                key={tab.id}
              >
                <button
                  className="conn-item-main"
                  onClick={() => activateTab(tab.id)}
                  title={tab.host.name}
                  type="button"
                >
                  <TabIcon name="terminal" />
                  <span className="conn-item-name">{tab.host.name}</span>
                </button>
                <button
                  aria-label={`Close ${tab.host.name} session`}
                  className="session-tab-close"
                  onClick={() => closeTab(tab.id)}
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </aside>
        ) : null}
        <div className="workspace-body">
          <div className="hosts-view" hidden={view !== 'hosts'}>
            <HostManager
              enabled={enabled}
              vaults={vaults}
              onConnect={openHost}
              onHostDeleted={removeHostTabs}
            />
          </div>
          {tool ? (
            <div className="hosts-view">
              {tool === 'vaults' ? (
                <VaultsPanel onError={onError} onState={onVaultState} vaults={vaults} />
              ) : null}
              {tool === 'tunnels' ? <TunnelsPanel /> : null}
              {tool === 'snippets' ? <SnippetsPanel /> : null}
              {tool === 'notes' ? <NotesPanel /> : null}
              {tool === 'settings' ? <SettingsPanel onState={() => undefined} /> : null}
            </div>
          ) : null}
          <div
            className={splitView ? 'terminal-grid split-view' : 'terminal-grid'}
            hidden={!showSessions}
          >
            {tabs.map((tab) => {
              const visible = splitView
                ? tab.id === activeTabId || tab.id === splitTabId
                : tab.id === activeTabId;
              return <SshTerminal hidden={!visible} host={tab.host} key={tab.id} />;
            })}
          </div>
        </div>
      </div>
      {activeTab ? (
        <span className="sr-only" aria-live="polite">
          Active session: {activeTab.host.name}
        </span>
      ) : null}
    </div>
  );
}
