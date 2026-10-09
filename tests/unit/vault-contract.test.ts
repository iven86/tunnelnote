import { describe, expect, it } from 'vitest';
import {
  createVaultRequestSchema,
  openVaultRequestSchema,
  vaultStateSchema,
} from '../../src/shared/vault-contract';

describe('vault IPC contracts', () => {
  it('requires a sufficiently long new master password', () => {
    expect(() => createVaultRequestSchema.parse({ password: 'short' })).toThrow();
    expect(createVaultRequestSchema.parse({ password: 'long-enough-test-passphrase' })).toEqual({
      password: 'long-enough-test-passphrase',
    });
  });

  it('keeps open requests and state responses narrow', () => {
    expect(openVaultRequestSchema.parse({ password: 'existing-passphrase' })).toEqual({
      password: 'existing-passphrase',
    });
    expect(() =>
      vaultStateSchema.parse({
        status: 'unlocked',
        name: 'vault.kdbx',
        password: 'must-not-cross-back',
      }),
    ).toThrow();
  });
});
