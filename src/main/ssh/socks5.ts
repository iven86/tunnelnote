import type { Socket } from 'node:net';

export interface SocksTarget {
  host: string;
  port: number;
}

/** Minimal SOCKS5 (no auth, CONNECT only) handshake. Resolves with the requested target. */
export function negotiateSocks5(socket: Socket): Promise<SocksTarget> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let stage: 'greeting' | 'request' = 'greeting';
    const fail = (error: Error): void => {
      socket.off('data', onData);
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 600) {
        fail(new Error('SOCKS request too large.'));
        return;
      }
      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 5) return fail(new Error('Only SOCKS5 is supported.'));
        const count = buffer[1] ?? 0;
        if (buffer.length < 2 + count) return;
        if (!buffer.subarray(2, 2 + count).includes(0)) {
          socket.write(Buffer.from([5, 0xff]));
          return fail(new Error('SOCKS client requires authentication.'));
        }
        socket.write(Buffer.from([5, 0]));
        buffer = buffer.subarray(2 + count);
        stage = 'request';
      }
      if (stage === 'request') {
        if (buffer.length < 7) return;
        if (buffer[0] !== 5 || buffer[1] !== 1) {
          socket.write(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
          return fail(new Error('Only SOCKS5 CONNECT is supported.'));
        }
        const type = buffer[3];
        let host: string;
        let offset: number;
        if (type === 1) {
          if (buffer.length < 10) return;
          host = [...buffer.subarray(4, 8)].join('.');
          offset = 8;
        } else if (type === 3) {
          const length = buffer[4] ?? 0;
          if (buffer.length < 5 + length + 2) return;
          host = buffer.subarray(5, 5 + length).toString('utf8');
          offset = 5 + length;
        } else if (type === 4) {
          if (buffer.length < 22) return;
          const parts: string[] = [];
          for (let index = 4; index < 20; index += 2) {
            parts.push(buffer.readUInt16BE(index).toString(16));
          }
          host = parts.join(':');
          offset = 20;
        } else {
          socket.write(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
          return fail(new Error('Unsupported SOCKS address type.'));
        }
        const port = buffer.readUInt16BE(offset);
        socket.off('data', onData);
        resolve({ host, port });
      }
    };
    socket.on('data', onData);
    socket.once('error', fail);
  });
}

export function socks5Reply(socket: Socket, ok: boolean): void {
  socket.write(Buffer.from([5, ok ? 0 : 5, 0, 1, 0, 0, 0, 0, 0, 0]));
}
