import type { TunnelNoteApi } from './index';

declare global {
  interface Window {
    tunnelNote: TunnelNoteApi;
  }
}

export {};
