import { Consts, Credentials, Kdbx, ProtectedValue } from 'kdbxweb';
import { describe, expect, it } from 'vitest';
import { configureArgon2Provider } from '../../src/main/vault/argon2-provider';

describe('KDBX protected fields', () => {
  it('keeps protected values encrypted in serialized vault data', async () => {
    configureArgon2Provider();
    const password = 'test-encryption-password';
    const secret = 'do-not-store-this-in-plaintext';
    const credentials = new Credentials(ProtectedValue.fromString(password));
    await credentials.ready;

    const database = Kdbx.create(credentials, 'Encryption test');
    database.setKdf(Consts.KdfId.Argon2id);
    const entry = database.createEntry(database.getDefaultGroup());
    entry.fields.set('Title', 'Test entry');
    entry.fields.set('Password', ProtectedValue.fromString(secret));

    const saved = await database.save();
    const encryptedBytes = Buffer.from(saved);
    expect(encryptedBytes.includes(Buffer.from(secret))).toBe(false);

    const savedCopy = new ArrayBuffer(saved.byteLength);
    new Uint8Array(savedCopy).set(new Uint8Array(saved));
    const reopened = await Kdbx.load(savedCopy, credentials);
    const reopenedEntry = reopened.getDefaultGroup().entries[0];
    expect(reopenedEntry).toBeDefined();
    const protectedField = reopenedEntry?.fields.get('Password');
    expect(protectedField).toBeInstanceOf(ProtectedValue);
    if (!(protectedField instanceof ProtectedValue)) {
      throw new Error('Password field was not loaded as a protected value.');
    }
    expect(protectedField.getText()).toBe(secret);
  }, 30_000);
});
