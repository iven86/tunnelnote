import { clipboard } from 'electron';
import { securityLogger } from './redacting-logger';

const DEFAULT_CLEAR_DELAY_MS = 20_000;

export interface ClipboardPort {
  readText(): Promise<string>;
  writeText(value: string): Promise<void>;
}

export async function copySecretToClipboard(
  secret: string,
  clipboardPort: ClipboardPort = clipboard,
  clearDelayMs = DEFAULT_CLEAR_DELAY_MS,
): Promise<ReturnType<typeof setTimeout>> {
  await clipboardPort.writeText(secret);

  return setTimeout(() => {
    void clearIfUnchanged(clipboardPort, secret).catch(() => {
      securityLogger.warn('Unable to clear the clipboard after the secret-copy timeout.');
    });
  }, clearDelayMs);
}

async function clearIfUnchanged(clipboardPort: ClipboardPort, secret: string): Promise<void> {
  if ((await clipboardPort.readText()) === secret) {
    await clipboardPort.writeText('');
  }
}
