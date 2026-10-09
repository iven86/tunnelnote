export type TabIconName =
  'vaults' | 'hosts' | 'tunnels' | 'snippets' | 'notes' | 'settings' | 'terminal';

const PATHS: Record<TabIconName, string> = {
  vaults: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5zM12 15v2',
  hosts: 'M3 5h18v6H3zM3 13h18v6H3zM7 8h.01M7 16h.01',
  tunnels: 'M3 20V11a9 9 0 0 1 18 0v9M8 20v-8a4 4 0 0 1 8 0v8',
  snippets: 'M8 7 3 12l5 5M16 7l5 5-5 5M14 4l-4 16',
  notes: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  terminal: 'M3 5h18v14H3zM7 10l3 2-3 2M12 15h5',
};

export function TabIcon({ name, size = 16 }: { name: TabIconName; size?: number }) {
  return (
    <svg
      aria-hidden
      className="tab-icon"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
