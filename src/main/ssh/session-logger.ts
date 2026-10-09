import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { AppSettings } from '../../shared/settings-contract';

export interface SessionLogSink {
  begin(sessionId: string, hostName: string): void;
  write(sessionId: string, text: string): void;
  end(sessionId: string): void;
}

interface Active {
  host: string;
  stream: WriteStream;
  prefix: boolean;
  /** Present when ANSI stripping is on: rebuilds readable lines from terminal redraws. */
  model: LineModel | undefined;
  pending: string;
}

/**
 * Minimal line-oriented terminal model. Shells redraw the prompt with carriage
 * returns, backspaces and erase sequences; replaying them gives a readable transcript.
 */
export class LineModel {
  private chars: string[] = [];
  private cursor = 0;
  private escape = '';

  /** Feeds text and returns the completed lines. */
  feed(text: string): string[] {
    const lines: string[] = [];
    for (const char of text) {
      if (this.escape) {
        this.escape += char;
        if (this.escape.length === 2 && char !== '[' && char !== ']') {
          this.escape = ''; // two-character escape such as ESC = or ESC >
        } else if (this.escape.startsWith('\u001b]')) {
          if (char === '\u0007' || this.escape.endsWith('\u001b\\')) this.escape = '';
        } else if (this.escape.length > 2 && /[@-~]/.test(char)) {
          this.csi(this.escape.slice(2, -1), char);
          this.escape = '';
        } else if (this.escape.length > 64) {
          this.escape = '';
        }
        continue;
      }
      if (char === '\u001b') this.escape = char;
      else if (char === '\n') {
        lines.push(this.chars.join('').trimEnd());
        this.chars = [];
        this.cursor = 0;
      } else if (char === '\r') this.cursor = 0;
      else if (char === '\b') this.cursor = Math.max(0, this.cursor - 1);
      else if (char === '\t') this.put(' ');
      else if (char >= ' ' && char !== '\u007f') this.put(char);
    }
    return lines;
  }

  flush(): string | undefined {
    const line = this.chars.join('').trimEnd();
    this.chars = [];
    this.cursor = 0;
    return line || undefined;
  }

  private put(char: string): void {
    this.chars[this.cursor] = char;
    this.cursor += 1;
  }

  private csi(params: string, final: string): void {
    const n = Math.max(1, Number.parseInt(params.replace(/[^0-9;].*$/, ''), 10) || 1);
    if (final === 'C') {
      while (this.chars.length < this.cursor + n) this.chars.push(' ');
      this.cursor += n;
    } else if (final === 'D') this.cursor = Math.max(0, this.cursor - n);
    else if (final === 'G') this.cursor = Math.max(0, n - 1);
    else if (final === 'P') this.chars.splice(this.cursor, n);
    else if (final === '@') this.chars.splice(this.cursor, 0, ...Array<string>(n).fill(' '));
    else if (final === 'K') {
      const mode = Number.parseInt(params, 10) || 0;
      if (mode === 0) this.chars.length = Math.min(this.chars.length, this.cursor);
      else if (mode === 1) for (let i = 0; i < this.cursor; i += 1) this.chars[i] = ' ';
      else this.chars = [];
    }
  }
}

export function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^[._]+|[._]+$/g, '')
      .slice(0, 60) || 'session'
  );
}

export function stamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  return `${day}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Writes terminal output (never keystrokes) of SSH sessions to log files. */
export class SessionLogger implements SessionLogSink {
  private readonly active = new Map<string, Active>();
  private readonly names = new Map<string, string>();
  private shared: WriteStream | undefined;

  constructor(
    private readonly getSettings: () => AppSettings,
    private readonly resolveDirectory: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  begin(sessionId: string, hostName: string): void {
    this.names.set(sessionId, hostName);
    this.start(sessionId);
  }

  /** Opens the log for a session if logging is on; also picks up sessions that were already open. */
  private start(sessionId: string): Active | undefined {
    const hostName = this.names.get(sessionId);
    const { sessionLogging } = this.getSettings();
    if (hostName === undefined || !sessionLogging.enabled) {
      return undefined;
    }
    const directory = this.resolveDirectory();
    const single = sessionLogging.mode === 'single';
    const fileName = single
      ? 'tunnelnote-sessions.log'
      : `${sanitizeFileName(hostName)}-${stamp(this.now())}-${sessionId.slice(0, 4)}.log`;
    try {
      mkdirSync(directory, { recursive: true });
    } catch {
      return undefined;
    }
    let stream: WriteStream;
    if (single) {
      this.shared ??= this.open(join(directory, fileName));
      stream = this.shared;
    } else {
      stream = this.open(join(directory, fileName));
    }
    stream.write(`=== ${this.now().toISOString()} session started: ${hostName} ===\n`);
    const entry: Active = {
      host: hostName,
      stream,
      pending: '',
      prefix: single,
      model: sessionLogging.stripAnsi ? new LineModel() : undefined,
    };
    this.active.set(sessionId, entry);
    return entry;
  }

  write(sessionId: string, text: string): void {
    const enabled = this.getSettings().sessionLogging.enabled;
    let entry = this.active.get(sessionId);
    if (entry && !enabled) {
      this.stop(sessionId);
      entry = undefined;
    }
    entry ??= enabled ? this.start(sessionId) : undefined;
    if (!entry) {
      return;
    }
    if (entry.model) {
      for (const line of entry.model.feed(text)) {
        this.emitLine(entry, line);
      }
      return;
    }
    const lines = (entry.pending + text.replace(/\r\n?/g, '\n')).split('\n');
    entry.pending = lines.pop() ?? '';
    for (const line of lines) {
      this.emitLine(entry, line);
    }
  }

  end(sessionId: string): void {
    this.stop(sessionId);
    this.names.delete(sessionId);
  }

  closeAll(): void {
    for (const id of [...this.active.keys()]) {
      this.end(id);
    }
  }

  private emitLine(entry: Active, line: string): void {
    entry.stream.write(entry.prefix ? `[${entry.host}] ${line}\n` : `${line}\n`);
  }

  private stop(sessionId: string): void {
    const entry = this.active.get(sessionId);
    if (!entry) {
      return;
    }
    this.active.delete(sessionId);
    const rest = entry.model ? entry.model.flush() : entry.pending;
    if (rest) {
      this.emitLine(entry, rest);
    }
    entry.stream.write(`=== ${this.now().toISOString()} session ended: ${entry.host} ===\n`);
    if (entry.stream === this.shared) {
      if (![...this.active.values()].some((other) => other.stream === this.shared)) {
        this.shared.end();
        this.shared = undefined;
      }
    } else {
      entry.stream.end();
    }
  }

  private open(path: string): WriteStream {
    const stream = createWriteStream(path, { flags: 'a', mode: 0o600 });
    stream.on('error', () => undefined);
    return stream;
  }
}
