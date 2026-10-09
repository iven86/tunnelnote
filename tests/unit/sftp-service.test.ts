import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SftpService } from '../../src/main/ssh/sftp-service';

const sessionId = 'f8480ce8-e994-42d6-bdfd-31792c2632f1';

describe('SftpService local boundaries', () => {
  let temporaryRoot: string | undefined;

  afterEach(async () => {
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true });
      temporaryRoot = undefined;
    }
  });

  it('browses only under the registered folder and identifies links without following them', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'tunnelnote-sftp-'));
    const root = join(temporaryRoot, 'selected');
    const outside = join(temporaryRoot, 'outside');
    await mkdir(root);
    await mkdir(join(root, 'folder'));
    await writeFile(join(root, 'note.txt'), 'safe');
    await writeFile(outside, 'outside');
    await symlink(outside, join(root, 'escape'));

    const service = new SftpService(createSessionProvider(), () => undefined);
    const selection = await service.registerLocalRoot(sessionId, root);
    const listing = await service.listLocal(sessionId, selection.rootId, '');

    expect(listing.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'folder', type: 'directory' }),
        expect.objectContaining({ name: 'note.txt', type: 'file', size: 4 }),
        expect.objectContaining({ name: 'escape', type: 'symlink' }),
      ]),
    );
    await expect(service.listLocal(sessionId, selection.rootId, '../')).rejects.toThrow(
      'cannot contain',
    );
    await expect(service.listLocal(sessionId, selection.rootId, 'escape')).rejects.toThrow(
      'outside the selected SFTP folder',
    );
  });

  it('requires a regular folder and expires its opaque handle when the SSH session closes', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'tunnelnote-sftp-'));
    const filePath = join(temporaryRoot, 'file.txt');
    await writeFile(filePath, 'not a folder');

    const service = new SftpService(createSessionProvider(), () => undefined);
    await expect(service.registerLocalRoot(sessionId, filePath)).rejects.toThrow(
      'Choose a local folder',
    );
    const selection = await service.registerLocalRoot(sessionId, temporaryRoot);
    service.closeSession(sessionId);
    await expect(service.listLocal(sessionId, selection.rootId, '')).rejects.toThrow(
      'Choose a local SFTP folder',
    );
  });
});

function createSessionProvider() {
  return {
    openSftp: async () => {
      throw new Error('No SSH session should be opened by this test.');
    },
    assertSessionConnected: () => undefined,
    onSessionClosed: () => () => undefined,
  };
}
