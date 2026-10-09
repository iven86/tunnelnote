import { randomUUID } from 'node:crypto';
import type { Client } from 'ssh2';
import type { RunResult } from '../../shared/workspace-contract';

const MAX_OUTPUT = 256 * 1024;
const SAFE_VALUE = /^[\w@%+=:,./-]*$/;

export function templateVariables(command: string): string[] {
  const names = new Set<string>();
  for (const match of command.matchAll(/\{\{\s*prompt:([A-Za-z_][\w-]{0,63})\s*\}\}/g)) {
    names.add(match[1] ?? '');
  }
  return [...names];
}

function shellQuote(value: string): string {
  return SAFE_VALUE.test(value) && value !== '' ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Renders {{host}}, {{user}} and {{prompt:name}}. Substituted values are always shell-quoted. */
export function renderSnippet(
  command: string,
  context: { host: string; user: string },
  variables: Record<string, string>,
): string {
  return command
    .replace(/\{\{\s*host\s*\}\}/g, () => shellQuote(context.host))
    .replace(/\{\{\s*user\s*\}\}/g, () => shellQuote(context.user))
    .replace(/\{\{\s*prompt:([A-Za-z_][\w-]{0,63})\s*\}\}/g, (_match, name: string) => {
      const value = variables[name];
      if (value === undefined) {
        throw new Error(`Missing value for variable "${name}".`);
      }
      return shellQuote(value);
    });
}

export function runOnClient(
  client: Client,
  sessionId: string,
  hostName: string,
  command: string,
  timeoutSeconds: number,
): Promise<RunResult> {
  const startedAt = new Date();
  const base = { sessionId, hostName, command, startedAt: startedAt.toISOString() };
  return new Promise((resolve) => {
    let output = '';
    let done = false;
    let closeStream: (() => void) | undefined;
    const finish = (partial: Partial<RunResult>): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        ...base,
        exitCode: null,
        timedOut: false,
        output,
        durationMs: Date.now() - startedAt.getTime(),
        ...partial,
      });
    };
    const timer = setTimeout(() => {
      closeStream?.();
      finish({ timedOut: true, error: 'Timed out.' });
    }, timeoutSeconds * 1000);
    client.exec(command, (error, stream) => {
      if (error) {
        finish({ error: 'The server refused to run the command.' });
        return;
      }
      const append = (data: Buffer): void => {
        if (output.length < MAX_OUTPUT) output += data.toString('utf8');
      };
      stream.on('data', append);
      stream.stderr.on('data', append);
      stream.once('close', (code: number | null) => finish({ exitCode: code }));
      closeStream = () => stream.close();
    });
  });
}

export function resultsToMarkdown(results: RunResult[]): string {
  const rows = results.map(
    (result) =>
      `| ${result.hostName} | ${result.exitCode ?? '—'} | ${result.timedOut ? 'yes' : 'no'} | ${result.durationMs} ms |`,
  );
  const details = results.map(
    (result) =>
      `### ${result.hostName}\n\n\`\`\`\n${result.output.replaceAll('```', '` ` `')}${result.error ? `\n[${result.error}]` : ''}\n\`\`\``,
  );
  return `# Command results\n\n| Host | Exit | Timed out | Duration |\n|---|---|---|---|\n${rows.join('\n')}\n\n${details.join('\n\n')}\n`;
}

export function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replaceAll('"', '""')}"`;
}

export function resultsToCsv(results: RunResult[]): string {
  const lines = ['host,exit_code,timed_out,duration_ms,output'].concat(
    results.map((result) =>
      [
        csvCell(result.hostName),
        String(result.exitCode ?? ''),
        String(result.timedOut),
        String(result.durationMs),
        csvCell(result.output),
      ].join(','),
    ),
  );
  return `${lines.join('\n')}\n`;
}

export function newId(): string {
  return randomUUID();
}
