import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { extname } from 'node:path';
import {
  createVaultRequestSchema,
  emptyVaultRequestSchema,
  openVaultRequestSchema,
  unlockVaultRequestSchema,
  vaultIdRequestSchema,
  vaultsStateSchema,
} from '../../shared/vault-contract';
import type { VaultHub } from '../vault/vault-hub';

export function registerVaultHandlers(vault: VaultHub): void {
  vault.onChange((state) => {
    const safeState = vaultsStateSchema.parse(state);
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('vault:state', safeState);
    }
  });

  ipcMain.handle('vault:get-state', (_event, payload: unknown) => {
    emptyVaultRequestSchema.parse(payload);
    return vaultsStateSchema.parse(vault.getVaultsState());
  });

  ipcMain.handle('vault:create', async (_event, payload: unknown) => {
    const request = createVaultRequestSchema.parse(payload);
    const result = await dialog.showSaveDialog({
      title: 'Create TunnelNote vault',
      defaultPath: 'TunnelNote.kdbx',
      filters: [{ name: 'KeePass database', extensions: ['kdbx'] }],
    });
    if (result.canceled || !result.filePath) {
      return vaultsStateSchema.parse(vault.getVaultsState());
    }
    const path = withKdbxExtension(result.filePath);
    return vaultsStateSchema.parse(await vault.create(path, request.password));
  });

  ipcMain.handle('vault:open', async (_event, payload: unknown) => {
    const request = openVaultRequestSchema.parse(payload);
    const result = await dialog.showOpenDialog({
      title: 'Open TunnelNote vault',
      properties: ['openFile'],
      filters: [{ name: 'KeePass database', extensions: ['kdbx'] }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return vaultsStateSchema.parse(vault.getVaultsState());
    }
    const path = result.filePaths[0];
    if (!path) {
      throw new Error('The file dialog did not return a selected vault.');
    }
    return vaultsStateSchema.parse(await vault.open(path, request.password));
  });

  ipcMain.handle('vault:save', async (_event, payload: unknown) => {
    const request = vaultIdRequestSchema.parse(payload);
    await vault.save(request.id);
    return vaultsStateSchema.parse(vault.getVaultsState());
  });

  ipcMain.handle('vault:lock', (_event, payload: unknown) => {
    const request = vaultIdRequestSchema.parse(payload);
    return vaultsStateSchema.parse(vault.lockVault(request.id));
  });

  ipcMain.handle('vault:unlock', async (_event, payload: unknown) => {
    const request = unlockVaultRequestSchema.parse(payload);
    return vaultsStateSchema.parse(await vault.unlock(request.id, request.password));
  });

  ipcMain.handle('vault:close', (_event, payload: unknown) => {
    const request = vaultIdRequestSchema.parse(payload);
    return vaultsStateSchema.parse(vault.closeVault(request.id));
  });

  ipcMain.handle('vault:set-active', (_event, payload: unknown) => {
    const request = vaultIdRequestSchema.parse(payload);
    return vaultsStateSchema.parse(vault.setActive(request.id));
  });

  ipcMain.on('vault:activity', (_event, payload: unknown) => {
    emptyVaultRequestSchema.parse(payload);
    vault.touchActivity();
  });

  app.on('before-quit', () => vault.lock());
}

function withKdbxExtension(path: string): string {
  return extname(path).toLowerCase() === '.kdbx' ? path : `${path}.kdbx`;
}
