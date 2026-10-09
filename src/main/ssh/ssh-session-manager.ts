import { createHash, randomUUID } from 'node:crypto';
import {
  Client,
  type ClientChannel,
  type KeyboardInteractiveCallback,
  type Prompt,
  type SFTPWrapper,
  type VerifyCallback,
} from 'ssh2';
import type { SshHostSummary, SshSessionEvent } from '../../shared/ssh-contract';
import { securityLogger } from '../security/redacting-logger';
import { VaultService, type SshHostCredentials } from '../vault/vault-service';
import { resolveSshAgent } from './ssh-agent-adapter';
import { createHostKeyRandomArt } from './host-key-randomart';

const READY_TIMEOUT_MS = 20_000;
const HOST_KEY_DECISION_TIMEOUT_MS = 90_000;
const MAX_TERMINAL_DATA_LENGTH = 65_536;
const MAX_JUMP_HOSTS = 3;
import type { SessionLogSink } from './session-logger';

const MAX_ACTIVE_SESSIONS = 16;

interface ManagedSession {
  id: string;
  host: SshHostSummary;
  clients: Client[];
  channel?: ClientChannel;
  credentialBuffers: Buffer[];
  sftp?: Promise<SFTPWrapper>;
  state: 'connecting' | 'connected' | 'disconnected';
  closing: boolean;
}

interface PendingHostKeyDecision {
  id: string;
  session: ManagedSession;
  hostname: string;
  port: number;
  fingerprint: string;
  previousFingerprint: string | undefined;
  verify: VerifyCallback;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingKeyboardChallenge {
  session: ManagedSession;
  finish: KeyboardInteractiveCallback;
  timer: ReturnType<typeof setTimeout>;
}

export type SshEventSink = (event: SshSessionEvent) => void;

type SshVault = Pick<
  VaultService,
  'subscribe' | 'getSshHostCredentials' | 'getKnownHostFingerprint' | 'trustHostKey'
>;

export class SshSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly pendingHostKeys = new Map<string, PendingHostKeyDecision>();
  private readonly pendingKeyboardChallenges = new Map<string, PendingKeyboardChallenge>();
  private readonly sessionCloseListeners = new Set<(sessionId: string) => void>();

  constructor(
    private readonly vault: SshVault,
    private readonly emit: SshEventSink,
    private readonly logger?: SessionLogSink,
  ) {
    vault.subscribe((state) => {
      if (state.status === 'locked') {
        this.disconnectAll();
      }
    });
  }

  start(hostId: string, cols: number, rows: number): string {
    if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
      throw new Error(`TunnelNote supports up to ${MAX_ACTIVE_SESSIONS} active SSH sessions.`);
    }
    const credentials = this.getCredentialChain(hostId);
    const targetCredentials = credentials[credentials.length - 1];
    if (!targetCredentials) {
      throw new Error('The SSH host configuration is empty.');
    }
    const host: SshHostSummary = {
      id: targetCredentials.id,
      name: targetCredentials.name,
      hostname: targetCredentials.hostname,
      port: targetCredentials.port,
      username: targetCredentials.username,
      authMethod: targetCredentials.authMethod,
    };
    const sessionId = randomUUID();
    const session: ManagedSession = {
      id: sessionId,
      host,
      clients: [],
      credentialBuffers: [],
      state: 'connecting',
      closing: false,
    };
    this.sessions.set(sessionId, session);
    this.emitState(session, 'connecting');
    try {
      this.configureConnection(session, credentials, 0, cols, rows);
    } catch (error) {
      this.failSession(session, 'Unable to start the SSH connection.');
      throw error;
    }
    return sessionId;
  }

  write(sessionId: string, data: string): void {
    const session = this.getSession(sessionId);
    if (session.state !== 'connected' || !session.channel) {
      throw new Error('The SSH terminal is not connected.');
    }
    session.channel.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.getSession(sessionId);
    if (session.state === 'connected' && session.channel) {
      session.channel.setWindow(rows, cols, 0, 0);
    }
  }

  openSftp(sessionId: string): Promise<SFTPWrapper> {
    const session = this.getSession(sessionId);
    this.assertConnected(session);
    const client = session.clients[session.clients.length - 1];
    if (!client) {
      throw new Error('The SSH transport is no longer available.');
    }
    session.sftp ??= new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) {
          session.sftp = undefined;
          reject(new Error('The SSH server could not start an SFTP subsystem.'));
          return;
        }
        sftp.once('close', () => {
          session.sftp = undefined;
        });
        resolve(sftp);
      });
    });
    return session.sftp;
  }

  getTransport(sessionId: string): Client {
    const session = this.getSession(sessionId);
    this.assertConnected(session);
    const client = session.clients[session.clients.length - 1];
    if (!client) {
      throw new Error('The SSH transport is no longer available.');
    }
    return client;
  }

  getSessionTarget(sessionId: string): { host: string; user: string } {
    const session = this.getSession(sessionId);
    return { host: session.host.hostname, user: session.host.username };
  }

  getSessionHostId(sessionId: string): string {
    return this.getSession(sessionId).host.id;
  }

  listConnectedSessions(): { sessionId: string; hostId: string; hostName: string }[] {
    return [...this.sessions.values()]
      .filter((session) => session.state === 'connected')
      .map((session) => ({
        sessionId: session.id,
        hostId: session.host.id,
        hostName: session.host.name,
      }));
  }

  assertSessionConnected(sessionId: string): void {
    this.assertConnected(this.getSession(sessionId));
  }

  onSessionClosed(listener: (sessionId: string) => void): () => void {
    this.sessionCloseListeners.add(listener);
    return () => this.sessionCloseListeners.delete(listener);
  }

  async approveHostKey(
    sessionId: string,
    decisionId: string,
    approve: boolean,
    replaceExisting: boolean,
  ): Promise<void> {
    const decision = this.pendingHostKeys.get(decisionId);
    if (!decision || decision.session.id !== sessionId) {
      throw new Error('This SSH host-key decision is no longer active.');
    }

    this.clearHostKeyDecision(decision);
    if (!approve) {
      decision.verify(false);
      this.disconnect(sessionId, 'SSH host key was not accepted.');
      return;
    }

    if (decision.previousFingerprint && !replaceExisting) {
      this.pendingHostKeys.set(decision.id, decision);
      decision.timer = setTimeout(
        () => this.rejectExpiredDecision(decision),
        HOST_KEY_DECISION_TIMEOUT_MS,
      );
      throw new Error('Replacing a trusted host key requires the explicit replace action.');
    }
    if (!decision.previousFingerprint && replaceExisting) {
      this.pendingHostKeys.set(decision.id, decision);
      decision.timer = setTimeout(
        () => this.rejectExpiredDecision(decision),
        HOST_KEY_DECISION_TIMEOUT_MS,
      );
      throw new Error('There is no existing host key to replace.');
    }

    try {
      await this.vault.trustHostKey(
        decision.hostname,
        decision.port,
        decision.fingerprint,
        replaceExisting,
      );
      decision.verify(true);
    } catch (error) {
      decision.verify(false);
      this.disconnect(sessionId, 'Unable to save the approved SSH host key.');
      throw error;
    }
  }

  answerKeyboardInteractive(sessionId: string, challengeId: string, responses: string[]): void {
    const challenge = this.pendingKeyboardChallenges.get(challengeId);
    if (!challenge || challenge.session.id !== sessionId) {
      throw new Error('This keyboard-interactive challenge is no longer active.');
    }
    clearTimeout(challenge.timer);
    this.pendingKeyboardChallenges.delete(challengeId);
    challenge.finish(responses);
  }

  disconnect(sessionId: string, message = 'Disconnected by user.'): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.closing = true;
    this.rejectSessionDecisions(session);
    session.channel?.close();
    for (const client of session.clients) {
      client.end();
    }
    this.finishSession(session, message);
  }

  disconnectHosts(hostIds: string[]): void {
    const ids = new Set(hostIds);
    for (const session of [...this.sessions.values()]) {
      if (ids.has(session.host.id)) {
        this.disconnect(session.id, 'Vault locked; SSH connection closed.');
      }
    }
  }

  disconnectAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.disconnect(sessionId, 'Vault locked; SSH connection closed.');
    }
  }

  private configureConnection(
    session: ManagedSession,
    chain: SshHostCredentials[],
    hopIndex: number,
    cols: number,
    rows: number,
    socket?: ClientChannel,
  ): void {
    const host = chain[hopIndex];
    if (!host || session.closing) {
      socket?.destroy();
      return;
    }
    const client = new Client();
    session.clients.push(client);
    const config = {
      host: host.hostname,
      port: host.port,
      username: host.username,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: 20_000,
      keepaliveCountMax: 3,
      ...(host.authMethod === 'agent'
        ? {
            agent: resolveSshAgent(process.platform, process.env),
            authHandler: ['agent' as const],
          }
        : {}),
      ...(host.authMethod === 'keyboardInteractive'
        ? {
            tryKeyboard: true,
            authHandler: ['keyboard-interactive' as const],
          }
        : {}),
      ...(socket ? { sock: socket } : {}),
      hostVerifier: (key: Buffer, verify: VerifyCallback): void => {
        this.verifyHostKey(session, host, key, verify);
      },
      ...(host.authMethod === 'password'
        ? { password: host.password ?? '' }
        : host.authMethod === 'privateKey'
          ? this.privateKeyOptions(session, host)
          : {}),
    };

    client.on('ready', () => {
      if (session.closing) {
        return;
      }
      const nextHop = chain[hopIndex + 1];
      if (nextHop) {
        client.forwardOut('127.0.0.1', 0, nextHop.hostname, nextHop.port, (error, stream) => {
          if (error || session.closing) {
            stream?.destroy();
            this.failSession(session, 'Unable to open the SSH jump-host tunnel.');
            return;
          }
          this.configureConnection(session, chain, hopIndex + 1, cols, rows, stream);
        });
        return;
      }
      client.shell(
        {
          term: 'xterm-256color',
          cols,
          rows,
          width: 0,
          height: 0,
        },
        (error, channel) => {
          if (error || session.closing) {
            this.failSession(session, 'Unable to open a remote terminal.');
            return;
          }
          this.attachTerminal(session, channel);
        },
      );
    });

    client.on('error', (error: Error) => {
      securityLogger.warn(`SSH transport error at ${host.hostname}:${host.port}: ${error.message}`);
      this.failSession(
        session,
        `SSH connection failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    });

    client.on('end', () => {
      if (!session.closing) {
        this.finishSession(session, 'SSH connection ended by server.');
      }
    });

    client.on('close', () => {
      if (!session.closing) {
        this.finishSession(session, 'SSH connection closed.');
      }
    });

    client.on(
      'keyboard-interactive',
      (
        name: string,
        instructions: string,
        _language: string,
        prompts: Prompt[],
        finish: KeyboardInteractiveCallback,
      ) => {
        if (session.closing) {
          finish([]);
          return;
        }
        if (
          prompts.length > 12 ||
          prompts.some((prompt) => prompt.prompt.length > 1024) ||
          name.length > 256 ||
          instructions.length > 1024
        ) {
          finish([]);
          this.failSession(session, 'The SSH server requested an oversized authentication prompt.');
          return;
        }
        const challengeId = randomUUID();
        const promptTimer = setTimeout(() => {
          this.pendingKeyboardChallenges.delete(challengeId);
          finish([]);
          this.emitState(session, session.state, 'Keyboard-interactive prompt expired.');
        }, HOST_KEY_DECISION_TIMEOUT_MS);
        this.pendingKeyboardChallenges.set(challengeId, {
          session,
          finish,
          timer: promptTimer,
        });
        this.emit({
          type: 'keyboard-interactive',
          sessionId: session.id,
          challengeId,
          name,
          instructions,
          hostname: host.hostname,
          port: host.port,
          prompts: prompts.slice(0, 12).map((prompt) => ({
            text: prompt.prompt.slice(0, 1024),
            echo: prompt.echo ?? false,
          })),
        });
      },
    );

    try {
      client.connect(config);
    } catch (error) {
      securityLogger.error(
        `SSH connection setup failed at ${host.hostname}:${host.port}: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.failSession(
        session,
        `SSH setup failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private privateKeyOptions(
    session: ManagedSession,
    host: SshHostCredentials,
  ): { privateKey: Buffer; passphrase?: Buffer } {
    if (!host.privateKey) {
      throw new Error('This host has no saved private key. Edit the host and add one.');
    }
    const privateKeyBuffer = Buffer.from(host.privateKey);
    session.credentialBuffers.push(privateKeyBuffer);
    if (host.passphrase !== undefined) {
      const passphraseBuffer = Buffer.from(host.passphrase);
      session.credentialBuffers.push(passphraseBuffer);
      return { privateKey: privateKeyBuffer, passphrase: passphraseBuffer };
    }
    return { privateKey: privateKeyBuffer };
  }

  private attachTerminal(session: ManagedSession, channel: ClientChannel): void {
    session.channel = channel;
    session.state = 'connected';
    this.emitState(session, 'connected');
    this.logger?.begin(session.id, session.host.name);
    channel.on('data', (data: Buffer | string) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      this.logger?.write(session.id, text);
      for (let offset = 0; offset < text.length; offset += MAX_TERMINAL_DATA_LENGTH) {
        this.emit({
          type: 'output',
          sessionId: session.id,
          data: text.slice(offset, offset + MAX_TERMINAL_DATA_LENGTH),
        });
      }
    });
    channel.stderr.on('data', (data: Buffer | string) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      this.logger?.write(session.id, text);
      for (let offset = 0; offset < text.length; offset += MAX_TERMINAL_DATA_LENGTH) {
        this.emit({
          type: 'output',
          sessionId: session.id,
          data: text.slice(offset, offset + MAX_TERMINAL_DATA_LENGTH),
        });
      }
    });
    channel.on('close', () => this.finishSession(session, 'Remote terminal closed.'));
  }

  private verifyHostKey(
    session: ManagedSession,
    host: SshHostCredentials,
    key: Buffer,
    verify: VerifyCallback,
  ): void {
    let fingerprint: string;
    try {
      fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
    } catch {
      verify(false);
      this.failSession(session, 'Unable to verify the SSH host key.');
      return;
    }

    let previousFingerprint: string | undefined;
    try {
      previousFingerprint = this.vault.getKnownHostFingerprint(host.hostname, host.port);
    } catch {
      verify(false);
      this.failSession(session, 'The vault locked before the SSH host key could be checked.');
      return;
    }

    if (previousFingerprint === fingerprint) {
      verify(true);
      return;
    }

    const decisionId = randomUUID();
    const decision: PendingHostKeyDecision = {
      id: decisionId,
      session,
      hostname: host.hostname,
      port: host.port,
      fingerprint,
      previousFingerprint,
      verify,
      timer: setTimeout(() => this.rejectExpiredDecision(decision), HOST_KEY_DECISION_TIMEOUT_MS),
    };
    this.pendingHostKeys.set(decisionId, decision);
    this.emit({
      type: 'host-key',
      sessionId: session.id,
      decisionId,
      hostname: host.hostname,
      port: host.port,
      fingerprint,
      randomart: createHostKeyRandomArt(key),
      previousFingerprint: previousFingerprint ?? null,
    });
  }

  private rejectExpiredDecision(decision: PendingHostKeyDecision): void {
    if (!this.pendingHostKeys.has(decision.id)) {
      return;
    }
    this.clearHostKeyDecision(decision);
    decision.verify(false);
    this.disconnect(
      decision.session.id,
      'SSH host key was not accepted before the prompt expired.',
    );
  }

  private clearHostKeyDecision(decision: PendingHostKeyDecision): void {
    clearTimeout(decision.timer);
    this.pendingHostKeys.delete(decision.id);
  }

  private rejectSessionDecisions(session: ManagedSession): void {
    for (const decision of this.pendingHostKeys.values()) {
      if (decision.session === session) {
        this.clearHostKeyDecision(decision);
        decision.verify(false);
      }
    }
    for (const [challengeId, challenge] of this.pendingKeyboardChallenges) {
      if (challenge.session === session) {
        clearTimeout(challenge.timer);
        this.pendingKeyboardChallenges.delete(challengeId);
        challenge.finish([]);
      }
    }
  }

  private failSession(session: ManagedSession, message: string): void {
    if (session.state === 'disconnected') {
      return;
    }
    session.closing = true;
    this.finishSession(session, message);
  }

  private finishSession(session: ManagedSession, message: string): void {
    if (session.state === 'disconnected') {
      return;
    }
    session.closing = true;
    session.state = 'disconnected';
    this.rejectSessionDecisions(session);
    for (const buffer of session.credentialBuffers) {
      buffer.fill(0);
    }
    session.credentialBuffers = [];
    for (const client of session.clients) {
      try {
        client.end();
      } catch {
        // Client may already be closed
      }
    }
    session.clients = [];
    session.channel = undefined;
    this.logger?.end(session.id);
    this.emitState(session, 'disconnected', message);
    this.sessions.delete(session.id);
    for (const listener of this.sessionCloseListeners) {
      listener(session.id);
    }
  }

  private emitState(
    session: ManagedSession,
    state: ManagedSession['state'],
    message?: string,
  ): void {
    this.emit({
      type: 'state',
      sessionId: session.id,
      hostId: session.host.id,
      state,
      ...(message ? { message } : {}),
    });
  }

  private getSession(sessionId: string): ManagedSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === 'disconnected') {
      throw new Error('The SSH session is no longer active.');
    }
    return session;
  }

  private getCredentialChain(hostId: string): SshHostCredentials[] {
    const visited = new Set<string>();
    const targetFirst: SshHostCredentials[] = [];
    let currentId: string | undefined = hostId;
    while (currentId) {
      if (visited.has(currentId)) {
        throw new Error('Jump-host configuration contains a cycle.');
      }
      if (targetFirst.length > MAX_JUMP_HOSTS) {
        throw new Error(`Jump-host chains are limited to ${MAX_JUMP_HOSTS} intermediate hosts.`);
      }
      visited.add(currentId);
      const host = this.vault.getSshHostCredentials(currentId);
      targetFirst.push(host);
      currentId = host.jumpHostId;
    }
    return targetFirst.reverse();
  }

  private assertConnected(session: ManagedSession): void {
    if (session.state !== 'connected') {
      throw new Error('Connect the SSH session before opening SFTP.');
    }
  }
}
