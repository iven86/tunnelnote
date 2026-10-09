import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hashVaultData,
  VaultAlreadyExistsError,
  VaultConflictError,
  writeVaultFile,
} from '../../src/main/vault/atomic-vault-file';

let testDirectory: string | undefined;

afterEach(async () => {
  if (testDirectory) {
    await rm(testDirectory, { recursive: true, force: true });
    testDirectory = undefined;
  }
});

async function makeVaultPath(): Promise<string> {
  testDirectory = await mkdtemp(join(process.cwd(), 'tests/.atomic-vault-'));
  return join(testDirectory, 'sample.kdbx');
}

describe('atomic vault persistence', () => {
  it('creates vaults without overwriting existing files', async () => {
    const path = await makeVaultPath();
    const contents = Buffer.from('encrypted vault');
    await writeVaultFile(path, contents, { mode: 'create' });

    await expect(
      writeVaultFile(path, Buffer.from('replacement'), { mode: 'create' }),
    ).rejects.toBeInstanceOf(VaultAlreadyExistsError);
    expect(await readFile(path)).toEqual(contents);
  });

  it('backs up replaced vaults and rejects external changes', async () => {
    const path = await makeVaultPath();
    const original = Buffer.from('original encrypted vault');
    const expectedHash = await writeVaultFile(path, original, { mode: 'create' });
    const newHash = await writeVaultFile(path, Buffer.from('updated encrypted vault'), {
      mode: 'replace',
      expectedHash,
    });
    expect(newHash).not.toBe(expectedHash);

    const backupNames = (await import('node:fs/promises')).readdir(testDirectory!);
    await expect(backupNames).resolves.toEqual(
      expect.arrayContaining([expect.stringMatching(/^sample\.kdbx\.backup-.*\.kdbx$/)]),
    );

    await writeFile(path, 'external edit');
    await expect(
      writeVaultFile(path, Buffer.from('should not overwrite'), {
        mode: 'replace',
        expectedHash: newHash,
      }),
    ).rejects.toBeInstanceOf(VaultConflictError);
    expect(await readFile(path, 'utf8')).toBe('external edit');
  });

  it('retains only the configured number of rolling backups', async () => {
    const path = await makeVaultPath();
    let hash = await writeVaultFile(path, Buffer.from('version 0'), { mode: 'create' });
    for (let version = 1; version <= 7; version += 1) {
      hash = await writeVaultFile(path, Buffer.from(`version ${version}`), {
        mode: 'replace',
        expectedHash: hash,
        backupLimit: 3,
      });
    }

    const { readdir } = await import('node:fs/promises');
    const backups = (await readdir(testDirectory!)).filter((name) => name.includes('.backup-'));
    expect(backups).toHaveLength(3);
    expect(hash).toBe(hashVaultData(Buffer.from('version 7')));
  });
});
