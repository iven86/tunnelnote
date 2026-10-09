import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { SshHostSummary, UpsertSshHostRequest } from '../../shared/ssh-contract';
import type { VaultEntry, VaultState, VaultsState } from '../../shared/vault-contract';
import { VaultService, type SshHostCredentials } from './vault-service';

export const MAX_OPEN_VAULTS = 8;

interface HubEntry {
  id: string;
  path: string;
  service: VaultService;
  hostIds: string[];
}

type VaultFactory = () => VaultService;

/**
 * Holds several independent vaults at once. Each vault keeps its own encryption,
 * idle timer and file; the hub routes host operations to the right one.
 */
export class VaultHub {
  private readonly entries = new Map<string, HubEntry>();
  private activeId: string | null = null;
  private idleLockMs: number | undefined;
  private readonly listeners = new Set<(state: VaultState) => void>();
  private readonly changeListeners = new Set<(state: VaultsState) => void>();
  private readonly lockListeners = new Set<(vaultId: string, hostIds: string[]) => void>();

  constructor(private readonly factory: VaultFactory = () => new VaultService()) {}

  getVaultsState(): VaultsState {
    const vaults: VaultEntry[] = [...this.entries.values()].map((entry) => {
      const state = entry.service.getState();
      return {
        id: entry.id,
        name: basename(entry.path),
        status: state.status,
      };
    });
    return { vaults, activeId: this.activeId };
  }

  /** Aggregate state used by code that only cares whether any vault is usable. */
  getState(): VaultState {
    const unlocked = this.unlocked();
    const active = this.activeId ? this.entries.get(this.activeId) : undefined;
    return {
      status: unlocked.length > 0 ? 'unlocked' : 'locked',
      name: active ? basename(active.path) : null,
    };
  }

  subscribe(listener: (state: VaultState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onChange(listener: (state: VaultsState) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onVaultLocked(listener: (vaultId: string, hostIds: string[]) => void): () => void {
    this.lockListeners.add(listener);
    return () => this.lockListeners.delete(listener);
  }

  async create(path: string, password: string): Promise<VaultsState> {
    this.assertNotOpen(path);
    const service = this.newService();
    await service.create(path, password);
    return this.register(path, service);
  }

  async open(path: string, password: string): Promise<VaultsState> {
    this.assertNotOpen(path);
    const service = this.newService();
    await service.open(path, password);
    return this.register(path, service);
  }

  async unlock(id: string, password: string): Promise<VaultsState> {
    const entry = this.requireEntry(id);
    if (entry.service.getState().status === 'unlocked') {
      return this.getVaultsState();
    }
    await entry.service.open(entry.path, password);
    this.activeId = id;
    this.emitChange();
    return this.getVaultsState();
  }

  /** Paths of the open vaults and the default one, for remembering across restarts. */
  getPersistable(): { paths: string[]; defaultPath: string | null } {
    const entries = [...this.entries.values()];
    return {
      paths: entries.map((entry) => entry.path),
      defaultPath: entries.find((entry) => entry.id === this.activeId)?.path ?? null,
    };
  }

  /** Re-adds remembered vaults as locked entries; the user unlocks them with a password. */
  restore(paths: string[], defaultPath: string | null): void {
    for (const path of paths.slice(0, MAX_OPEN_VAULTS)) {
      if (![...this.entries.values()].some((entry) => entry.path === path)) {
        this.register(path, this.newService(), true);
      }
    }
    const target = [...this.entries.values()].find((entry) => entry.path === defaultPath);
    this.activeId = target?.id ?? [...this.entries.keys()][0] ?? null;
    this.emitChange();
  }

  setActive(id: string): VaultsState {
    this.requireEntry(id);
    this.activeId = id;
    this.emitChange();
    return this.getVaultsState();
  }

  async save(id?: string): Promise<void> {
    const entry = this.requireEntry(id ?? this.activeId);
    await entry.service.save();
  }

  lockVault(id: string): VaultsState {
    this.requireEntry(id).service.lock();
    return this.getVaultsState();
  }

  /** Locks the vault and forgets it; it can be opened again from disk. */
  closeVault(id: string): VaultsState {
    const entry = this.requireEntry(id);
    entry.service.lock();
    this.entries.delete(id);
    if (this.activeId === id) {
      this.activeId = this.unlocked()[0]?.id ?? [...this.entries.keys()][0] ?? null;
    }
    this.emitChange();
    return this.getVaultsState();
  }

  lock(): void {
    for (const entry of this.entries.values()) {
      entry.service.lock();
    }
  }

  setIdleLockMs(ms: number): void {
    this.idleLockMs = ms;
    for (const entry of this.entries.values()) {
      entry.service.setIdleLockMs(ms);
    }
  }

  touchActivity(): void {
    for (const entry of this.unlocked()) {
      entry.service.touchActivity();
    }
  }

  listSshHosts(): SshHostSummary[] {
    return this.unlocked().flatMap((entry) => {
      this.snapshot(entry);
      return entry.service.listSshHosts().map((host) => ({ ...host, vaultId: entry.id }));
    });
  }

  getSshHostCredentials(hostId: string): SshHostCredentials {
    return this.findHost(hostId).service.getSshHostCredentials(hostId);
  }

  async upsertSshHost(request: UpsertSshHostRequest): Promise<SshHostSummary> {
    const { vaultId, ...rest } = request;
    const owner = request.id ? this.findHost(request.id) : this.requireUnlocked(vaultId);
    const saved = await owner.service.upsertSshHost(rest);
    this.snapshot(owner);
    return { ...saved, vaultId: owner.id };
  }

  async deleteSshHost(hostId: string): Promise<void> {
    const owner = this.findHost(hostId);
    await owner.service.deleteSshHost(hostId);
    this.snapshot(owner);
  }

  getKnownHostFingerprint(hostname: string, port: number): string | undefined {
    for (const entry of this.unlocked()) {
      const fingerprint = entry.service.getKnownHostFingerprint(hostname, port);
      if (fingerprint) {
        return fingerprint;
      }
    }
    return undefined;
  }

  async trustHostKey(
    hostname: string,
    port: number,
    fingerprint: string,
    replace: boolean,
  ): Promise<void> {
    const owner =
      this.unlocked().find((entry) =>
        entry.service
          .listSshHosts()
          .some((host) => host.hostname === hostname && host.port === port),
      ) ?? this.requireUnlocked(undefined);
    await owner.service.trustHostKey(hostname, port, fingerprint, replace);
  }

  private newService(): VaultService {
    const service = this.factory();
    if (this.idleLockMs !== undefined) {
      service.setIdleLockMs(this.idleLockMs);
    }
    return service;
  }

  private register(path: string, service: VaultService, locked = false): VaultsState {
    if (this.entries.size >= MAX_OPEN_VAULTS) {
      service.lock();
      throw new Error(`TunnelNote supports up to ${MAX_OPEN_VAULTS} vaults at once.`);
    }
    const id = randomUUID();
    const entry: HubEntry = { id, path, service, hostIds: [] };
    if (!locked) {
      this.snapshot(entry);
    }
    let wasUnlocked = !locked;
    service.subscribe((state) => {
      if (state.status === 'locked' && wasUnlocked) {
        wasUnlocked = false;
        for (const listener of this.lockListeners) {
          listener(id, entry.hostIds);
        }
      } else if (state.status === 'unlocked') {
        wasUnlocked = true;
      }
      this.emitChange();
    });
    this.entries.set(id, entry);
    this.activeId = id;
    this.emitChange();
    return this.getVaultsState();
  }

  private snapshot(entry: HubEntry): void {
    entry.hostIds = entry.service.listSshHosts().map((host) => host.id);
  }

  private emitChange(): void {
    const state = this.getVaultsState();
    for (const listener of this.changeListeners) {
      listener(state);
    }
    this.notifyAggregate();
  }

  private notifyAggregate(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  private unlocked(): HubEntry[] {
    return [...this.entries.values()].filter(
      (entry) => entry.service.getState().status === 'unlocked',
    );
  }

  private assertNotOpen(path: string): void {
    for (const entry of this.entries.values()) {
      if (entry.path === path) {
        throw new Error('That vault is already open. Select it from the vault list instead.');
      }
    }
  }

  private requireEntry(id: string | null | undefined): HubEntry {
    const entry = id ? this.entries.get(id) : undefined;
    if (!entry) {
      throw new Error('That vault is not open.');
    }
    return entry;
  }

  private requireUnlocked(id: string | undefined): HubEntry {
    const entry = this.requireEntry(id ?? this.activeId);
    if (entry.service.getState().status !== 'unlocked') {
      throw new Error('Unlock this vault first.');
    }
    return entry;
  }

  private findHost(hostId: string): HubEntry {
    for (const entry of this.unlocked()) {
      if (entry.service.listSshHosts().some((host) => host.id === hostId)) {
        return entry;
      }
    }
    throw new Error('The SSH host was not found in any unlocked vault.');
  }
}
