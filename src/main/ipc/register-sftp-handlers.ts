import { BrowserWindow, dialog, ipcMain } from 'electron';
import {
  emptySshRequestSchema,
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
} from '../../shared/ssh-contract';
import type { SftpService } from '../ssh/sftp-service';

export function registerSftpHandlers(service: SftpService): void {
  ipcMain.handle('sftp:choose-local-root', async (event, payload: unknown) => {
    const window = assertTrustedRenderer(event.sender);
    const request = sftpSessionRequestSchema.parse(payload);
    service.assertSessionConnected(request.sessionId);
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
      title: 'Choose a local SFTP folder',
    });
    if (result.canceled || result.filePaths.length !== 1) {
      throw new Error('Local SFTP folder selection was cancelled.');
    }
    return sftpLocalRootResponseSchema.parse(
      await service.registerLocalRoot(request.sessionId, result.filePaths[0]),
    );
  });

  ipcMain.handle('sftp:list-local', async (event, payload: unknown) => {
    assertTrustedRenderer(event.sender);
    const request = sftpLocalListRequestSchema.parse(payload);
    const listing = await service.listLocal(
      request.sessionId,
      request.rootId,
      request.relativePath,
    );
    return sftpDirectoryListingSchema.parse(listing);
  });

  ipcMain.handle('sftp:list-remote', async (event, payload: unknown) => {
    assertTrustedRenderer(event.sender);
    const request = sftpRemoteListRequestSchema.parse(payload);
    return sftpDirectoryListingSchema.parse(
      await service.listRemote(request.sessionId, request.path),
    );
  });

  ipcMain.handle('sftp:transfer-start', (event, payload: unknown) => {
    assertTrustedRenderer(event.sender);
    const request = sftpTransferRequestSchema.parse(payload);
    return sftpTransferStartResponseSchema.parse({ transferId: service.startTransfer(request) });
  });

  ipcMain.handle('sftp:transfer-cancel', (event, payload: unknown) => {
    assertTrustedRenderer(event.sender);
    const request = sftpTransferCancelRequestSchema.parse(payload);
    service.cancelTransfer(request.sessionId, request.transferId);
    return emptySshRequestSchema.parse({});
  });

  ipcMain.handle('sftp:edit-read', async (event, payload: unknown) => {
    assertTrustedRenderer(event.sender);
    const request = sftpEditReadRequestSchema.parse(payload);
    return sftpEditReadResponseSchema.parse(
      await service.readRemoteText(request.sessionId, request.remotePath),
    );
  });

  ipcMain.handle('sftp:edit-write', async (event, payload: unknown) => {
    assertTrustedRenderer(event.sender);
    const request = sftpEditWriteRequestSchema.parse(payload);
    return sftpEditWriteResponseSchema.parse(
      await service.writeRemoteText(
        request.sessionId,
        request.remotePath,
        request.text,
        request.expectedRevision,
      ),
    );
  });
}

export function sendSftpEvent(payload: unknown): void {
  const safeEvent = sftpEventSchema.parse(payload);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('sftp:event', safeEvent);
  }
}

function assertTrustedRenderer(sender: Electron.WebContents): BrowserWindow {
  const window = BrowserWindow.getAllWindows().find(
    (candidate) => candidate.webContents.id === sender.id,
  );
  if (!window) {
    throw new Error('SFTP IPC is only available to TunnelNote application windows.');
  }
  return window;
}
