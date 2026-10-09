import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/settings-contract';
import { LineModel, SessionLogger, sanitizeFileName } from '../../src/main/ssh/session-logger';

let dir: string;
const settings = (mode: 'perSession' | 'single', enabled = true): AppSettings => ({
  ...DEFAULT_SETTINGS,
  sessionLogging: { ...DEFAULT_SETTINGS.sessionLogging, enabled, mode },
});
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 100));

describe('SessionLogger', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(process.cwd(), 'tests/.session-logs-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes one file per session named server-date-time', async () => {
    const fixed = new Date(2026, 9, 8, 11, 5, 9);
    const logger = new SessionLogger(
      () => settings('perSession'),
      () => join(dir, 'a'),
      () => fixed,
    );
    logger.begin('abcd-1', 'web/prod 1');
    logger.write('abcd-1', '\u001b[32mhello\u001b[0m\r\nworld');
    logger.end('abcd-1');
    await settle();
    const files = await readdir(join(dir, 'a'));
    expect(files).toEqual(['web_prod_1-2026-10-08-110509-abcd.log']);
    const text = await readFile(join(dir, 'a', files[0] as string), 'utf8');
    expect(text).toContain('hello\nworld');
    expect(text).not.toContain('\u001b');
  });

  it('merges sessions into one prefixed file and honours the enabled flag', async () => {
    const logger = new SessionLogger(
      () => settings('single'),
      () => join(dir, 'b'),
    );
    logger.begin('s1', 'alpha');
    logger.begin('s2', 'beta');
    logger.write('s1', 'one\ntw');
    logger.write('s2', 'x\n');
    logger.write('s1', 'o\n');
    logger.end('s1');
    logger.end('s2');
    await settle();
    expect(await readdir(join(dir, 'b'))).toEqual(['tunnelnote-sessions.log']);
    const text = await readFile(join(dir, 'b', 'tunnelnote-sessions.log'), 'utf8');
    expect(text).toContain('[alpha] one\n');
    expect(text).toContain('[alpha] two\n');
    expect(text).toContain('[beta] x\n');

    const off = new SessionLogger(
      () => settings('single', false),
      () => join(dir, 'c'),
    );
    off.begin('s3', 'gamma');
    off.write('s3', 'nope');
    off.end('s3');
    await expect(readdir(join(dir, 'c'))).rejects.toThrow();
  });

  it('starts logging for a session that was already open when logging is switched on', async () => {
    let enabled = false;
    const logger = new SessionLogger(
      () => settings('perSession', enabled),
      () => join(dir, 'd'),
    );
    logger.begin('live-1', 'pi');
    logger.write('live-1', 'before\n');
    enabled = true;
    logger.write('live-1', 'after\n');
    logger.end('live-1');
    await settle();
    const [file] = await readdir(join(dir, 'd'));
    const text = await readFile(join(dir, 'd', file as string), 'utf8');
    expect(text).toContain('after');
    expect(text).not.toContain('before');
  });

  it('rebuilds readable lines from shell redraws', () => {
    const model = new LineModel();
    const lines = model.feed(
      '$ \u001b[?2004h\u001b[1mls\u001b[0m\b\b\u001b[Kecho hi\r\n\u001b]0;title\u0007hi\r\n',
    );
    expect(lines).toEqual(['$ echo hi', 'hi']);
  });

  it('sanitizes file names', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('etc_passwd');
  });
});
