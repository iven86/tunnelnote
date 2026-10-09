import type { Editor } from '@tiptap/react';
import { useState } from 'react';

interface Props {
  editor: Editor | null;
}

/** Formatting buttons for the note editor; the result is saved as Markdown. */
export function RichToolbar({ editor }: Props) {
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  if (!editor) return null;

  const chain = () => editor.chain().focus();
  const items: { label: string; title: string; active?: boolean; run: () => void }[] = [
    {
      label: 'B',
      title: 'Bold',
      active: editor.isActive('bold'),
      run: () => chain().toggleBold().run(),
    },
    {
      label: 'I',
      title: 'Italic',
      active: editor.isActive('italic'),
      run: () => chain().toggleItalic().run(),
    },
    {
      label: 'S',
      title: 'Strikethrough',
      active: editor.isActive('strike'),
      run: () => chain().toggleStrike().run(),
    },
    {
      label: '</>',
      title: 'Inline code',
      active: editor.isActive('code'),
      run: () => chain().toggleCode().run(),
    },
    {
      label: 'H1',
      title: 'Heading 1',
      active: editor.isActive('heading', { level: 1 }),
      run: () => chain().toggleHeading({ level: 1 }).run(),
    },
    {
      label: 'H2',
      title: 'Heading 2',
      active: editor.isActive('heading', { level: 2 }),
      run: () => chain().toggleHeading({ level: 2 }).run(),
    },
    {
      label: 'H3',
      title: 'Heading 3',
      active: editor.isActive('heading', { level: 3 }),
      run: () => chain().toggleHeading({ level: 3 }).run(),
    },
    {
      label: '• List',
      title: 'Bulleted list',
      active: editor.isActive('bulletList'),
      run: () => chain().toggleBulletList().run(),
    },
    {
      label: '1. List',
      title: 'Numbered list',
      active: editor.isActive('orderedList'),
      run: () => chain().toggleOrderedList().run(),
    },
    {
      label: '❝',
      title: 'Quote',
      active: editor.isActive('blockquote'),
      run: () => chain().toggleBlockquote().run(),
    },
    {
      label: '{ }',
      title: 'Code block',
      active: editor.isActive('codeBlock'),
      run: () => chain().toggleCodeBlock().run(),
    },
    {
      label: '—',
      title: 'Divider',
      run: () => chain().setHorizontalRule().run(),
    },
    {
      label: 'Link',
      title: 'Link',
      active: editor.isActive('link'),
      run: () => setLinkUrl(editor.getAttributes('link').href ?? ''),
    },
    { label: '↶', title: 'Undo', run: () => chain().undo().run() },
    { label: '↷', title: 'Redo', run: () => chain().redo().run() },
  ];

  function applyLink(): void {
    const url = (linkUrl ?? '').trim();
    if (!url) chain().extendMarkRange('link').unsetLink().run();
    else chain().extendMarkRange('link').setLink({ href: url }).run();
    setLinkUrl(null);
  }

  return (
    <div className="rich-toolbar" role="toolbar" aria-label="Text formatting">
      {items.map((item) => (
        <button
          aria-pressed={item.active ?? false}
          className={`rich-button${item.active ? ' active' : ''}`}
          key={item.title}
          onClick={item.run}
          onMouseDown={(event) => event.preventDefault()}
          title={item.title}
          type="button"
        >
          {item.label}
        </button>
      ))}
      {linkUrl !== null ? (
        <span className="rich-link">
          <input
            aria-label="Link address"
            autoFocus
            placeholder="https://… (empty removes the link)"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyLink();
              if (e.key === 'Escape') setLinkUrl(null);
            }}
          />
          <button className="rich-button" onClick={applyLink} type="button">
            Apply
          </button>
        </span>
      ) : null}
    </div>
  );
}
