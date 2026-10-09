import { app, BrowserWindow, session } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { installContentSecurityPolicy } from './security/content-security-policy';

// Packaged apps get their icon from electron-builder (build/icon.png).
const devIconPath = join(__dirname, '../../build/icon.png');

export function configureWindowSecurity(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  installContentSecurityPolicy();

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (navigationEvent) => navigationEvent.preventDefault());
  });
}

export async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
    ...(!app.isPackaged && existsSync(devIconPath) ? { icon: devIconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  if (process.platform !== 'darwin') {
    window.removeMenu();
  }

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    await window.loadURL(rendererUrl);
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}
