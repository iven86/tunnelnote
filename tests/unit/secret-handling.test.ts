import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  copySecretToClipboard,
  type ClipboardPort,
} from '../../src/main/security/clipboard-secret';
import { redactSecrets, securityLogger } from '../../src/main/security/redacting-logger';

describe('secret handling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('redacts assigned secrets, private keys, and AWS access keys', () => {
    const redacted = redactSecrets(
      'password="a long phrase" token: bearer-value key=AKIA1234567890ABCDEF\n' +
        '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-material\n-----END OPENSSH PRIVATE KEY-----',
    );

    expect(redacted).not.toContain('a long phrase');
    expect(redacted).not.toContain('bearer-value');
    expect(redacted).not.toContain('AKIA1234567890ABCDEF');
    expect(redacted).not.toContain('secret-material');
    expect(redacted).toContain('[REDACTED PRIVATE KEY]');
  });

  it('routes logger output through redaction', () => {
    const write = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    securityLogger.error('unlock failed for password=logger-test-secret');
    expect(write).toHaveBeenCalledWith('unlock failed for password=[REDACTED]');
    expect(JSON.stringify(write.mock.calls)).not.toContain('logger-test-secret');
    write.mockRestore();
  });

  it('clears a clipboard secret after the timeout only if it is unchanged', async () => {
    vi.useFakeTimers();
    let value = '';
    const clipboard: ClipboardPort = {
      readText: async () => value,
      writeText: async (next) => {
        value = next;
      },
    };

    await copySecretToClipboard('copied-secret', clipboard, 20_000);
    expect(value).toBe('copied-secret');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(value).toBe('');

    await copySecretToClipboard('copied-secret', clipboard, 20_000);
    await clipboard.writeText('user replacement');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(value).toBe('user replacement');
  });
});
