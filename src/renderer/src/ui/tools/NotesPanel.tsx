import { EditorContent, useEditor } from '@tiptap/react';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SshHostSummary } from '../../../../shared/ssh-contract';
import type {
  Note,
  NoteHost,
  NoteLocation,
  NoteSummary,
} from '../../../../shared/workspace-contract';
import { RichToolbar } from './RichToolbar';
import { useAction } from './useAsync';

const TARGET_KEY = 'tunnelnote.notes.target';
const SAVED_HOST = '__saved';

function rememberedTarget(): { location: string; folder: string } {
  try {
    const value = JSON.parse(localStorage.getItem(TARGET_KEY) ?? '{}') as {
      location?: unknown;
      folder?: unknown;
    };
    return {
      location: typeof value.location === 'string' ? value.location : 'default',
      folder: typeof value.folder === 'string' ? value.folder : '',
    };
  } catch {
    return { location: 'default', folder: '' };
  }
}

function todayName(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function NotesPanel() {
  const followLink = useRef<(link: string) => void>(() => undefined);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [locations, setLocations] = useState<NoteLocation[]>([]);
  const [hosts, setHosts] = useState<SshHostSummary[]>([]);
  const [current, setCurrent] = useState<Note | null>(null);
  const [name, setName] = useState('');
  const [location, setLocation] = useState(() => rememberedTarget().location);
  const [folder, setFolder] = useState(() => rememberedTarget().folder);
  const [hostChoice, setHostChoice] = useState('');
  const [savedHost, setSavedHost] = useState<NoteHost | undefined>();
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ path: string; title: string; snippet: string }[]>([]);
  const { error, busy, run, setError } = useAction();

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ underline: false, link: { openOnClick: false } }),
      Markdown,
    ],
    content: '',
    contentType: 'markdown',
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: { 'aria-label': 'Note text', class: 'rich-editor' },
      handleClick: (view, pos) => {
        const $pos = view.state.doc.resolve(pos);
        const text = $pos.parent.textContent;
        for (const match of text.matchAll(/\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g)) {
          const start = match.index ?? 0;
          if ($pos.parentOffset >= start && $pos.parentOffset <= start + match[0].length) {
            followLink.current((match[1] ?? '').trim());
            return true;
          }
        }
        return false;
      },
    },
    onUpdate: () => setDirty(true),
  });

  const refresh = useCallback(async () => {
    setNotes(await window.tunnelNote.listNotes());
    setLocations(await window.tunnelNote.listNoteLocations());
    setHosts(await window.tunnelNote.listSshHosts());
  }, []);
  useEffect(() => {
    void run(refresh);
  }, [refresh, run]);

  const setBody = useCallback(
    (markdown: string) => {
      editor?.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false });
    },
    [editor],
  );

  const activeLocation = locations.find((candidate) => candidate.id === location);

  const linkedHost = ((): NoteHost | undefined => {
    if (hostChoice === SAVED_HOST) return savedHost;
    const host = hosts.find((candidate) => candidate.id === hostChoice);
    return host ? { server: host.name, address: host.hostname, tags: host.tags ?? [] } : undefined;
  })();
  const savedHostMissing =
    savedHost !== undefined &&
    !hosts.some((h) => h.name === savedHost.server && h.hostname === savedHost.address);

  function startNew(): void {
    setCurrent(null);
    setName('');
    setHostChoice('');
    setSavedHost(undefined);
    setBody('');
    setDirty(false);
    setStatus(null);
    setError(null);
  }

  async function open(path: string): Promise<void> {
    await run(async () => {
      const note = await window.tunnelNote.readNote(path);
      setCurrent(note);
      setName(note.name);
      setLocation(note.location);
      setFolder(note.folder);
      setSavedHost(note.host);
      const match = hosts.find(
        (host) => host.name === note.host?.server && host.hostname === note.host.address,
      );
      setHostChoice(match ? match.id : note.host ? SAVED_HOST : '');
      setBody(note.body);
      setDirty(false);
      setStatus(null);
    });
  }

  async function save(): Promise<void> {
    if (!editor) return;
    await run(async () => {
      const note = await window.tunnelNote.saveNote({
        location,
        folder,
        name,
        body: editor.getMarkdown(),
        host: linkedHost,
        previousPath: current?.path,
      });
      setCurrent(note);
      setName(note.name);
      setSavedHost(note.host);
      setDirty(false);
      setStatus('Saved');
      localStorage.setItem(TARGET_KEY, JSON.stringify({ location, folder }));
      await refresh();
    });
  }

  async function createFolder(): Promise<void> {
    const wanted = (newFolder ?? '').trim();
    if (!wanted) return;
    await run(async () => {
      const path = `${folder ? `${folder}/` : ''}${wanted}`;
      setLocations(await window.tunnelNote.createNoteFolder(location, path));
      setFolder(path.replace(/\/+$/, ''));
      setNewFolder(null);
    });
  }

  async function addLocation(): Promise<void> {
    await run(async () => {
      await window.tunnelNote.addNoteLocation();
      await refresh();
    });
  }

  async function removeLocation(id: string): Promise<void> {
    await run(async () => {
      await window.tunnelNote.removeNoteLocation(id);
      if (location === id) setLocation('default');
      await refresh();
    });
  }

  async function openOrCreate(link: string): Promise<void> {
    const wanted = link.toLowerCase();
    const target = notes.find(
      (n) => n.title.toLowerCase() === wanted || n.name.toLowerCase() === wanted,
    );
    if (target) {
      await open(target.path);
      return;
    }
    await run(async () => {
      const created = await window.tunnelNote.saveNote({ location, folder, name: link, body: '' });
      await refresh();
      setCurrent(created);
      setName(created.name);
      setBody('');
      setDirty(false);
      setStatus('Created from link');
    });
  }
  followLink.current = (link) => void openOrCreate(link);

  async function openDaily(): Promise<void> {
    const day = todayName();
    const existing = notes.find(
      (n) => n.location === location && n.path.endsWith(`/Daily/${day}.md`),
    );
    if (existing) {
      await open(existing.path);
      return;
    }
    await run(async () => {
      const created = await window.tunnelNote.saveNote({
        location,
        folder: 'Daily',
        name: day,
        body: `# ${day}\n`,
      });
      await refresh();
      setFolder('Daily');
      setCurrent(created);
      setName(created.name);
      setBody(created.body);
      setDirty(false);
      setStatus('Daily note created');
    });
  }

  function startNewIn(loc: string, where: string): void {
    startNew();
    setLocation(loc);
    setFolder(where);
  }

  function toggle(key: string): void {
    setCollapsed((currentSet) => {
      const next = new Set(currentSet);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function renderFolder(loc: NoteLocation, path: string, depth: number): React.ReactNode {
    const key = `${loc.id}|${path}`;
    const children = loc.folders.filter(
      (f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '') === path,
    );
    const files = notes.filter((n) => n.location === loc.id && n.folder === path);
    const isOpen = path === '' || !collapsed.has(key);
    const selected = location === loc.id && folder === path;
    return (
      <div key={key}>
        {path === '' ? null : (
          <div
            className={`tree-row${selected ? ' selected' : ''}`}
            style={{ paddingLeft: `${depth * 0.9}rem` }}
          >
            <button
              className="tree-label"
              onClick={() => {
                toggle(key);
                setLocation(loc.id);
                setFolder(path);
              }}
              type="button"
            >
              {isOpen ? '▾' : '▸'} 📁 {path.slice(path.lastIndexOf('/') + 1)}
            </button>
            <button
              aria-label={`New note in ${path}`}
              className="tree-action"
              onClick={() => startNewIn(loc.id, path)}
              title="New note here"
              type="button"
            >
              +
            </button>
          </div>
        )}
        {isOpen ? (
          <>
            {children.map((child) => renderFolder(loc, child, depth + 1))}
            {files.map((n) => (
              <div
                className="tree-row"
                key={n.path}
                style={{ paddingLeft: `${(depth + 1) * 0.9}rem` }}
              >
                <button
                  className={`tree-label note-item${current?.path === n.path ? ' active' : ''}`}
                  onClick={() => void open(n.path)}
                  title={n.host ? `${n.host.server}` : n.path}
                  type="button"
                >
                  📄 {n.title}
                </button>
              </div>
            ))}
          </>
        ) : null}
      </div>
    );
  }

  const grouped = useMemo(() => {
    const byLocation = new Map<string, NoteSummary[]>();
    for (const note of notes) {
      byLocation.set(note.location, [...(byLocation.get(note.location) ?? []), note]);
    }
    return byLocation;
  }, [notes]);

  const body = editor?.getMarkdown() ?? '';
  const wikiLinks = [...body.matchAll(/\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g)].map((m) =>
    (m[1] ?? '').trim(),
  );

  const noteButton = (n: { path: string; title: string }) => (
    <button
      className={`note-item${current?.path === n.path ? ' active' : ''}`}
      onClick={() => void open(n.path)}
      type="button"
    >
      {n.title}
    </button>
  );

  return (
    <section className="tool-panel notes-layout" aria-label="Notes">
      <aside className="notes-side">
        <div className="notes-side-head">
          <h2>Notes</h2>
          <span className="note-head-actions">
            <button className="secondary-button compact" onClick={startNew} type="button">
              + Note
            </button>
            <button
              className="secondary-button compact"
              onClick={() => void openDaily()}
              title="Open or create today's note"
              type="button"
            >
              Today
            </button>
          </span>
        </div>
        <input
          aria-label="Search notes"
          placeholder="Search notes"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            void run(async () => setHits(await window.tunnelNote.searchNotes(e.target.value)));
          }}
        />
        {query ? (
          <ul className="note-list">
            {hits.length === 0 ? <li className="hint">No matches.</li> : null}
            {hits.map((n) => (
              <li key={n.path}>
                {noteButton(n)}
                <small>{n.snippet}</small>
              </li>
            ))}
          </ul>
        ) : (
          <div className="note-groups">
            {locations.map((loc) => (
              <div className="note-group" key={loc.id}>
                <div className="note-group-head" title={loc.path}>
                  <button
                    className="tree-label"
                    onClick={() => {
                      toggle(`${loc.id}|`);
                      setLocation(loc.id);
                      setFolder('');
                    }}
                    type="button"
                  >
                    {collapsed.has(`${loc.id}|`) ? '▸' : '▾'} <strong>{loc.name}</strong>
                  </button>
                  <button
                    aria-label={`New note in ${loc.name}`}
                    className="tree-action"
                    onClick={() => startNewIn(loc.id, '')}
                    title="New note at the top level"
                    type="button"
                  >
                    +
                  </button>
                  {loc.builtin ? null : (
                    <button
                      aria-label={`Remove ${loc.name} from the list`}
                      className="icon-button"
                      onClick={() => void removeLocation(loc.id)}
                      title="Remove from list (files stay on disk)"
                      type="button"
                    >
                      ×
                    </button>
                  )}
                </div>
                {!loc.available ? <p className="hint">Folder not found on disk.</p> : null}
                {collapsed.has(`${loc.id}|`) ? null : renderFolder(loc, '', 0)}
                {(grouped.get(loc.id) ?? []).length === 0 && loc.available ? (
                  <p className="hint">No notes yet.</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <button
          className="secondary-button compact"
          onClick={() => void addLocation()}
          type="button"
        >
          Open folder as vault…
        </button>
      </aside>

      <div className="notes-editor">
        <div className="note-meta">
          <label className="note-field note-name">
            <span>Name</span>
            <span className="note-name-input">
              <input
                aria-label="Note name"
                placeholder="e.g. Router setup"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setDirty(true);
                }}
              />
              <em>.md</em>
            </span>
          </label>
          <label className="note-field">
            <span>Save in</span>
            <span className="note-folder-row">
              <select
                aria-label="Save in"
                value={`${location}|${folder}`}
                onChange={(e) => {
                  const [loc, ...rest] = e.target.value.split('|');
                  setLocation(loc ?? 'default');
                  setFolder(rest.join('|'));
                  setDirty(true);
                }}
              >
                {locations.flatMap((loc) => [
                  <option key={`${loc.id}|`} value={`${loc.id}|`}>
                    {loc.name}
                  </option>,
                  ...loc.folders.map((f) => (
                    <option key={`${loc.id}|${f}`} value={`${loc.id}|${f}`}>
                      {loc.name} / {f}
                    </option>
                  )),
                ])}
              </select>
              <button
                className="secondary-button compact"
                onClick={() => setNewFolder(newFolder === null ? '' : null)}
                type="button"
              >
                New folder
              </button>
            </span>
          </label>
          <label className="note-field">
            <span>Linked server</span>
            <select
              aria-label="Linked server"
              value={hostChoice}
              onChange={(e) => {
                setHostChoice(e.target.value);
                setDirty(true);
              }}
            >
              <option value="">None</option>
              {savedHost && savedHostMissing ? (
                <option value={SAVED_HOST}>
                  {savedHost.server}
                  {savedHost.address ? ` — ${savedHost.address}` : ''}
                </option>
              ) : null}
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} — {h.hostname}
                </option>
              ))}
            </select>
          </label>
        </div>
        {newFolder !== null ? (
          <div className="note-inline">
            <input
              aria-label="New folder name"
              autoFocus
              placeholder={`New folder inside ${folder || (activeLocation?.name ?? 'location')}`}
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createFolder();
              }}
            />
            <button disabled={!newFolder.trim()} onClick={() => void createFolder()} type="button">
              Create folder
            </button>
          </div>
        ) : null}
        {linkedHost ? (
          <p className="hint note-host-line">
            Saved in the note: server <strong>{linkedHost.server}</strong>
            {linkedHost.address ? ` · ${linkedHost.address}` : ''}
            {linkedHost.tags.length > 0 ? ` · tags: ${linkedHost.tags.join(', ')}` : ''}
          </p>
        ) : null}

        <RichToolbar editor={editor} />
        <EditorContent className="rich-editor-wrap" editor={editor} />

        <div className="button-row">
          <button disabled={busy || !name.trim()} onClick={() => void save()} type="button">
            Save note
          </button>
          {current ? (
            <button
              className="danger-button"
              onClick={() =>
                void run(async () => {
                  await window.tunnelNote.deleteNote(current.path);
                  startNew();
                  await refresh();
                })
              }
              type="button"
            >
              Delete
            </button>
          ) : null}
          <span className="hint">
            {dirty ? 'Unsaved changes' : (status ?? '')}
            {current
              ? ` · ${activeLocation?.name ?? ''}/${current.folder ? `${current.folder}/` : ''}${current.name}.md`
              : ''}
          </span>
        </div>
        {(current?.secretWarnings.length ?? 0) > 0 ? (
          <p className="status status-error" role="alert">
            ⚠ Secret warning: {current?.secretWarnings.join(' ')} Notes are plaintext.
          </p>
        ) : (
          <p className="hint">Notes are plain Markdown files — do not put secrets in them.</p>
        )}
        {wikiLinks.length > 0 ? (
          <p className="hint">
            Links:{' '}
            {wikiLinks.map((l) => {
              const target = notes.find(
                (n) =>
                  n.title.toLowerCase() === l.toLowerCase() ||
                  n.name.toLowerCase() === l.toLowerCase(),
              );
              return target ? (
                <button
                  className="link-button"
                  key={l}
                  onClick={() => void open(target.path)}
                  type="button"
                >
                  [[{l}]]
                </button>
              ) : (
                <button
                  className="link-button"
                  key={l}
                  onClick={() => void openOrCreate(l)}
                  title="Create this note"
                  type="button"
                >
                  [[{l}]] (create)
                </button>
              );
            })}
          </p>
        ) : null}
        {current && current.backlinks.length > 0 ? (
          <p className="hint">
            Backlinks:{' '}
            {current.backlinks.map((b) => (
              <button className="link-button" key={b} onClick={() => void open(b)} type="button">
                {notes.find((n) => n.path === b)?.title ?? b}
              </button>
            ))}
          </p>
        ) : null}
        {error ? (
          <p className="status status-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
