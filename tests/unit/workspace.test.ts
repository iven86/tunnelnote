import { createServer, createConnection } from 'node:net';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonStore } from '../../src/main/storage/json-store';
import { forwardRulesSchema, forwardRuleInputSchema } from '../../src/shared/workspace-contract';
import { ForwardingService, isLoopbackBind } from '../../src/main/ssh/forwarding-service';
import { renderSnippet, resultsToCsv, templateVariables } from '../../src/main/ssh/snippet-runner';
import { negotiateSocks5 } from '../../src/main/ssh/socks5';
import {
  NotesService,
  findSecretWarnings,
  noteLocationRegistrySchema,
} from '../../src/main/workspace/notes-service';
import { CommandHistory } from '../../src/main/workspace/command-history';

const HOST = '11111111-1111-4111-8111-111111111111';
const run = {
  sessionId: HOST,
  hostName: 'h',
  command: 'ls',
  exitCode: 0,
  timedOut: false,
  output: '=cmd()',
  durationMs: 1,
  startedAt: 'x',
};

describe('snippets', () => {
  it('renders variables with shell quoting', () => {
    expect(
      renderSnippet('echo {{host}} {{prompt:x}}', { host: 'a.b', user: 'u' }, { x: "it's; rm" }),
    ).toBe("echo a.b 'it'\\''s; rm'");
    expect(() => renderSnippet('{{prompt:y}}', { host: 'h', user: 'u' }, {})).toThrow();
    expect(templateVariables('{{prompt:a}} {{prompt:a}} {{prompt:b}}')).toEqual(['a', 'b']);
  });
  it('guards CSV formulas', () => {
    expect(resultsToCsv([run])).toContain(`"'=cmd()"`);
  });
  it('history is opt-in', () => {
    const history = new CommandHistory();
    history.record([run]);
    expect(history.search('')).toHaveLength(0);
    history.setEnabled(true);
    history.record([run]);
    expect(history.search('LS')).toHaveLength(1);
    history.setEnabled(false);
    expect(history.search('')).toHaveLength(0);
  });
});

describe('forwarding', () => {
  it('validates rules and loopback detection', () => {
    expect(
      forwardRuleInputSchema.safeParse({ hostId: HOST, label: 'x', type: 'local', bindPort: 1 })
        .success,
    ).toBe(false);
    expect(isLoopbackBind('127.0.0.1')).toBe(true);
    expect(isLoopbackBind('0.0.0.0')).toBe(false);
  });

  it('requires confirmation for public binds and forwards local traffic', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tn-fwd-'));
    try {
      const store = new JsonStore(join(dir, 'r.json'), forwardRulesSchema, () => []);
      const echo = createServer((s) => s.pipe(s));
      await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
      const fakeClient = {
        forwardOut: (
          _a: string,
          _b: number,
          host: string,
          port: number,
          cb: (e: Error | undefined, c: unknown) => void,
        ) => {
          const upstream = createConnection({ host, port });
          upstream.once('connect', () => cb(undefined, upstream));
        },
      };
      const service = new ForwardingService(
        {
          getTransport: () => fakeClient as never,
          getSessionHostId: () => HOST,
          onSessionClosed: () => () => undefined,
        },
        store,
      );
      const address = echo.address() as { port: number };
      const pub = await service.save({
        hostId: HOST,
        label: 'p',
        type: 'local',
        bindHost: '0.0.0.0',
        bindPort: 0,
        destHost: '127.0.0.1',
        destPort: address.port,
      });
      await expect(service.start(pub.id, HOST, false)).rejects.toThrow(/Confirm the public bind/);
      const rule = await service.save({
        hostId: HOST,
        label: 'l',
        type: 'local',
        bindHost: '127.0.0.1',
        bindPort: 0,
        destHost: '127.0.0.1',
        destPort: address.port,
      });
      const status = await service.start(rule.id, HOST, false);
      const reply = await new Promise<string>((resolve) => {
        const c = createConnection({ host: '127.0.0.1', port: status.boundPort ?? 0 }, () =>
          c.write('ping'),
        );
        c.on('data', (d) => {
          resolve(d.toString());
          c.destroy();
        });
      });
      expect(reply).toBe('ping');
      service.stopAll();
      echo.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parses a SOCKS5 CONNECT request', async () => {
    const server = createServer((socket) => {
      void negotiateSocks5(socket).then((t) => {
        socket.end(JSON.stringify(t));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const out = await new Promise<string>((resolve) => {
      const c = createConnection({ port, host: '127.0.0.1' }, () => {
        c.write(Buffer.from([5, 1, 0]));
        c.write(Buffer.from([5, 1, 0, 3, 3, 0x61, 0x2e, 0x62, 0, 80]));
      });
      let text = '';
      c.on('data', (d) => {
        text += d.toString('latin1');
      });
      c.on('close', () => resolve(text.slice(text.indexOf('{'))));
    });
    expect(JSON.parse(out)).toEqual({ host: 'a.b', port: 80 });
    server.close();
  });
});

describe('notes', () => {
  it('adds .md itself, supports folders and locations, and rejects traversal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tn-notes-'));
    const extra = await mkdtemp(join(tmpdir(), 'tn-notes-extra-'));
    try {
      const registry = new JsonStore(join(dir, 'loc.json'), noteLocationRegistrySchema, () => ({
        paths: [],
      }));
      const notes = new NotesService(join(dir, 'notes'), registry);
      const host = { server: 'PI', address: '192.0.2.11', tags: ['Lab', 'pi'] };
      const a = await notes.save({
        location: 'default',
        folder: '',
        name: 'Alpha',
        body: '# Alpha\nSee [[Beta]] deploy steps',
        host,
      });
      expect(a.path).toBe('default/Alpha.md');
      expect(a.host).toEqual(host);
      const raw = await readFile(join(dir, 'notes', 'Alpha.md'), 'utf8');
      expect(raw).toContain('server: PI\naddress: 192.0.2.11\ntags: [Lab, pi]');
      expect(raw).not.toContain('hostId');

      await notes.createFolder('default', 'ops/db');
      const b = await notes.save({
        location: 'default',
        folder: 'ops/db',
        name: 'Beta.md',
        body: '# Beta',
      });
      expect(b.path).toBe('default/ops/db/Beta.md');
      expect((await notes.read(b.path)).backlinks).toEqual(['default/Alpha.md']);
      expect((await notes.search('deploy'))[0]?.path).toBe('default/Alpha.md');
      expect((await notes.search('192.0.2'))[0]?.path).toBe('default/Alpha.md');

      const moved = await notes.save({
        location: 'default',
        folder: 'ops',
        name: 'Beta2',
        body: '# Beta',
        previousPath: b.path,
      });
      expect(moved.path).toBe('default/ops/Beta2.md');
      expect((await notes.list()).map((n) => n.path)).not.toContain(b.path);
      await expect(
        notes.save({ location: 'default', folder: '', name: 'Alpha', body: 'x' }),
      ).rejects.toThrow(/already exists/);

      await expect(
        notes.save({ location: 'default', folder: '..', name: 'x', body: 'x' }),
      ).rejects.toThrow();
      await expect(
        notes.save({ location: 'default', folder: '', name: '../x', body: 'x' }),
      ).rejects.toThrow();
      await expect(
        notes.save({ location: 'nope', folder: '', name: 'x', body: 'x' }),
      ).rejects.toThrow();
      await expect(notes.read('default/../x.md')).rejects.toThrow();

      const locations = await notes.addLocation(extra);
      const added = locations.find((l) => !l.builtin);
      expect(added?.available).toBe(true);
      await notes.save({ location: added?.id ?? '', folder: '', name: 'Outside', body: 'hi' });
      const reopened = new NotesService(join(dir, 'notes'), registry);
      expect((await reopened.locations()).filter((l) => !l.builtin)).toHaveLength(1);
      expect((await reopened.list()).map((n) => n.name)).toContain('Outside');
      await reopened.removeLocation(added?.id ?? '');
      expect((await reopened.list()).map((n) => n.name)).not.toContain('Outside');
      await expect(reopened.removeLocation('default')).rejects.toThrow();

      await writeFile(join(dir, 'notes', 'real.md'), 'r');
      await symlink(join(dir, 'notes', 'real.md'), join(dir, 'notes', 'link.md'));
      expect(
        (await new NotesService(join(dir, 'notes'), registry).list()).map((n) => n.name),
      ).not.toContain('link');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(extra, { recursive: true, force: true });
    }
  });
  it('detects secrets', () => {
    expect(findSecretWarnings('-----BEGIN OPENSSH PRIVATE KEY-----')).toHaveLength(1);
    expect(findSecretWarnings('password = hunter2hunter2')).toHaveLength(1);
    expect(findSecretWarnings('plain text')).toHaveLength(0);
  });
});

describe('json store', () => {
  it('store rejects invalid data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tn-store-'));
    try {
      await writeFile(join(dir, 'x.json'), '{bad');
      await expect(
        new JsonStore(join(dir, 'x.json'), z.array(z.string()), () => []).read(),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
