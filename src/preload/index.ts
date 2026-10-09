import {
  appSettingsSchema,
  openFolderRequestSchema,
  settingsStateSchema,
  type AppSettings,
  type SettingsState,
} from '../shared/settings-contract';
import { contextBridge, ipcRenderer } from 'electron';
import { appInfoSchema, getAppInfoRequestSchema, type AppInfo } from '../shared/app-info';
import {
  createVaultRequestSchema,
  emptyVaultRequestSchema,
  openVaultRequestSchema,
  unlockVaultRequestSchema,
  vaultIdRequestSchema,
  vaultsStateSchema,
  type VaultsState,
} from '../shared/vault-contract';
import {
  approveHostKeyRequestSchema,
  emptySshRequestSchema,
  hostIdRequestSchema,
  keyboardInteractiveReplySchema,
  sshHostSummariesSchema,
  sshHostSummarySchema,
  sshInputRequestSchema,
  sshResizeRequestSchema,
  sshSessionEventSchema,
  sshSessionIdRequestSchema,
  sshSessionStartResponseSchema,
  sftpDirectoryListingSchema,
  sftpEditReadRequestSchema,
  sftpEditReadResponseSchema,
  sftpEditWriteRequestSchema,
  sftpEditWriteResponseSchema,
  sftpEventSchema,
  sftpLocalListRequestSchema,
  sftpLocalRootResponseSchema,
  sftpRemoteListRequestSchema,
  sftpSessionRequestSchema,
  sftpTransferCancelRequestSchema,
  sftpTransferRequestSchema,
  sftpTransferStartResponseSchema,
  startSshRequestSchema,
  upsertSshHostRequestSchema,
  type SshHostSummary,
  type SshSessionEvent,
  type SftpEvent,
  type UpsertSshHostRequest,
} from '../shared/ssh-contract';

import type { ZodType } from 'zod';
import { z } from 'zod';
import {
  connectedSessionsSchema,
  exportRequestSchema,
  forwardRuleInputSchema,
  forwardRuleSchema,
  forwardRulesSchema,
  forwardStartRequestSchema,
  forwardStatusSchema,
  forwardStatusesSchema,
  forwardStopRequestSchema,
  historyQuerySchema,
  historySettingSchema,
  noteCreateFolderSchema,
  noteLocationIdSchema,
  noteLocationsSchema,
  notePathRequestSchema,
  noteSaveRequestSchema,
  noteSchema,
  noteSearchRequestSchema,
  noteSearchResultsSchema,
  noteSummariesSchema,
  runRequestSchema,
  runResultsSchema,
  savedSchema,
  snippetInputSchema,
  snippetSchema,
  snippetsSchema,
  type ForwardRuleInput,
  type NoteSaveRequest,
  type RunRequest,
  type RunResult,
  type SnippetInput,
} from '../shared/workspace-contract';

async function call<I, O>(
  channel: string,
  inputSchema: ZodType<I>,
  outputSchema: ZodType<O>,
  payload: unknown,
): Promise<O> {
  const response: unknown = await ipcRenderer.invoke(channel, inputSchema.parse(payload));
  return outputSchema.parse(response);
}
const none = emptySshRequestSchema;

const tunnelNoteApi = Object.freeze({
  listForwardRules: () => call('forward:list', none, forwardRulesSchema, {}),
  saveForwardRule: (rule: ForwardRuleInput) =>
    call('forward:save', forwardRuleInputSchema, forwardRuleSchema, rule),
  deleteForwardRule: (ruleId: string) =>
    call('forward:delete', forwardStopRequestSchema, none, { ruleId }),
  getForwardStatuses: () => call('forward:status', none, forwardStatusesSchema, {}),
  startForward: (ruleId: string, sessionId: string, confirmPublicBind = false) =>
    call('forward:start', forwardStartRequestSchema, forwardStatusSchema, {
      ruleId,
      sessionId,
      confirmPublicBind,
    }),
  stopForward: (ruleId: string) => call('forward:stop', forwardStopRequestSchema, none, { ruleId }),

  listSnippets: () => call('snippets:list', none, snippetsSchema, {}),
  saveSnippet: (snippet: SnippetInput) =>
    call('snippets:save', snippetInputSchema, snippetSchema, snippet),
  deleteSnippet: (id: string) =>
    call('snippets:delete', z.object({ id: z.string().uuid() }).strict(), none, { id }),
  listConnectedSessions: () => call('runner:sessions', none, connectedSessionsSchema, {}),
  runCommand: (request: RunRequest) =>
    call('runner:run', runRequestSchema, runResultsSchema, request),
  exportResults: (results: RunResult[], format: 'markdown' | 'csv') =>
    call('runner:export', exportRequestSchema, savedSchema, { results, format }),
  setHistoryEnabled: (enabled: boolean) =>
    call('history:set', historySettingSchema, historySettingSchema, { enabled }),
  getHistorySetting: () => call('history:get', none, historySettingSchema, {}),
  searchHistory: (query: string) =>
    call('history:search', historyQuerySchema, runResultsSchema, { query }),

  listNotes: () => call('notes:list', none, noteSummariesSchema, {}),
  readNote: (path: string) => call('notes:read', notePathRequestSchema, noteSchema, { path }),
  saveNote: (request: NoteSaveRequest) =>
    call('notes:save', noteSaveRequestSchema, noteSchema, request),
  deleteNote: (path: string) => call('notes:delete', notePathRequestSchema, none, { path }),
  searchNotes: (query: string) =>
    call('notes:search', noteSearchRequestSchema, noteSearchResultsSchema, { query }),
  listNoteLocations: () => call('notes:locations', none, noteLocationsSchema, {}),
  addNoteLocation: () => call('notes:addLocation', none, noteLocationsSchema, {}),
  removeNoteLocation: (id: string) =>
    call('notes:removeLocation', noteLocationIdSchema, noteLocationsSchema, { id }),
  createNoteFolder: (location: string, name: string) =>
    call('notes:createFolder', noteCreateFolderSchema, noteLocationsSchema, { location, name }),

  async getAppInfo(): Promise<AppInfo> {
    const request = getAppInfoRequestSchema.parse({});
    const response: unknown = await ipcRenderer.invoke('app:get-info', request);
    return appInfoSchema.parse(response);
  },
  async getVaultState(): Promise<VaultsState> {
    const response: unknown = await ipcRenderer.invoke(
      'vault:get-state',
      emptyVaultRequestSchema.parse({}),
    );
    return vaultsStateSchema.parse(response);
  },
  async createVault(password: string): Promise<VaultsState> {
    const request = createVaultRequestSchema.parse({ password });
    const response: unknown = await ipcRenderer.invoke('vault:create', request);
    return vaultsStateSchema.parse(response);
  },
  async openVault(password: string): Promise<VaultsState> {
    const request = openVaultRequestSchema.parse({ password });
    const response: unknown = await ipcRenderer.invoke('vault:open', request);
    return vaultsStateSchema.parse(response);
  },
  async unlockVault(id: string, password: string): Promise<VaultsState> {
    const request = unlockVaultRequestSchema.parse({ id, password });
    const response: unknown = await ipcRenderer.invoke('vault:unlock', request);
    return vaultsStateSchema.parse(response);
  },
  async closeVault(id: string): Promise<VaultsState> {
    const response: unknown = await ipcRenderer.invoke(
      'vault:close',
      vaultIdRequestSchema.parse({ id }),
    );
    return vaultsStateSchema.parse(response);
  },
  async setActiveVault(id: string): Promise<VaultsState> {
    const response: unknown = await ipcRenderer.invoke(
      'vault:set-active',
      vaultIdRequestSchema.parse({ id }),
    );
    return vaultsStateSchema.parse(response);
  },
  async saveVault(id: string): Promise<VaultsState> {
    const response: unknown = await ipcRenderer.invoke(
      'vault:save',
      vaultIdRequestSchema.parse({ id }),
    );
    return vaultsStateSchema.parse(response);
  },
  async lockVault(id: string): Promise<VaultsState> {
    const response: unknown = await ipcRenderer.invoke(
      'vault:lock',
      vaultIdRequestSchema.parse({ id }),
    );
    return vaultsStateSchema.parse(response);
  },
  onVaultState(listener: (state: VaultsState) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      listener(vaultsStateSchema.parse(payload));
    };
    ipcRenderer.on('vault:state', handler);
    return () => ipcRenderer.removeListener('vault:state', handler);
  },
  async listSshHosts(): Promise<SshHostSummary[]> {
    const response: unknown = await ipcRenderer.invoke(
      'ssh:hosts:list',
      emptySshRequestSchema.parse({}),
    );
    return sshHostSummariesSchema.parse(response);
  },
  async upsertSshHost(host: UpsertSshHostRequest): Promise<SshHostSummary> {
    const request = upsertSshHostRequestSchema.parse(host);
    const response: unknown = await ipcRenderer.invoke('ssh:hosts:upsert', request);
    return sshHostSummarySchema.parse(response);
  },
  async deleteSshHost(id: string): Promise<void> {
    const request = hostIdRequestSchema.parse({ id });
    const response: unknown = await ipcRenderer.invoke('ssh:hosts:delete', request);
    emptySshRequestSchema.parse(response);
  },
  async connectSsh(hostId: string, cols: number, rows: number): Promise<string> {
    const request = startSshRequestSchema.parse({ hostId, cols, rows });
    const response: unknown = await ipcRenderer.invoke('ssh:connect', request);
    return sshSessionStartResponseSchema.parse(response).sessionId;
  },
  async sendSshInput(sessionId: string, data: string): Promise<void> {
    const request = sshInputRequestSchema.parse({ sessionId, data });
    const response: unknown = await ipcRenderer.invoke('ssh:input', request);
    emptySshRequestSchema.parse(response);
  },
  async resizeSshTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
    const request = sshResizeRequestSchema.parse({ sessionId, cols, rows });
    const response: unknown = await ipcRenderer.invoke('ssh:resize', request);
    emptySshRequestSchema.parse(response);
  },
  async disconnectSsh(sessionId: string): Promise<void> {
    const request = sshSessionIdRequestSchema.parse({ sessionId });
    const response: unknown = await ipcRenderer.invoke('ssh:disconnect', request);
    emptySshRequestSchema.parse(response);
  },
  async decideSshHostKey(
    sessionId: string,
    decisionId: string,
    approve: boolean,
    replaceExisting: boolean,
  ): Promise<void> {
    const request = approveHostKeyRequestSchema.parse({
      sessionId,
      decisionId,
      approve,
      replaceExisting,
    });
    const response: unknown = await ipcRenderer.invoke('ssh:host-key:decision', request);
    emptySshRequestSchema.parse(response);
  },
  async replySshKeyboardInteractive(
    sessionId: string,
    challengeId: string,
    responses: string[],
  ): Promise<void> {
    const request = keyboardInteractiveReplySchema.parse({
      sessionId,
      challengeId,
      responses,
    });
    const response: unknown = await ipcRenderer.invoke('ssh:keyboard-interactive:reply', request);
    emptySshRequestSchema.parse(response);
  },
  onSshEvent(listener: (event: SshSessionEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      listener(sshSessionEventSchema.parse(payload));
    };
    ipcRenderer.on('ssh:event', handler);
    return () => ipcRenderer.removeListener('ssh:event', handler);
  },
  async chooseSftpLocalRoot(sessionId: string): Promise<{ rootId: string; displayName: string }> {
    const request = sftpSessionRequestSchema.parse({ sessionId });
    const response: unknown = await ipcRenderer.invoke('sftp:choose-local-root', request);
    return sftpLocalRootResponseSchema.parse(response);
  },
  async listSftpLocal(
    sessionId: string,
    rootId: string,
    relativePath: string,
  ): Promise<ReturnType<typeof sftpDirectoryListingSchema.parse>> {
    const request = sftpLocalListRequestSchema.parse({ sessionId, rootId, relativePath });
    const response: unknown = await ipcRenderer.invoke('sftp:list-local', request);
    return sftpDirectoryListingSchema.parse(response);
  },
  async listSftpRemote(
    sessionId: string,
    path: string,
  ): Promise<ReturnType<typeof sftpDirectoryListingSchema.parse>> {
    const request = sftpRemoteListRequestSchema.parse({ sessionId, path });
    const response: unknown = await ipcRenderer.invoke('sftp:list-remote', request);
    return sftpDirectoryListingSchema.parse(response);
  },
  async startSftpTransfer(
    requestValue: Parameters<typeof sftpTransferRequestSchema.parse>[0],
  ): Promise<string> {
    const request = sftpTransferRequestSchema.parse(requestValue);
    const response: unknown = await ipcRenderer.invoke('sftp:transfer-start', request);
    return sftpTransferStartResponseSchema.parse(response).transferId;
  },
  async cancelSftpTransfer(sessionId: string, transferId: string): Promise<void> {
    const request = sftpTransferCancelRequestSchema.parse({ sessionId, transferId });
    const response: unknown = await ipcRenderer.invoke('sftp:transfer-cancel', request);
    emptySshRequestSchema.parse(response);
  },
  async readSftpRemoteText(
    sessionId: string,
    remotePath: string,
  ): Promise<ReturnType<typeof sftpEditReadResponseSchema.parse>> {
    const request = sftpEditReadRequestSchema.parse({ sessionId, remotePath });
    const response: unknown = await ipcRenderer.invoke('sftp:edit-read', request);
    return sftpEditReadResponseSchema.parse(response);
  },
  async writeSftpRemoteText(
    sessionId: string,
    remotePath: string,
    text: string,
    expectedRevision: string,
  ): Promise<ReturnType<typeof sftpEditWriteResponseSchema.parse>> {
    const request = sftpEditWriteRequestSchema.parse({
      sessionId,
      remotePath,
      text,
      expectedRevision,
    });
    const response: unknown = await ipcRenderer.invoke('sftp:edit-write', request);
    return sftpEditWriteResponseSchema.parse(response);
  },
  async getSettings(): Promise<SettingsState> {
    return settingsStateSchema.parse(await ipcRenderer.invoke('settings:get'));
  },
  async updateSettings(settings: AppSettings): Promise<SettingsState> {
    const request = appSettingsSchema.parse(settings);
    return settingsStateSchema.parse(await ipcRenderer.invoke('settings:update', request));
  },
  async chooseFolder(): Promise<{ selected: boolean; path?: string }> {
    const response: unknown = await ipcRenderer.invoke('settings:choose-folder');
    return z
      .union([
        z.object({ selected: z.literal(true), path: z.string() }),
        z.object({ selected: z.literal(false) }),
      ])
      .parse(response);
  },
  async openFolder(kind: 'data' | 'logs'): Promise<void> {
    await ipcRenderer.invoke('settings:open-folder', openFolderRequestSchema.parse({ kind }));
  },
  onSftpEvent(listener: (event: SftpEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      listener(sftpEventSchema.parse(payload));
    };
    ipcRenderer.on('sftp:event', handler);
    return () => ipcRenderer.removeListener('sftp:event', handler);
  },
});

contextBridge.exposeInMainWorld('tunnelNote', tunnelNoteApi);

export type TunnelNoteApi = typeof tunnelNoteApi;

let lastActivityAt = 0;
const reportActivity = (): void => {
  const now = Date.now();
  if (now - lastActivityAt >= 30_000) {
    lastActivityAt = now;
    ipcRenderer.send('vault:activity', emptyVaultRequestSchema.parse({}));
  }
};

window.addEventListener('pointerdown', reportActivity, { passive: true });
window.addEventListener('keydown', reportActivity);
