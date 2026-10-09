import { describe, expect, it } from 'vitest';
import {
  sftpLocalListRequestSchema,
  sftpTransferEventSchema,
  sftpTransferRequestSchema,
  sshSessionEventSchema,
  startSshRequestSchema,
  upsertSshHostRequestSchema,
} from '../../src/shared/ssh-contract';
import { createHostKeyRandomArt } from '../../src/main/ssh/host-key-randomart';
import { resolveSshAgent } from '../../src/main/ssh/ssh-agent-adapter';

describe('SSH contracts and host-key display', () => {
  it('requires credentials when creating a saved host', () => {
    const result = upsertSshHostRequestSchema.safeParse({
      name: 'Build server',
      hostname: 'server.example',
      port: 22,
      username: 'builder',
      authMethod: 'password',
    });
    expect(result.success).toBe(false);
    expect(
      upsertSshHostRequestSchema.safeParse({
        name: 'Build server',
        hostname: 'server.example',
        port: 22,
        username: 'builder',
        authMethod: 'password',
        password: '',
      }).success,
    ).toBe(false);
    expect(
      upsertSshHostRequestSchema.safeParse({
        name: 'Agent server',
        hostname: 'server.example',
        port: 22,
        username: 'builder',
        authMethod: 'agent',
        password: 'unused-test-secret',
      }).success,
    ).toBe(false);
  });

  it('bounds terminal dimensions before connection setup', () => {
    expect(
      startSshRequestSchema.safeParse({
        hostId: '4a3cdce0-ed4e-48a6-aa36-608cc3c5fc64',
        cols: 1,
        rows: 24,
      }).success,
    ).toBe(false);
  });

  it('bounds SFTP requests and transfer events at the IPC boundary', () => {
    const validTransfer = {
      sessionId: '4a3cdce0-ed4e-48a6-aa36-608cc3c5fc64',
      rootId: '8ded4f26-ef80-4e08-a93b-41348d7c40d2',
      direction: 'upload',
      localPath: 'folder/file.txt',
      remotePath: '/home/user/file.txt',
      overwrite: false,
      resume: true,
    };
    expect(sftpTransferRequestSchema.safeParse(validTransfer).success).toBe(true);
    expect(
      sftpTransferRequestSchema.safeParse({ ...validTransfer, unexpectedPath: '/outside' }).success,
    ).toBe(false);
    expect(
      sftpLocalListRequestSchema.safeParse({
        sessionId: validTransfer.sessionId,
        rootId: validTransfer.rootId,
        relativePath: 'x'.repeat(4097),
      }).success,
    ).toBe(false);
    expect(
      sftpTransferEventSchema.safeParse({
        type: 'transfer',
        sessionId: validTransfer.sessionId,
        transferId: validTransfer.rootId,
        direction: 'download',
        status: 'transferring',
        transferredBytes: 10,
        totalBytes: 100,
      }).success,
    ).toBe(true);
  });

  it('resolves the configured agent per OS and fails explicitly without one', () => {
    expect(resolveSshAgent('linux', { SSH_AUTH_SOCK: '/tmp/agent.sock' })).toBe('/tmp/agent.sock');
    expect(resolveSshAgent('win32', {})).toBe('pageant');
    expect(() => resolveSshAgent('darwin', {})).toThrow('SSH_AUTH_SOCK');
  });

  it('validates SSH host-key prompts and creates deterministic randomart', () => {
    const key = Buffer.from('test host key');
    const randomart = createHostKeyRandomArt(key);
    expect(createHostKeyRandomArt(key)).toBe(randomart);
    expect(randomart.split('\n')).toHaveLength(11);
    expect(randomart).toContain('S');
    expect(randomart).toContain('E');

    expect(
      sshSessionEventSchema.safeParse({
        type: 'host-key',
        sessionId: '4a3cdce0-ed4e-48a6-aa36-608cc3c5fc64',
        decisionId: '8ded4f26-ef80-4e08-a93b-41348d7c40d2',
        hostname: 'server.example',
        port: 22,
        fingerprint: `SHA256:${'A'.repeat(43)}`,
        randomart,
        previousFingerprint: null,
      }).success,
    ).toBe(true);
  });
});
