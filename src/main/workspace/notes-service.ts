import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { JsonStore } from '../storage/json-store';
import type { Note, NoteHost, NoteLocation, NoteSummary } from '../../shared/workspace-contract';

export const noteLocationRegistrySchema = z
  .object({ paths: z.array(z.string().min(1).max(2000)).max(50) })
  .strict();
export type NoteLocationRegistry = z.infer<typeof noteLocationRegistrySchema>;

const DEFAULT_LOCATION_ID = 'default';
const MAX_FOLDER_DEPTH = 6;

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'Contains a private key block.'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'Looks like an AWS access key id.'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/, 'Looks like an API token.'],
  [
    /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}/i,
    'Contains a password-like assignment.',
  ],
];

export function findSecretWarnings(text: string): string[] {
  return SECRET_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, message]) => message);
}

export function extractWikilinks(body: string): string[] {
  return [...body.matchAll(/\[\[([^\]\n|]{1,200})(?:\|[^\]\n]*)?\]\]/g)].map((m) =>
    (m[1] ?? '').trim(),
  );
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Reads the optional `server`, `address` and `tags` header; older `hostId` headers are dropped. */
export function parseNote(raw: string): { host?: NoteHost; body: string } {
  const match = FRONT_MATTER.exec(raw);
  if (!match) return { body: raw };
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0)
      fields.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const body = raw.slice(match[0].length);
  const server = fields.get('server');
  if (!server) return { body: fields.has('hostid') ? body : raw };
  const tags = (fields.get('tags') ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  return { host: { server, address: fields.get('address') ?? '', tags }, body };
}

export function serializeNote(body: string, host?: NoteHost): string {
  if (!host) return body;
  const one = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();
  const lines = ['---', `server: ${one(host.server)}`];
  if (host.address) lines.push(`address: ${one(host.address)}`);
  if (host.tags.length > 0) lines.push(`tags: [${host.tags.map(one).join(', ')}]`);
  lines.push('---', '');
  return `${lines.join('\n')}${body}`;
}

function locationId(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 10);
}

function cleanFolder(folder: string): string {
  const normalized = posix.normalize(folder.replaceAll('\\', '/').trim() || '.');
  if (normalized === '.') return '';
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('..') ||
    normalized.includes('\0') ||
    normalized.split('/').some((part) => part === '..')
  ) {
    throw new Error('Folder names must stay inside the chosen notes location.');
  }
  return normalized.replace(/\/$/, '');
}

function cleanName(name: string): string {
  const base = name.trim().replace(/\.md$/i, '').trim();
  if (!base || /[\\/\0]/.test(base) || base === '.' || base === '..') {
    throw new Error('Note names cannot be empty or contain slashes.');
  }
  return base;
}

interface Indexed {
  summary: NoteSummary;
  body: string;
}

/**
 * Plaintext Markdown notes spread over a built-in folder plus any number of
 * folders the user added. The added folders are remembered in a small registry.
 */
export class NotesService {
  private cache: Indexed[] | undefined;

  constructor(
    private readonly defaultRoot: string,
    private readonly registry: JsonStore<NoteLocationRegistry>,
  ) {}

  private async roots(): Promise<{ id: string; name: string; path: string; builtin: boolean }[]> {
    const { paths } = await this.registry.read();
    return [
      { id: DEFAULT_LOCATION_ID, name: 'TunnelNote notes', path: this.defaultRoot, builtin: true },
      ...paths.map((path) => ({
        id: locationId(path),
        name: posix.basename(path.replaceAll('\\', '/')) || path,
        path,
        builtin: false,
      })),
    ];
  }

  private async root(id: string): Promise<string> {
    const found = (await this.roots()).find((candidate) => candidate.id === id);
    if (!found) throw new Error('That notes folder is not in your list anymore.');
    return found.path;
  }

  private async resolveFile(path: string): Promise<string> {
    const normalized = posix.normalize(path.replaceAll('\\', '/'));
    const slash = normalized.indexOf('/');
    const id = slash > 0 ? normalized.slice(0, slash) : '';
    const rel = slash > 0 ? normalized.slice(slash + 1) : '';
    if (!id || !rel || rel.startsWith('..') || rel.includes('\0') || !rel.endsWith('.md')) {
      throw new Error('Note paths must be Markdown files inside a notes folder.');
    }
    const root = resolve(await this.root(id));
    const absolute = resolve(root, rel);
    if (!absolute.startsWith(root + sep)) throw new Error('Note path escapes the notes folder.');
    return absolute;
  }

  async locations(): Promise<NoteLocation[]> {
    const result: NoteLocation[] = [];
    for (const root of await this.roots()) {
      if (root.builtin) await mkdir(root.path, { recursive: true });
      const folders: string[] = [];
      const walk = async (dir: string, prefix: string, depth: number): Promise<boolean> => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return false;
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          folders.push(relative);
          if (depth < MAX_FOLDER_DEPTH) await walk(join(dir, entry.name), relative, depth + 1);
        }
        return true;
      };
      const available = await walk(root.path, '', 1);
      result.push({ ...root, available, folders: folders.sort((a, b) => a.localeCompare(b)) });
    }
    return result;
  }

  async addLocation(path: string): Promise<NoteLocation[]> {
    if (!isAbsolute(path)) throw new Error('Choose a full folder path.');
    const target = resolve(path);
    if (!(await stat(target)).isDirectory()) throw new Error('That path is not a folder.');
    const roots = await this.roots();
    if (!roots.some((root) => resolve(root.path) === target)) {
      const { paths } = await this.registry.read();
      await this.registry.write({ paths: [...paths, target] });
    }
    this.cache = undefined;
    return this.locations();
  }

  /** Forgets a folder; the files stay on disk. */
  async removeLocation(id: string): Promise<NoteLocation[]> {
    if (id === DEFAULT_LOCATION_ID) throw new Error('The built-in notes folder cannot be removed.');
    const { paths } = await this.registry.read();
    await this.registry.write({ paths: paths.filter((path) => locationId(path) !== id) });
    this.cache = undefined;
    return this.locations();
  }

  async createFolder(id: string, name: string): Promise<NoteLocation[]> {
    const folder = cleanFolder(name);
    if (!folder) throw new Error('Enter a folder name.');
    const root = resolve(await this.root(id));
    const absolute = resolve(root, folder);
    if (!absolute.startsWith(root + sep)) throw new Error('Folder escapes the notes location.');
    await mkdir(absolute, { recursive: true });
    return this.locations();
  }

  private async load(): Promise<Indexed[]> {
    if (this.cache) return this.cache;
    const items: Indexed[] = [];
    for (const root of await this.roots()) {
      const walk = async (dir: string, folder: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
          const relative = folder ? `${folder}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(join(dir, entry.name), relative);
          else if (entry.name.endsWith('.md')) {
            const file = join(dir, entry.name);
            const parsed = parseNote(await readFile(file, 'utf8'));
            const name = entry.name.slice(0, -3);
            items.push({
              summary: {
                path: `${root.id}/${relative}`,
                title: name,
                name,
                location: root.id,
                folder,
                host: parsed.host,
                updatedAt: (await stat(file)).mtime.toISOString(),
              },
              body: parsed.body,
            });
          }
        }
      };
      await walk(root.path, '');
    }
    this.cache = items.sort((a, b) => a.summary.path.localeCompare(b.summary.path));
    return this.cache;
  }

  async list(): Promise<NoteSummary[]> {
    return (await this.load()).map((item) => item.summary);
  }

  async read(path: string): Promise<Note> {
    const items = await this.load();
    const item = items.find((candidate) => candidate.summary.path === path);
    if (!item) throw new Error('Note not found.');
    const names = new Set([item.summary.title, item.summary.name].map((n) => n.toLowerCase()));
    const backlinks = items
      .filter(
        (other) =>
          other.summary.path !== path &&
          extractWikilinks(other.body).some((link) => names.has(link.toLowerCase())),
      )
      .map((other) => other.summary.path);
    return {
      ...item.summary,
      body: item.body,
      backlinks,
      secretWarnings: findSecretWarnings(item.body),
    };
  }

  /** Saves a note; `.md` is always added by the app. Renames the file if name or folder changed. */
  async save(request: {
    location: string;
    folder: string;
    name: string;
    body: string;
    host?: NoteHost;
    previousPath?: string;
  }): Promise<Note> {
    const name = cleanName(request.name);
    const folder = cleanFolder(request.folder);
    const path = `${request.location}/${folder ? `${folder}/` : ''}${name}.md`;
    const file = await this.resolveFile(path);
    if (request.previousPath !== path) {
      const exists = await stat(file).then(
        () => true,
        () => false,
      );
      if (exists) throw new Error('A note with this name already exists in that folder.');
    }
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, serializeNote(request.body, request.host), { mode: 0o600 });
    await rename(temporary, file);
    if (request.previousPath && request.previousPath !== path) {
      await rm(await this.resolveFile(request.previousPath), { force: true });
    }
    this.cache = undefined;
    return this.read(path);
  }

  async remove(path: string): Promise<void> {
    await rm(await this.resolveFile(path), { force: true });
    this.cache = undefined;
  }

  async search(query: string): Promise<{ path: string; title: string; snippet: string }[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const results: { score: number; path: string; title: string; snippet: string }[] = [];
    for (const { summary, body } of await this.load()) {
      const meta = `${summary.host?.server ?? ''} ${summary.host?.address ?? ''} ${(summary.host?.tags ?? []).join(' ')}`;
      const lower = `${body}\n${meta}`.toLowerCase();
      const title = summary.title.toLowerCase();
      if (!terms.every((term) => lower.includes(term) || title.includes(term))) continue;
      const index = Math.max(0, body.toLowerCase().indexOf(terms[0] ?? ''));
      results.push({
        score: terms.reduce(
          (sum, term) => sum + (title.includes(term) ? 5 : 0) + lower.split(term).length - 1,
          0,
        ),
        path: summary.path,
        title: summary.title,
        snippet: body.slice(Math.max(0, index - 40), index + 120).replaceAll('\n', ' '),
      });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, 50);
  }
}
