import type { RunResult } from '../../shared/workspace-contract';

const MAX_ENTRIES = 1000;

/** Opt-in, in-memory command history. It is never written to disk. */
export class CommandHistory {
  private enabled = false;
  private entries: RunResult[] = [];

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.entries = [];
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  record(results: RunResult[]): void {
    if (!this.enabled) return;
    this.entries = [...results, ...this.entries].slice(0, MAX_ENTRIES);
  }

  search(query: string): RunResult[] {
    const needle = query.trim().toLowerCase();
    return this.entries.filter(
      (entry) =>
        !needle ||
        entry.command.toLowerCase().includes(needle) ||
        entry.hostName.toLowerCase().includes(needle),
    );
  }
}
