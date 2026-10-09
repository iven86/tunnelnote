import { app, ipcMain } from 'electron';
import { appInfoSchema, getAppInfoRequestSchema } from '../../shared/app-info';

export function registerAppHandlers(): void {
  ipcMain.handle('app:get-info', (_event, payload: unknown) => {
    getAppInfoRequestSchema.parse(payload);

    return appInfoSchema.parse({
      name: app.getName(),
      version: app.getVersion(),
    });
  });
}
