import {
  siAlpinelinux,
  siApple,
  siArchlinux,
  siCentos,
  siDebian,
  siFedora,
  siFreebsd,
  siKalilinux,
  siLinux,
  siLinuxmint,
  siOpensuse,
  siRaspberrypi,
  siRedhat,
  siUbuntu,
} from 'simple-icons';
import type { HostOs } from '../../../shared/ssh-contract';

export const OS_OPTIONS: ReadonlyArray<readonly [HostOs, string]> = [
  ['linux', 'Linux (generic)'],
  ['ubuntu', 'Ubuntu'],
  ['debian', 'Debian'],
  ['fedora', 'Fedora'],
  ['arch', 'Arch Linux'],
  ['centos', 'CentOS'],
  ['redhat', 'Red Hat'],
  ['opensuse', 'openSUSE'],
  ['alpine', 'Alpine Linux'],
  ['mint', 'Linux Mint'],
  ['kali', 'Kali Linux'],
  ['raspberrypi', 'Raspberry Pi'],
  ['windows', 'Windows'],
  ['macos', 'macOS'],
  ['freebsd', 'FreeBSD'],
  ['other', 'Other / generic'],
];

interface Glyph {
  bg: string;
  path: string;
}

// Logo paths come from the CC0 "simple-icons" package; the Windows mark is a simple 4-pane glyph.
const WINDOWS_PATH =
  'M2 3.6 10.6 2.4v8.2H2zM11.7 2.3 22 .8v9.8H11.7zM2 11.7h8.6v8.2L2 18.7zM11.7 11.7H22v11.5l-10.3-1.4z';

const GLYPHS: Record<HostOs, Glyph> = {
  linux: { bg: '#3a3f47', path: siLinux.path },
  ubuntu: { bg: '#e95420', path: siUbuntu.path },
  debian: { bg: '#c70a54', path: siDebian.path },
  fedora: { bg: '#3c6eb4', path: siFedora.path },
  arch: { bg: '#1793d1', path: siArchlinux.path },
  centos: { bg: '#262577', path: siCentos.path },
  redhat: { bg: '#cc0000', path: siRedhat.path },
  opensuse: { bg: '#4f9e1f', path: siOpensuse.path },
  alpine: { bg: '#0d597f', path: siAlpinelinux.path },
  mint: { bg: '#5a8f2a', path: siLinuxmint.path },
  kali: { bg: '#3e5a7a', path: siKalilinux.path },
  raspberrypi: { bg: '#bc1142', path: siRaspberrypi.path },
  windows: { bg: '#0f78d4', path: WINDOWS_PATH },
  macos: { bg: '#2fb7c9', path: siApple.path },
  freebsd: { bg: '#a5322b', path: siFreebsd.path },
  other: { bg: '#4b6272', path: '' },
};

export function OsIcon({ os, size = 44 }: { os?: HostOs | undefined; size?: number }) {
  const glyph = GLYPHS[os ?? 'other'];
  return (
    <span
      aria-hidden
      className="os-icon"
      style={{ background: glyph.bg, width: size, height: size }}
    >
      {glyph.path ? (
        <svg fill="currentColor" height={size * 0.56} viewBox="0 0 24 24" width={size * 0.56}>
          <path d={glyph.path} />
        </svg>
      ) : (
        <svg
          fill="none"
          height={size * 0.5}
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width={size * 0.5}
        >
          <rect height="7" rx="2" width="18" x="3" y="3" />
          <rect height="7" rx="2" width="18" x="3" y="14" />
          <path d="M7 6.5h.01M7 17.5h.01" />
        </svg>
      )}
    </span>
  );
}
