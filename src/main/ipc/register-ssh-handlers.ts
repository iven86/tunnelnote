import { BrowserWindow, ipcMain } from 'electron';
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
  startSshRequestSchema,
  upsertSshHostRequestSchema,
} from '../../shared/ssh-contract';
import type { VaultHub } from '../vault/vault-hub';
import type { SshSessionManager } from '../ssh/ssh-session-manager';

export function registerSshHandlers(vault: VaultHub, sessions: SshSessionManager): void {
  ipcMain.handle('ssh:hosts:list', (event, payload: unknown) => {
    assertTrustedRenderer(event.sender);
    emptySshRequestSchema.parse(payload);
    return sshHostSummariesSchema.parse(vault.listSshHosts());
  });

  ipcMain.handle('ssh:hosts:upsert', async (event, payload: unknown) => {
    assertTrustedRenderer(event.sender);
    const request = upsertSshHostRequestSchema.parse(payload);
    return sshHostSummarySchema.parse(await vault.upsertSshHost(request));
  });

  ipcMain.handle('ssh:hosts:delete', async (event, payload: unknown) => {
    assertTrustedRenderer(event.sender);
    const request = hostIdRequestSchema.parse(payload);
    await vault.deleteSshHost(request.id);
    return emptySshRequestSchema.parse({});
  });

  ipcMain.handle('ssh:connect', (event, payload: unknown) => {
    assertTrustedRenderer(event.sender);
    const request = startSshRequestSchema.parse(payload);
    return sshSessionStartResponseSchema.parse({
      sessionId: sessions.start(request.hostId, request.cols, request.rows),
    });
  });

  ipcMain.handle('ssh:input', (event, payload: unknown) => {
    assertTrustedRenderer(event.sender);
    const request = sshInputRequestSchema.parse(payload);
    sessions.write(request.sessionId, request.data);
    return emptySshRequestSchema.parse({});
  });

  ipcMain.handle('ssh:resize', (event, payload: unknown) => {
    assertTrustedRenderer(event.sender);
    const request = sshResizeRequestSchema.parse(payload);
    sessions.resize(request.sessionId, request.cols, request.rows);
    return emptySshRequestSchema.parse({});
  });

  ipcMain.handle('ssh:disconnect', (event, payload: unknown) => {
    assertTrustedRenderer(event.sender);
    const request = sshSessionIdRequestSchema.parse(payload);
    sessions.disconnect(request.sessionId);
    return emptySshRequestSchema.parse({});
  });

  ipcMain.handle('ssh:host-key:decision', async (event, payload: unknown) => {
    assertTrustedRenderer(event.sender);
    const request = approveHostKeyRequestSchema.parse(payload);
    await sessions.approveHostKey(
      request.sessionId,
      request.decisionId,
      request.approve,
      request.replaceExisting,
    );
    return emptySshRequestSchema.parse({});
  });

  ipcMain.handle('ssh:keyboard-interactive:reply', (event, payload: unknown) => {
    assertTrustedRenderer(event.sender);
    const request = keyboardInteractiveReplySchema.parse(payload);
    sessions.answerKeyboardInteractive(request.sessionId, request.challengeId, request.responses);
    return emptySshRequestSchema.parse({});
  });
}

export function sendSshSessionEvent(payload: unknown): void {
  const safeEvent = sshSessionEventSchema.parse(payload);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('ssh:event', safeEvent);
  }
}

function assertTrustedRenderer(sender: Electron.WebContents): void {
  const trusted = BrowserWindow.getAllWindows().some(
    (window) => window.webContents.id === sender.id,
  );
  if (!trusted) {
    throw new Error('SSH IPC is only available to TunnelNote application windows.');
  }
}
