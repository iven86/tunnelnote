import { Consts, Credentials, CryptoEngine, Int64, Kdbx, ProtectedValue } from 'kdbxweb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  configureArgon2Provider,
  UnsupportedKdfParametersError,
} from '../../src/main/vault/argon2-provider';
import { VaultService, VaultUnlockError } from '../../src/main/vault/vault-service';

const masterPassword = 'test-only-strong-master-passphrase';
let testDirectory: string;
let vaultPath: string;

describe('VaultService', () => {
  beforeAll(async () => {
    testDirectory = await mkdtemp(join(process.cwd(), 'tests/.vault-service-'));
    vaultPath = join(testDirectory, 'service-test.kdbx');
  }, 120_000);

  afterAll(async () => {
    await rm(testDirectory, { recursive: true, force: true });
  });

  it('creates, opens, saves, and locks a KDBX vault', async () => {
    const service = new VaultService(60_000);
    const created = await service.create(vaultPath, masterPassword);
    expect(created).toEqual({
      status: 'unlocked',
      name: 'service-test.kdbx',
    });

    const bytes = await readFile(vaultPath);
    expect(bytes.byteLength).toBeGreaterThan(100);
    expect(bytes.includes(Buffer.from(masterPassword))).toBe(false);

    configureArgon2Provider();
    const credentials = new Credentials(ProtectedValue.fromString(masterPassword));
    await credentials.ready;
    const savedCopy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(savedCopy).set(bytes);
    const database = await Kdbx.load(savedCopy, credentials);
    expect(database.versionMajor).toBe(4);
    const parameters = database.header.kdfParameters;
    expect(parameters?.get('$UUID')).toBeInstanceOf(ArrayBuffer);
    const kdfId = parameters?.get('$UUID');
    if (!(kdfId instanceof ArrayBuffer)) {
      throw new Error('The vault has no KDF identifier.');
    }
    expect(Buffer.from(kdfId).toString('base64')).toBe(Consts.KdfId.Argon2id);
    expect(parameters?.get('P')).toBe(2);
    const memory = parameters?.get('M');
    const iterations = parameters?.get('I');
    expect(memory).toBeInstanceOf(Int64);
    expect(iterations).toBeInstanceOf(Int64);
    if (!(memory instanceof Int64) || !(iterations instanceof Int64)) {
      throw new Error('The vault has incomplete Argon2id settings.');
    }
    expect(memory.value).toBeGreaterThanOrEqual(256 * 1024 * 1024);
    expect(iterations.value).toBeGreaterThanOrEqual(3);
    credentials.passwordHash?.value.fill(0);
    credentials.passwordHash?.salt.fill(0);

    await service.save();
    service.lock();
    expect(service.getState().status).toBe('locked');

    const reopenedService = new VaultService(60_000);
    const reopened = await reopenedService.open(vaultPath, masterPassword);
    expect(reopened.status).toBe('unlocked');
    reopenedService.lock();
  }, 120_000);

  it('rejects a wrong password without disclosing KDBX internals', async () => {
    const service = new VaultService(60_000);
    await expect(service.open(vaultPath, 'incorrect-test-password')).rejects.toBeInstanceOf(
      VaultUnlockError,
    );
    expect(service.getState().status).toBe('locked');
  }, 120_000);

  it('persists SSH hosts and trusted fingerprints without exposing saved credentials', async () => {
    const service = new VaultService(60_000);
    await service.open(vaultPath, masterPassword);

    const host = await service.upsertSshHost({
      name: 'Test server',
      hostname: 'example.test',
      port: 2222,
      username: 'test-user',
      authMethod: 'password',
      password: 'test-only-ssh-password',
      os: 'ubuntu',
      tags: ['prod', 'db', 'prod'],
    });
    expect(host.os).toBe('ubuntu');
    expect(host.tags).toEqual(['prod', 'db']);
    expect(service.listSshHosts()).toEqual([host]);
    expect(service.getSshHostCredentials(host.id)).toMatchObject({
      ...host,
      password: 'test-only-ssh-password',
    });
    expect(service.listSshHosts()[0]).not.toHaveProperty('password');

    await service.upsertSshHost({ ...host, authMethod: 'password' });
    await service.upsertSshHost({
      ...host,
      authMethod: 'password',
      password: 'updated-test-only-password',
    });
    const fingerprint = `SHA256:${'A'.repeat(43)}`;
    await service.trustHostKey('example.test', 2222, fingerprint, false);
    expect(service.getKnownHostFingerprint('EXAMPLE.TEST', 2222)).toBe(fingerprint);

    const encryptedVault = await readFile(vaultPath);
    expect(encryptedVault.includes(Buffer.from('updated-test-only-password'))).toBe(false);

    service.lock();
    const reopened = new VaultService(60_000);
    await reopened.open(vaultPath, masterPassword);
    expect(reopened.getSshHostCredentials(host.id).password).toBe('updated-test-only-password');
    expect(reopened.getKnownHostFingerprint('example.test', 2222)).toBe(fingerprint);
    await reopened.deleteSshHost(host.id);
    expect(reopened.listSshHosts()).toEqual([]);
    reopened.lock();
  }, 120_000);

  it('stores agent and keyboard-interactive hosts and rejects jump-host cycles', async () => {
    const service = new VaultService(60_000);
    await service.open(vaultPath, masterPassword);

    const jumpHost = await service.upsertSshHost({
      name: 'Jump server',
      hostname: 'jump.example.test',
      port: 22,
      username: 'jump-user',
      authMethod: 'agent',
    });
    const target = await service.upsertSshHost({
      name: 'Private target',
      hostname: 'target.internal',
      port: 22,
      username: 'target-user',
      authMethod: 'keyboardInteractive',
      jumpHostId: jumpHost.id,
    });
    expect(service.listSshHosts()).toEqual([jumpHost, target]);
    expect(service.getSshHostCredentials(jumpHost.id)).toEqual(jumpHost);
    await expect(
      service.upsertSshHost({
        ...jumpHost,
        authMethod: 'agent',
        jumpHostId: target.id,
      }),
    ).rejects.toThrow('cycle');
    await expect(service.deleteSshHost(jumpHost.id)).rejects.toThrow('jump host');
    expect(service.listSshHosts()).toEqual([jumpHost, target]);
    service.lock();
  }, 120_000);

  it('stores address in URL, notes in Notes and hosts in groups, readable after reopen', async () => {
    const path = join(testDirectory, 'fields-test.kdbx');
    const service = new VaultService(60_000);
    await service.create(path, masterPassword);
    const host = await service.upsertSshHost({
      name: 'Web',
      hostname: '10.0.0.5',
      port: 22,
      username: 'root',
      authMethod: 'password',
      password: 'secret-pass',
      group: 'Production/Web',
      tags: ['prod'],
    });
    expect(host.group).toBe('Production/Web');
    const withNote = await service.upsertSshHost({
      id: host.id,
      name: 'Web',
      hostname: '10.0.0.5',
      port: 22,
      username: 'root',
      authMethod: 'password',
      notes: 'rack 4',
    });
    expect(withNote.notes).toBe('rack 4');
    expect(withNote.group).toBe('Production/Web');
    expect(withNote.tags).toEqual(['prod']);
    const cleared = await service.upsertSshHost({ ...withNote, group: '', notes: '' });
    expect(cleared.group).toBeUndefined();
    expect(cleared.notes).toBeUndefined();
    await service.upsertSshHost({ ...withNote, group: 'Lab' });
    await service.save();
    service.lock();

    const bytes = await readFile(path);
    configureArgon2Provider();
    const credentials = new Credentials(ProtectedValue.fromString(masterPassword));
    await credentials.ready;
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    const database = await Kdbx.load(copy, credentials);
    const entry = [...database.getDefaultGroup().allEntries()].find(
      (candidate) => candidate.fields.get('Title') === 'Web',
    );
    expect(entry?.fields.get('URL')).toBe('10.0.0.5');
    expect(entry?.fields.get('Notes')).toBe('rack 4');
    expect(entry?.parentGroup?.name).toBe('Lab');
  }, 120_000);

  it('rejects tampered vault data and remains locked', async () => {
    const source = await readFile(vaultPath);
    const tampered = Buffer.from(source);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    const tamperedPath = join(testDirectory, 'tampered.kdbx');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(tamperedPath, tampered);

    const service = new VaultService(60_000);
    await expect(service.open(tamperedPath, masterPassword)).rejects.toBeInstanceOf(
      VaultUnlockError,
    );
    expect(service.getState().status).toBe('locked');
  }, 120_000);

  it('rejects KDF settings above the supported resource limits', async () => {
    configureArgon2Provider();
    await expect(
      CryptoEngine.argon2(
        new ArrayBuffer(32),
        new ArrayBuffer(16),
        513 * 1024,
        3,
        32,
        2,
        CryptoEngine.Argon2TypeArgon2id,
        0x13,
      ),
    ).rejects.toBeInstanceOf(UnsupportedKdfParametersError);
    await expect(
      CryptoEngine.argon2(
        new ArrayBuffer(32),
        new ArrayBuffer(16),
        8192,
        3,
        32,
        2,
        CryptoEngine.Argon2TypeArgon2id,
        0x10,
      ),
    ).rejects.toBeInstanceOf(UnsupportedKdfParametersError);
  });
});
