import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Server, utils } from 'ssh2';
import type { SshHostSummary, SshSessionEvent } from '../../src/shared/ssh-contract';
import type { VaultState } from '../../src/shared/vault-contract';
import { SshSessionManager } from '../../src/main/ssh/ssh-session-manager';

const masterTestPassword = 'ssh-test-password';
const hostId = '4a3cdce0-ed4e-48a6-aa36-608cc3c5fc64';
const oldFingerprint = `SHA256:${'B'.repeat(43)}`;

describe('SshSessionManager', () => {
  let server: Server | undefined;
  let extraServers: Server[] = [];
  let manager: SshSessionManager | undefined;

  afterEach(async () => {
    manager?.disconnectAll();
    manager = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    server = undefined;
    for (const extraServer of extraServers) {
      if (extraServer.listening) {
        await new Promise<void>((resolve) => extraServer.close(() => resolve()));
      }
    }
    extraServers = [];
  });

  it('requires TOFU approval, replaces changed host keys explicitly, and opens a shell', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    let successfulAuthentications = 0;
    let receivedTerminalInput = '';
    server = new Server({ hostKeys: [privateKey] }, (client) => {
      client.on('authentication', (context) => {
        if (
          context.method === 'password' &&
          context.username === 'test-user' &&
          context.password === masterTestPassword
        ) {
          successfulAuthentications += 1;
          context.accept();
        } else {
          context.reject();
        }
      });
      client.on('ready', () => {
        client.on('session', (acceptSession) => {
          const session = acceptSession();
          session.on('pty', (acceptPty) => acceptPty());
          session.on('shell', (acceptShell) => {
            const channel = acceptShell();
            channel.write('TunnelNote test shell ready\r\n');
            channel.on('data', (data: Buffer) => {
              receivedTerminalInput += data.toString('utf8');
              if (receivedTerminalInput.includes('exit')) {
                channel.exit(0);
                channel.close();
              }
            });
          });
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => {
        server?.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('The local SSH test server did not bind to a TCP port.');
    }

    const host: SshHostSummary = {
      id: hostId,
      name: 'In-process test server',
      hostname: '127.0.0.1',
      port: address.port,
      username: 'test-user',
      authMethod: 'password',
    };
    let trustedFingerprint: string | undefined;
    let onVaultStateChange: ((state: VaultState) => void) | undefined;
    const events: SshSessionEvent[] = [];
    const eventEmitter = new EventEmitter();
    const vault = {
      subscribe(listener: (state: VaultState) => void): () => void {
        onVaultStateChange = listener;
        return () => {
          onVaultStateChange = undefined;
        };
      },
      getSshHostCredentials(): SshHostSummary & { password: string } {
        return { ...host, password: masterTestPassword };
      },
      getKnownHostFingerprint(): string | undefined {
        return trustedFingerprint;
      },
      async trustHostKey(
        _hostname: string,
        _port: number,
        fingerprint: string,
        replaceExisting: boolean,
      ): Promise<void> {
        if (trustedFingerprint && trustedFingerprint !== fingerprint && !replaceExisting) {
          throw new Error('Expected an explicit host-key replacement.');
        }
        trustedFingerprint = fingerprint;
      },
    };
    manager = new SshSessionManager(vault, (event) => {
      events.push(event);
      eventEmitter.emit('event', event);
    });

    const firstSession = manager.start(host.id, 80, 24);
    const firstPrompt = await waitForEvent(
      events,
      eventEmitter,
      (event) => event.type === 'host-key' && event.sessionId === firstSession,
    );
    if (firstPrompt.type !== 'host-key') {
      throw new Error('Expected a host-key trust prompt.');
    }
    expect(successfulAuthentications).toBe(0);
    await manager.approveHostKey(firstSession, firstPrompt.decisionId, true, false);
    const connected = await waitForEvent(
      events,
      eventEmitter,
      (event) =>
        event.type === 'state' && event.sessionId === firstSession && event.state === 'connected',
    );
    expect(connected.type).toBe('state');
    expect(trustedFingerprint).toBe(firstPrompt.fingerprint);

    await waitForEvent(
      events,
      eventEmitter,
      (event) => event.type === 'output' && event.sessionId === firstSession,
    );
    manager.write(firstSession, 'exit\r');
    await waitForEvent(
      events,
      eventEmitter,
      (event) =>
        event.type === 'state' &&
        event.sessionId === firstSession &&
        event.state === 'disconnected',
    );
    expect(receivedTerminalInput).toContain('exit');
    expect(successfulAuthentications).toBe(1);

    trustedFingerprint = oldFingerprint;
    const changedKeySession = manager.start(host.id, 80, 24);
    const changedKeyPrompt = await waitForEvent(
      events,
      eventEmitter,
      (event) => event.type === 'host-key' && event.sessionId === changedKeySession,
    );
    if (changedKeyPrompt.type !== 'host-key') {
      throw new Error('Expected a changed host-key prompt.');
    }
    expect(changedKeyPrompt.previousFingerprint).toBe(oldFingerprint);
    await expect(
      manager.approveHostKey(changedKeySession, changedKeyPrompt.decisionId, true, false),
    ).rejects.toThrow('explicit replace action');
    expect(successfulAuthentications).toBe(1);

    await manager.approveHostKey(changedKeySession, changedKeyPrompt.decisionId, true, true);
    await waitForEvent(
      events,
      eventEmitter,
      (event) =>
        event.type === 'state' &&
        event.sessionId === changedKeySession &&
        event.state === 'connected',
    );
    expect(trustedFingerprint).toBe(changedKeyPrompt.fingerprint);
    expect(successfulAuthentications).toBe(2);

    onVaultStateChange?.({ status: 'locked', name: null });
    await waitForEvent(
      events,
      eventEmitter,
      (event) =>
        event.type === 'state' &&
        event.sessionId === changedKeySession &&
        event.state === 'disconnected',
    );
  }, 15_000);

  it('authenticates with a saved private key after explicit host-key approval', async () => {
    const hostKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const userKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const parsedUserPrivateKey = utils.parseKey(userKey.privateKey);
    if (parsedUserPrivateKey instanceof Error) {
      throw parsedUserPrivateKey;
    }

    let publicKeyMatched = false;
    let signedPublicKeyPresented = false;
    server = new Server({ hostKeys: [hostKey.privateKey] }, (client) => {
      client.on('authentication', (context) => {
        if (context.method === 'publickey') {
          publicKeyMatched = context.key.data.equals(parsedUserPrivateKey.getPublicSSH());
          signedPublicKeyPresented = context.signature !== undefined;
        }
        if (
          context.method === 'publickey' &&
          context.username === 'key-user' &&
          context.key.algo === parsedUserPrivateKey.type &&
          context.key.data.equals(parsedUserPrivateKey.getPublicSSH())
        ) {
          if (
            !context.signature ||
            (context.blob &&
              parsedUserPrivateKey.verify(context.blob, context.signature, context.hashAlgo))
          ) {
            context.accept();
          } else {
            context.reject(['publickey']);
          }
        } else {
          context.reject(context.method === 'publickey' ? ['publickey'] : []);
        }
      });
      client.on('ready', () => {
        client.on('session', (acceptSession) => {
          const session = acceptSession();
          session.on('pty', (acceptPty) => acceptPty());
          session.on('shell', (acceptShell) => {
            const channel = acceptShell();
            channel.write('Private-key authentication succeeded.\r\n');
          });
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => {
        server?.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('The local SSH test server did not bind to a TCP port.');
    }

    const host: SshHostSummary = {
      id: '8c088f3c-cedf-4d7f-84dd-b71d76ec7cb2',
      name: 'Private-key test server',
      hostname: '127.0.0.1',
      port: address.port,
      username: 'key-user',
      authMethod: 'privateKey',
    };
    const events: SshSessionEvent[] = [];
    const eventEmitter = new EventEmitter();
    const vault = {
      subscribe(): () => void {
        return () => undefined;
      },
      getSshHostCredentials(): SshHostSummary & { privateKey: string } {
        return { ...host, privateKey: userKey.privateKey };
      },
      getKnownHostFingerprint(): undefined {
        return undefined;
      },
      async trustHostKey(): Promise<void> {},
    };
    manager = new SshSessionManager(vault, (event) => {
      events.push(event);
      eventEmitter.emit('event', event);
    });

    const sessionId = manager.start(host.id, 80, 24);
    const prompt = await waitForEvent(
      events,
      eventEmitter,
      (event) => event.type === 'host-key' && event.sessionId === sessionId,
    );
    if (prompt.type !== 'host-key') {
      throw new Error('Expected a host-key trust prompt.');
    }
    await manager.approveHostKey(sessionId, prompt.decisionId, true, false);
    const sessionState = await waitForEvent(
      events,
      eventEmitter,
      (event) =>
        event.type === 'state' && event.sessionId === sessionId && event.state !== 'connecting',
    );
    expect(publicKeyMatched).toBe(true);
    expect(signedPublicKeyPresented).toBe(true);
    expect(sessionState.type === 'state' && sessionState.state).toBe('connected');
    const output = await waitForEvent(
      events,
      eventEmitter,
      (event) => event.type === 'output' && event.sessionId === sessionId,
    );
    expect(output.type === 'output' && output.data).toContain(
      'Private-key authentication succeeded.',
    );
    manager.disconnect(sessionId);
    await waitForEvent(
      events,
      eventEmitter,
      (event) =>
        event.type === 'state' && event.sessionId === sessionId && event.state === 'disconnected',
    );
  }, 15_000);

  it('pauses for keyboard-interactive OTP prompts and sends only the user response', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    server = new Server({ hostKeys: [privateKey] }, (client) => {
      client.on('authentication', (context) => {
        if (context.method === 'keyboard-interactive') {
          context.prompt([{ prompt: 'One-time verification code:', echo: false }], (responses) => {
            if (responses[0] === '123456') {
              context.accept();
            } else {
              context.reject();
            }
          });
          return;
        }
        context.reject(context.method === 'none' ? ['keyboard-interactive'] : []);
      });
      client.on('ready', () => {
        client.on('session', (acceptSession) => {
          const session = acceptSession();
          session.on('pty', (acceptPty) => acceptPty());
          session.on('shell', (acceptShell) => acceptShell().write('OTP accepted.\r\n'));
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => {
        server?.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('The local SSH test server did not bind to a TCP port.');
    }

    const host: SshHostSummary = {
      id: '90ef0de4-5643-4a6c-85d9-e4202c2cd2ad',
      name: 'Keyboard-interactive test server',
      hostname: '127.0.0.1',
      port: address.port,
      username: 'otp-user',
      authMethod: 'keyboardInteractive',
    };
    const events: SshSessionEvent[] = [];
    const eventEmitter = new EventEmitter();
    const vault = {
      subscribe(): () => void {
        return () => undefined;
      },
      getSshHostCredentials(): SshHostSummary {
        return host;
      },
      getKnownHostFingerprint(): undefined {
        return undefined;
      },
      async trustHostKey(): Promise<void> {},
    };
    manager = new SshSessionManager(vault, (event) => {
      events.push(event);
      eventEmitter.emit('event', event);
    });

    const sessionId = manager.start(host.id, 80, 24);
    const hostKeyPrompt = await waitForEvent(
      events,
      eventEmitter,
      (event) => event.type === 'host-key' && event.sessionId === sessionId,
    );
    if (hostKeyPrompt.type !== 'host-key') {
      throw new Error('Expected a host-key trust prompt.');
    }
    await manager.approveHostKey(sessionId, hostKeyPrompt.decisionId, true, false);
    const challenge = await waitForEvent(
      events,
      eventEmitter,
      (event) => event.type === 'keyboard-interactive' && event.sessionId === sessionId,
    );
    if (challenge.type !== 'keyboard-interactive') {
      throw new Error('Expected a keyboard-interactive challenge.');
    }
    expect(challenge.prompts).toEqual([{ text: 'One-time verification code:', echo: false }]);
    await manager.answerKeyboardInteractive(sessionId, challenge.challengeId, ['123456']);
    const connected = await waitForEvent(
      events,
      eventEmitter,
      (event) =>
        event.type === 'state' && event.sessionId === sessionId && event.state === 'connected',
    );
    expect(connected.type).toBe('state');
    manager.disconnect(sessionId);
  }, 15_000);

  it('authenticates each jump hop and trusts each host key independently', async () => {
    const destinationPrivateKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    }).privateKey;
    const jumpPrivateKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    }).privateKey;
    const destination = new Server({ hostKeys: [destinationPrivateKey] }, (client) => {
      client.on('authentication', (context) => {
        if (context.method === 'password' && context.password === 'destination-secret') {
          context.accept();
        } else {
          context.reject();
        }
      });
      client.on('ready', () => {
        client.on('session', (acceptSession) => {
          const session = acceptSession();
          session.on('pty', (acceptPty) => acceptPty());
          session.on('shell', (acceptShell) =>
            acceptShell().write('Reached the target through the jump host.\r\n'),
          );
        });
      });
    });
    extraServers.push(destination);
    await listen(destination);
    const destinationAddress = destination.address();
    if (!destinationAddress || typeof destinationAddress === 'string') {
      throw new Error('The target SSH test server did not bind to a TCP port.');
    }

    server = new Server({ hostKeys: [jumpPrivateKey] }, (client) => {
      client.on('authentication', (context) => {
        if (context.method === 'password' && context.password === 'jump-secret') {
          context.accept();
        } else {
          context.reject();
        }
      });
      client.on('ready', () => {
        client.on('tcpip', (accept, reject, info) => {
          const socket = createConnection(info.destPort, info.destIP);
          socket.once('connect', () => {
            const channel = accept();
            channel.pipe(socket);
            socket.pipe(channel);
          });
          socket.once('error', () => {
            reject();
          });
        });
      });
    });
    await listen(server);
    const jumpAddress = server.address();
    if (!jumpAddress || typeof jumpAddress === 'string') {
      throw new Error('The jump SSH test server did not bind to a TCP port.');
    }

    const jumpHost: SshHostSummary = {
      id: 'cb0c1490-9a03-4ee6-b4b0-a1e75ac8421d',
      name: 'Jump host',
      hostname: '127.0.0.1',
      port: jumpAddress.port,
      username: 'jump-user',
      authMethod: 'password',
    };
    const targetHost: SshHostSummary = {
      id: 'bcc64fc6-4463-4a8b-b00c-c0fcba5fae5e',
      name: 'Destination host',
      hostname: '127.0.0.1',
      port: destinationAddress.port,
      username: 'destination-user',
      authMethod: 'password',
      jumpHostId: jumpHost.id,
    };
    const hostCredentials = new Map([
      [jumpHost.id, { ...jumpHost, password: 'jump-secret' }],
      [targetHost.id, { ...targetHost, password: 'destination-secret' }],
    ]);
    const knownFingerprints = new Map<string, string>();
    const events: SshSessionEvent[] = [];
    const eventEmitter = new EventEmitter();
    const vault = {
      subscribe(): () => void {
        return () => undefined;
      },
      getSshHostCredentials(id: string) {
        const credentials = hostCredentials.get(id);
        if (!credentials) {
          throw new Error('SSH host missing.');
        }
        return credentials;
      },
      getKnownHostFingerprint(hostname: string, port: number): string | undefined {
        return knownFingerprints.get(`${hostname}:${port}`);
      },
      async trustHostKey(hostname: string, port: number, fingerprint: string): Promise<void> {
        knownFingerprints.set(`${hostname}:${port}`, fingerprint);
      },
    };
    manager = new SshSessionManager(vault, (event) => {
      events.push(event);
      eventEmitter.emit('event', event);
    });

    const sessionId = manager.start(targetHost.id, 80, 24);
    for (const expectedHost of [jumpHost, targetHost]) {
      const prompt = await waitForEvent(
        events,
        eventEmitter,
        (event) =>
          event.type === 'host-key' &&
          event.sessionId === sessionId &&
          event.hostname === expectedHost.hostname &&
          event.port === expectedHost.port,
      );
      if (prompt.type !== 'host-key') {
        throw new Error('Expected a host-key trust prompt for each hop.');
      }
      await manager.approveHostKey(sessionId, prompt.decisionId, true, false);
    }

    await waitForEvent(
      events,
      eventEmitter,
      (event) =>
        event.type === 'state' && event.sessionId === sessionId && event.state === 'connected',
    );
    const output = await waitForEvent(
      events,
      eventEmitter,
      (event) => event.type === 'output' && event.sessionId === sessionId,
    );
    expect(output.type === 'output' && output.data).toContain(
      'Reached the target through the jump host.',
    );
    expect(knownFingerprints.size).toBe(2);
    manager.disconnect(sessionId);
  }, 20_000);
});

async function listen(sshServer: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sshServer.once('error', reject);
    sshServer.listen(0, '127.0.0.1', () => {
      sshServer.removeListener('error', reject);
      resolve();
    });
  });
}

function waitForEvent(
  events: SshSessionEvent[],
  eventEmitter: EventEmitter,
  predicate: (event: SshSessionEvent) => boolean,
): Promise<SshSessionEvent> {
  const existing = events.find(predicate);
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      eventEmitter.removeListener('event', listener);
      const received = events.map((event) =>
        event.type === 'state' ? `${event.type}:${event.state}:${event.message ?? ''}` : event.type,
      );
      reject(
        new Error(`Timed out waiting for the SSH session event. Received: ${received.join(', ')}`),
      );
    }, 5_000);
    const listener = (event: SshSessionEvent): void => {
      if (!predicate(event)) {
        return;
      }
      clearTimeout(timer);
      eventEmitter.removeListener('event', listener);
      resolve(event);
    };
    eventEmitter.on('event', listener);
  });
}
