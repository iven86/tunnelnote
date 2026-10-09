import { app, BrowserWindow } from 'electron';
import { createMainWindow, configureWindowSecurity } from './create-window';
import { registerAppHandlers } from './ipc/register-app-handlers';
import { registerSshHandlers, sendSshSessionEvent } from './ipc/register-ssh-handlers';
import { registerSftpHandlers, sendSftpEvent } from './ipc/register-sftp-handlers';
import { registerWorkspaceHandlers } from './ipc/register-workspace-handlers';
import { registerVaultHandlers } from './ipc/register-vault-handlers';
import { join } from 'node:path';
import { forwardRulesSchema, snippetsSchema } from '../shared/workspace-contract';
import { JsonStore } from './storage/json-store';
import { ForwardingService } from './ssh/forwarding-service';
import { CommandHistory } from './workspace/command-history';
import { NotesService, noteLocationRegistrySchema } from './workspace/notes-service';
import { SftpService } from './ssh/sftp-service';
import { SshSessionManager } from './ssh/ssh-session-manager';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { registerSettingsHandlers } from './ipc/register-settings-handlers';
import { SettingsService } from './settings/settings-service';
import { SessionLogger } from './ssh/session-logger';
import { VaultHub } from './vault/vault-hub';

// Electron segfaults on some Wayland compositors; X11/XWayland is stable.
if (process.platform === 'linux' && !process.env.TUNNELNOTE_USE_WAYLAND) {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

// Some Linux drivers fail VA-API/GPU init and spam the console; the UI renders fine in software.
if (process.platform === 'linux' && !process.env.TUNNELNOTE_ENABLE_GPU) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-features', 'VaapiVideoDecoder,VaapiVideoEncoder');
  app.commandLine.appendSwitch('disable-logging');
}

// Chromium prints harmless GPU/VSync errors on some Linux setups; keep only fatal logs.
app.commandLine.appendSwitch('log-level', '3');

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

const vaultRegistrySchema = z
  .object({
    paths: z.array(z.string().min(1).max(1024)).max(16),
    defaultPath: z.string().nullable(),
  })
  .strict();

const settings = new SettingsService(app.getPath('userData'));
const vault = new VaultHub();
vault.setIdleLockMs(settings.get().idleLockMinutes * 60_000);
settings.onChange((next) => vault.setIdleLockMs(next.idleLockMinutes * 60_000));
const vaultRegistry = new JsonStore(
  join(app.getPath('userData'), 'vaults.json'),
  vaultRegistrySchema,
  () => ({ paths: [], defaultPath: null }),
);
const sessionLogger = new SessionLogger(settings.get.bind(settings), () =>
  settings.logsDirectory(),
);
const sshSessions = new SshSessionManager(vault, sendSshSessionEvent, sessionLogger);
const sftpService = new SftpService(sshSessions, sendSftpEvent);

const dataDir = (): string => settings.dataDirectory();
const forwarding = new ForwardingService(
  sshSessions,
  new JsonStore(join(dataDir(), 'forward-rules.json'), forwardRulesSchema, () => []),
);
vault.onVaultLocked((_vaultId, hostIds) => sshSessions.disconnectHosts(hostIds));

const lockOnMinimize = (): void => {
  if (settings.get().lockOnMinimize) {
    vault.lock();
  }
};

app.on('before-quit', () => {
  sessionLogger.closeAll();
  forwarding.stopAll();
});

app.whenReady().then(async () => {
  try {
    const remembered = await vaultRegistry
      .read()
      .catch(() => ({ paths: [] as string[], defaultPath: null }));
    vault.restore(
      remembered.paths.filter((path) => existsSync(path)),
      remembered.defaultPath,
    );
    let lastSaved = JSON.stringify(vault.getPersistable());
    vault.onChange(() => {
      const snapshot = vault.getPersistable();
      const serialized = JSON.stringify(snapshot);
      if (serialized !== lastSaved) {
        lastSaved = serialized;
        void vaultRegistry.write(snapshot).catch((error) => {
          console.error('Failed to remember vault list:', error);
        });
      }
    });
    registerWorkspaceHandlers({
      sessions: sshSessions,
      forwarding,
      snippets: new JsonStore(join(dataDir(), 'snippets.json'), snippetsSchema, () => []),
      history: new CommandHistory(),
      notes: new NotesService(
        join(dataDir(), 'notes'),
        new JsonStore(join(dataDir(), 'note-locations.json'), noteLocationRegistrySchema, () => ({
          paths: [],
        })),
      ),
    });
    configureWindowSecurity();
    registerAppHandlers();
    registerSettingsHandlers(settings);
    registerVaultHandlers(vault);
    registerSshHandlers(vault, sshSessions);
    registerSftpHandlers(sftpService);
    const mainWindow = await createMainWindow();
    mainWindow.on('minimize', lockOnMinimize);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow()
          .then((window) => {
            window.on('minimize', lockOnMinimize);
          })
          .catch((error) => {
            console.error('Failed to create main window:', error);
          });
      }
    });
  } catch (error) {
    console.error('Failed to initialize app:', error);
    process.exit(1);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
