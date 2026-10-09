import { randomUUID } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { Client } from 'ssh2';
import {
  forwardRulesSchema,
  type ForwardRule,
  type ForwardRuleInput,
  type ForwardStatus,
} from '../../shared/workspace-contract';
import type { JsonStore } from '../storage/json-store';
import { negotiateSocks5, socks5Reply } from './socks5';

export interface ForwardTransportSource {
  getTransport(sessionId: string): Client;
  getSessionHostId(sessionId: string): string;
  onSessionClosed(listener: (sessionId: string) => void): () => void;
}

interface ActiveForward {
  rule: ForwardRule;
  sessionId: string;
  boundPort: number;
  sockets: Set<Socket>;
  stop: () => void;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackBind(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase());
}

export class ForwardingService {
  private readonly active = new Map<string, ActiveForward>();
  private readonly errors = new Map<string, ForwardStatus>();

  constructor(
    private readonly transports: ForwardTransportSource,
    private readonly store: JsonStore<ForwardRule[]>,
  ) {
    transports.onSessionClosed((sessionId) => {
      for (const forward of [...this.active.values()]) {
        if (forward.sessionId === sessionId) {
          this.stop(forward.rule.id);
        }
      }
    });
  }

  list(): Promise<ForwardRule[]> {
    return this.store.read();
  }

  async save(input: ForwardRuleInput): Promise<ForwardRule> {
    const rules = await this.store.read();
    const parsed = forwardRulesSchema.element.parse({ ...input, id: input.id ?? randomUUID() });
    const next = rules.some((rule) => rule.id === parsed.id)
      ? rules.map((rule) => (rule.id === parsed.id ? parsed : rule))
      : [...rules, parsed];
    await this.store.write(next);
    return parsed;
  }

  async remove(ruleId: string): Promise<void> {
    this.stop(ruleId);
    await this.store.write((await this.store.read()).filter((rule) => rule.id !== ruleId));
  }

  statuses(): ForwardStatus[] {
    return [
      ...[...this.active.values()].map((forward): ForwardStatus => ({
        ruleId: forward.rule.id,
        sessionId: forward.sessionId,
        state: 'running',
        boundPort: forward.boundPort,
      })),
      ...[...this.errors.values()],
    ];
  }

  async start(
    ruleId: string,
    sessionId: string,
    confirmPublicBind: boolean,
  ): Promise<ForwardStatus> {
    const rule = (await this.store.read()).find((candidate) => candidate.id === ruleId);
    if (!rule) {
      throw new Error('Forwarding rule not found.');
    }
    if (this.active.has(ruleId)) {
      throw new Error('This forwarding rule is already running.');
    }
    if (this.transports.getSessionHostId(sessionId) !== rule.hostId) {
      throw new Error('Start this rule from a connected session of the same host.');
    }
    if (!isLoopbackBind(rule.bindHost) && !confirmPublicBind) {
      throw new Error(
        `Binding to ${rule.bindHost} exposes this tunnel to other machines. Confirm the public bind to continue.`,
      );
    }
    this.errors.delete(ruleId);
    const client = this.transports.getTransport(sessionId);
    const forward =
      rule.type === 'remote'
        ? await this.startRemote(rule, sessionId, client)
        : await this.startListener(rule, sessionId, client);
    this.active.set(ruleId, forward);
    return { ruleId, sessionId, state: 'running', boundPort: forward.boundPort };
  }

  stop(ruleId: string): void {
    const forward = this.active.get(ruleId);
    if (!forward) {
      return;
    }
    this.active.delete(ruleId);
    forward.stop();
    for (const socket of forward.sockets) {
      socket.destroy();
    }
  }

  stopAll(): void {
    for (const ruleId of [...this.active.keys()]) {
      this.stop(ruleId);
    }
  }

  private startListener(
    rule: ForwardRule,
    sessionId: string,
    client: Client,
  ): Promise<ActiveForward> {
    return new Promise((resolve, reject) => {
      const sockets = new Set<Socket>();
      const server: Server = createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.on('error', () => socket.destroy());
        if (rule.type === 'dynamic') {
          void this.handleSocks(client, socket);
        } else {
          this.pipeThroughSsh(client, socket, rule.destHost ?? '', rule.destPort ?? 0);
        }
      });
      server.once('error', (error) => reject(new Error(`Unable to listen: ${error.message}`)));
      server.listen(rule.bindPort, rule.bindHost, () => {
        const address = server.address();
        const boundPort = typeof address === 'object' && address ? address.port : rule.bindPort;
        resolve({ rule, sessionId, boundPort, sockets, stop: () => server.close() });
      });
    });
  }

  private async handleSocks(client: Client, socket: Socket): Promise<void> {
    try {
      const target = await negotiateSocks5(socket);
      this.pipeThroughSsh(client, socket, target.host, target.port, true);
    } catch {
      socket.destroy();
    }
  }

  private pipeThroughSsh(
    client: Client,
    socket: Socket,
    host: string,
    port: number,
    socks = false,
  ): void {
    client.forwardOut(
      socket.remoteAddress ?? '127.0.0.1',
      socket.remotePort ?? 0,
      host,
      port,
      (error, channel) => {
        if (error) {
          if (socks) socks5Reply(socket, false);
          socket.destroy();
          return;
        }
        if (socks) socks5Reply(socket, true);
        socket.pipe(channel).pipe(socket);
        channel.once('close', () => socket.destroy());
        socket.once('close', () => channel.destroy());
      },
    );
  }

  private startRemote(
    rule: ForwardRule,
    sessionId: string,
    client: Client,
  ): Promise<ActiveForward> {
    return new Promise((resolve, reject) => {
      const sockets = new Set<Socket>();
      const onConnection = (
        info: { destIP: string; destPort: number },
        accept: () => import('ssh2').ClientChannel,
        rejectConnection: () => void,
      ): void => {
        if (info.destPort !== rule.bindPort) {
          return;
        }
        const local = createConnection({ host: rule.destHost ?? '', port: rule.destPort ?? 0 });
        local.once('connect', () => {
          const channel = accept();
          sockets.add(local);
          local.pipe(channel).pipe(local);
          channel.once('close', () => local.destroy());
          local.once('close', () => {
            sockets.delete(local);
            channel.destroy();
          });
        });
        local.once('error', () => {
          rejectConnection();
          local.destroy();
        });
      };
      client.on('tcp connection', onConnection);
      client.forwardIn(rule.bindHost, rule.bindPort, (error, boundPort) => {
        if (error) {
          client.off('tcp connection', onConnection);
          reject(new Error('The SSH server refused the remote forward.'));
          return;
        }
        resolve({
          rule,
          sessionId,
          boundPort: boundPort || rule.bindPort,
          sockets,
          stop: () => {
            client.off('tcp connection', onConnection);
            try {
              client.unforwardIn(rule.bindHost, rule.bindPort, () => undefined);
            } catch {
              // Session already closed.
            }
          },
        });
      });
    });
  }
}
