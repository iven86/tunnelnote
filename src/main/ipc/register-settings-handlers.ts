import { dialog, ipcMain, shell } from 'electron';
import { mkdir } from 'node:fs/promises';
import {
  openFolderRequestSchema,
  settingsStateSchema,
  type SettingsState,
} from '../../shared/settings-contract';
import type { SettingsService } from '../settings/settings-service';

export function registerSettingsHandlers(settings: SettingsService): void {
  ipcMain.handle('settings:get', (): SettingsState => settingsStateSchema.parse(settings.state()));

  ipcMain.handle('settings:update', async (_event, payload: unknown) =>
    settingsStateSchema.parse(await settings.update(payload)),
  );

  ipcMain.handle('settings:choose-folder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    const path = result.canceled ? undefined : result.filePaths[0];
    return path ? { selected: true as const, path } : { selected: false as const };
  });

  ipcMain.handle('settings:open-folder', async (_event, payload: unknown) => {
    const { kind } = openFolderRequestSchema.parse(payload);
    const path = kind === 'data' ? settings.dataDirectory() : settings.logsDirectory();
    await mkdir(path, { recursive: true });
    const failure = await shell.openPath(path);
    if (failure) {
      throw new Error('Unable to open the folder.');
    }
    return { opened: true };
  });
}
