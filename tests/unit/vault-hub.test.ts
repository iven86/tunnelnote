import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { VaultService } from '../../src/main/vault/vault-service';
import { VaultHub } from '../../src/main/vault/vault-hub';

const password = 'test-only-strong-master-passphrase';
let dir: string;

describe('VaultHub', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(process.cwd(), 'tests/.vault-hub-'));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps several vaults open, routes hosts and locks them independently', async () => {
    const hub = new VaultHub(() => new VaultService(60_000));
    const first = await hub.create(join(dir, 'a.kdbx'), password);
    const idA = first.activeId as string;
    const second = await hub.create(join(dir, 'b.kdbx'), password);
    const idB = second.activeId as string;
    expect(second.vaults).toHaveLength(2);

    const base = {
      port: 22,
      username: 'u',
      authMethod: 'agent' as const,
      hostname: 'h.example',
    };
    const hostA = await hub.upsertSshHost({ ...base, name: 'A host', vaultId: idA });
    const hostB = await hub.upsertSshHost({ ...base, name: 'B host', vaultId: idB });
    expect(
      hub
        .listSshHosts()
        .map((h) => h.name)
        .sort(),
    ).toEqual(['A host', 'B host']);
    expect(hostA.vaultId).toBe(idA);

    await expect(hub.open(join(dir, 'a.kdbx'), password)).rejects.toThrow();

    hub.lockVault(idA);
    expect(hub.listSshHosts().map((h) => h.id)).toEqual([hostB.id]);
    const after = await hub.unlock(idA, password);
    expect(after.vaults.every((v) => v.status === 'unlocked')).toBe(true);
    expect(hub.listSshHosts()).toHaveLength(2);
    hub.lock();
  }, 120_000);

  it('remembers vault paths and the default across restarts as locked entries', async () => {
    const first = new VaultHub(() => new VaultService(60_000));
    await first.create(join(dir, 'r1.kdbx'), password);
    await first.create(join(dir, 'r2.kdbx'), password);
    const saved = first.getPersistable();
    first.setActive(first.getVaultsState().vaults[0]?.id as string);
    const persisted = first.getPersistable();
    expect(saved.paths).toHaveLength(2);
    first.lock();

    const second = new VaultHub(() => new VaultService(60_000));
    second.restore(persisted.paths, persisted.defaultPath);
    const state = second.getVaultsState();
    expect(state.vaults.map((v) => v.status)).toEqual(['locked', 'locked']);
    expect(state.vaults.find((v) => v.id === state.activeId)?.name).toBe('r1.kdbx');
    const unlocked = await second.unlock(state.activeId as string, password);
    expect(unlocked.vaults.filter((v) => v.status === 'unlocked')).toHaveLength(1);
    second.lock();
  }, 120_000);
});
