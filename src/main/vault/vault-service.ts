import {
  Consts,
  Credentials,
  Int64,
  Kdbx,
  KdbxEntry,
  KdbxError,
  ProtectedValue,
  VarDictionary,
} from 'kdbxweb';
import type { KdbxEntryField, KdbxGroup } from 'kdbxweb';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  hostOsSchema,
  sshHostAuthSchema,
  sshHostSummarySchema,
  type SshHostSummary,
  type UpsertSshHostRequest,
} from '../../shared/ssh-contract';
import type { VaultState } from '../../shared/vault-contract';
import { IdleLockTimer } from './idle-lock';
import {
  hashVaultData,
  readVaultFile,
  VaultBackupCleanupError,
  writeVaultFile,
} from './atomic-vault-file';
import {
  benchmarkArgon2idIterations,
  configureArgon2Provider,
  UnsupportedKdfParametersError,
} from './argon2-provider';

const DEFAULT_IDLE_LOCK_MS = 5 * 60 * 1000;
const BACKUP_LIMIT = 5;
const ARGON_MEMORY_BYTES = 256 * 1024 * 1024;
const ARGON_ITERATIONS = 3;
const ARGON_PARALLELISM = 2;
const HOST_TYPE = 'TunnelNote.SshHost';
const KNOWN_HOST_TYPE = 'TunnelNote.KnownHost';
export interface SshHostCredentials extends SshHostSummary {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export class VaultUnlockError extends Error {
  constructor() {
    super('Unable to unlock this vault. Check the password, and verify the file is intact.');
    this.name = 'VaultUnlockError';
  }
}

export class VaultUnsupportedKdfError extends Error {
  constructor() {
    super('This vault requests KDF settings above TunnelNote safety limits.');
    this.name = 'VaultUnsupportedKdfError';
  }
}

export class VaultService {
  private database: Kdbx | undefined;
  private path: string | undefined;
  private expectedFileHash: string | undefined;
  private operationInProgress = false;
  private lockRequested = false;
  private readonly idleTimer: IdleLockTimer;
  private readonly stateListeners = new Set<(state: VaultState) => void>();

  constructor(idleLockMs = DEFAULT_IDLE_LOCK_MS) {
    this.idleTimer = new IdleLockTimer(idleLockMs, () => this.lock());
  }

  setIdleLockMs(ms: number): void {
    this.idleTimer.setTimeoutMs(ms);
  }

  getState(): VaultState {
    return {
      status: this.database ? 'unlocked' : 'locked',
      name: this.path ? basename(this.path) : null,
    };
  }

  subscribe(listener: (state: VaultState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  async create(path: string, password: string): Promise<VaultState> {
    this.beginOperation();
    try {
      this.assertLocked();
      configureArgon2Provider();
      const iterations = await benchmarkArgon2idIterations(ARGON_MEMORY_BYTES, ARGON_PARALLELISM);
      let credentials: Credentials | undefined;
      try {
        credentials = await this.createCredentials(password);
        const database = Kdbx.create(credentials, 'TunnelNote');
        database.upgrade();
        configureStrongArgon2id(database, iterations);
        const data = await database.save();
        const dataBytes = new Uint8Array(data);
        try {
          this.expectedFileHash = await writeVaultFile(path, dataBytes, { mode: 'create' });
        } finally {
          dataBytes.fill(0);
        }
        this.setActiveVault(database, path);
        this.touchActivity();
        this.notifyState();
        return this.getState();
      } catch (error) {
        clearCredentials(credentials);
        throw error;
      }
    } finally {
      this.endOperation();
    }
  }

  async open(path: string, password: string): Promise<VaultState> {
    this.beginOperation();
    try {
      this.assertLocked();
      try {
        configureArgon2Provider();
      } catch {
        throw new VaultUnlockError();
      }
      let credentials: Credentials | undefined;
      const bytes = await readVaultFile(path);
      try {
        credentials = await this.createCredentials(password);
        const database = await Kdbx.load(toArrayBuffer(bytes), credentials);
        this.expectedFileHash = hashVaultData(bytes);
        this.setActiveVault(database, path);
        this.touchActivity();
        this.notifyState();
        return this.getState();
      } catch (error) {
        clearCredentials(credentials);
        if (error instanceof UnsupportedKdfParametersError) {
          throw new VaultUnsupportedKdfError();
        }
        if (error instanceof KdbxError) {
          console.error('[Vault] KdbxError during load:', {
            message: error.message,
            code: (error as { code?: unknown }).code,
          });
          throw new VaultUnlockError();
        }
        console.error('[Vault] Unexpected error during load:', error);
        throw error;
      } finally {
        bytes.fill(0);
      }
    } finally {
      this.endOperation();
    }
  }

  async save(): Promise<void> {
    this.beginOperation();
    try {
      await this.saveUnlocked();
    } finally {
      this.endOperation();
    }
  }

  listSshHosts(): SshHostSummary[] {
    const database = this.requireDatabase();
    return [...database.getDefaultGroup().allEntries()]
      .filter((entry) => getFieldText(entry.fields.get('TunnelNoteType')) === HOST_TYPE)
      .map((entry) => sshHostSummarySchema.parse(readHostSummary(entry, database)));
  }

  getSshHostCredentials(hostId: string): SshHostCredentials {
    const entry = this.findHostEntry(hostId);
    const summary = sshHostSummarySchema.parse(readHostSummary(entry, this.requireDatabase()));
    if (summary.authMethod === 'password') {
      const password = getFieldText(entry.fields.get('Password'));
      if (!password) {
        throw new Error('This host has no saved password. Edit the host and add one.');
      }
      return { ...summary, password };
    }
    if (summary.authMethod === 'privateKey') {
      const privateKey = getFieldText(entry.fields.get('PrivateKey'));
      if (!privateKey) {
        throw new Error('This host has no saved private key. Edit the host and add one.');
      }
      const passphrase = getFieldText(entry.fields.get('Passphrase'));
      return { ...summary, privateKey, ...(passphrase ? { passphrase } : {}) };
    }
    return summary;
  }

  async upsertSshHost(request: UpsertSshHostRequest): Promise<SshHostSummary> {
    this.beginOperation();
    try {
      const database = this.requireDatabase();
      const entry = request.id ? this.findHostEntry(request.id) : undefined;
      const previousFields = entry ? new Map(entry.fields) : undefined;
      const previousTags = entry ? [...entry.tags] : undefined;
      const id = request.id ?? randomUUID();
      const previousAuthMethod = entry ? getFieldText(entry.fields.get('AuthMethod')) : undefined;
      const suppliedCredential =
        request.authMethod === 'password' ? request.password : request.privateKey;
      if (request.jumpHostId) {
        this.validateJumpHost(request.jumpHostId, id);
      }

      const needsSavedCredential =
        request.authMethod === 'password' || request.authMethod === 'privateKey';
      if (
        needsSavedCredential &&
        request.authMethod !== previousAuthMethod &&
        suppliedCredential === undefined
      ) {
        throw new Error('Provide a new credential when changing the authentication method.');
      }
      if (needsSavedCredential && suppliedCredential === undefined && !entry) {
        throw new Error('A credential is required when creating a host.');
      }

      const target = entry ?? database.createEntry(database.getDefaultGroup());
      target.fields.set('Title', request.name);
      target.fields.set('TunnelNoteType', HOST_TYPE);
      target.fields.set('TunnelNoteId', id);
      target.fields.set('HostName', request.hostname);
      // Standard URL field so the address is visible in any KDBX-compatible tool.
      target.fields.set('URL', request.hostname);
      target.fields.set('Port', String(request.port));
      target.fields.set('UserName', request.username);
      target.fields.set('AuthMethod', request.authMethod);
      if (request.os) {
        target.fields.set('OsType', request.os);
      } else {
        target.fields.delete('OsType');
      }
      if (request.tags !== undefined) {
        target.tags = [...new Set(request.tags)];
      }
      if (request.notes !== undefined) {
        if (request.notes) {
          target.fields.set('Notes', request.notes);
        } else {
          target.fields.delete('Notes');
        }
      }
      const previousParent = target.parentGroup;
      if (request.group !== undefined) {
        const destination = ensureGroup(database, request.group);
        if (target.parentGroup !== destination) {
          database.move(target, destination);
        }
      }
      if (request.jumpHostId) {
        target.fields.set('JumpHostId', request.jumpHostId);
      } else {
        target.fields.delete('JumpHostId');
      }

      if (request.authMethod === 'password') {
        target.fields.delete('PrivateKey');
        target.fields.delete('Passphrase');
        if (request.password !== undefined) {
          target.fields.set('Password', ProtectedValue.fromString(request.password));
        }
      } else {
        target.fields.delete('Password');
        if (request.privateKey !== undefined) {
          target.fields.set('PrivateKey', ProtectedValue.fromString(request.privateKey));
        }
        if (request.passphrase !== undefined) {
          target.fields.set('Passphrase', ProtectedValue.fromString(request.passphrase));
        } else if (request.privateKey !== undefined || request.authMethod !== previousAuthMethod) {
          target.fields.delete('Passphrase');
        }
      }
      if (request.authMethod === 'agent' || request.authMethod === 'keyboardInteractive') {
        target.fields.delete('Password');
        target.fields.delete('PrivateKey');
        target.fields.delete('Passphrase');
      }

      try {
        await this.saveUnlocked();
      } catch (error) {
        if (entry && previousFields && previousTags) {
          entry.fields = previousFields;
          entry.tags = previousTags;
          if (previousParent && entry.parentGroup !== previousParent) {
            database.move(entry, previousParent);
          }
        } else {
          const parent = target.parentGroup;
          const index = parent?.entries.indexOf(target) ?? -1;
          if (parent && index >= 0) {
            parent.entries.splice(index, 1);
          }
        }
        throw error;
      }

      this.touchActivity();
      return sshHostSummarySchema.parse(readHostSummary(target, database));
    } finally {
      this.endOperation();
    }
  }

  async deleteSshHost(hostId: string): Promise<void> {
    this.beginOperation();
    try {
      const database = this.requireDatabase();
      const entry = this.findHostEntry(hostId);
      const dependedOn = [...database.getDefaultGroup().allEntries()].some(
        (candidate) => getFieldText(candidate.fields.get('JumpHostId')) === hostId,
      );
      if (dependedOn) {
        throw new Error(
          'This host is configured as a jump host. Update dependent hosts before deleting it.',
        );
      }
      const group = entry.parentGroup;
      if (!group) {
        throw new Error('The host is not attached to a vault group.');
      }
      const index = group.entries.indexOf(entry);
      group.entries.splice(index, 1);
      database.addDeletedObject(entry.uuid, new Date());
      try {
        await this.saveUnlocked();
      } catch (error) {
        group.entries.splice(index < 0 ? group.entries.length : index, 0, entry);
        const deletedObjectIndex = database.deletedObjects.findIndex((item) =>
          item.uuid?.equals(entry.uuid),
        );
        if (deletedObjectIndex >= 0) {
          database.deletedObjects.splice(deletedObjectIndex, 1);
        }
        throw error;
      }
      this.touchActivity();
    } finally {
      this.endOperation();
    }
  }

  getKnownHostFingerprint(hostname: string, port: number): string | undefined {
    const database = this.requireDatabase();
    const identity = hostIdentity(hostname, port);
    const entry = [...database.getDefaultGroup().allEntries()].find(
      (candidate) =>
        getFieldText(candidate.fields.get('TunnelNoteType')) === KNOWN_HOST_TYPE &&
        getFieldText(candidate.fields.get('HostIdentity')) === identity,
    );
    return entry ? getFieldText(entry.fields.get('Fingerprint')) : undefined;
  }

  async trustHostKey(
    hostname: string,
    port: number,
    fingerprint: string,
    replaceExisting: boolean,
  ): Promise<void> {
    this.beginOperation();
    try {
      const database = this.requireDatabase();
      const identity = hostIdentity(hostname, port);
      const existing = [...database.getDefaultGroup().allEntries()].find(
        (candidate) =>
          getFieldText(candidate.fields.get('TunnelNoteType')) === KNOWN_HOST_TYPE &&
          getFieldText(candidate.fields.get('HostIdentity')) === identity,
      );
      const existingFingerprint = existing
        ? getFieldText(existing.fields.get('Fingerprint'))
        : undefined;
      if (existingFingerprint && existingFingerprint !== fingerprint && !replaceExisting) {
        throw new Error('Replacing a trusted SSH host key requires explicit approval.');
      }
      if (existingFingerprint === fingerprint) {
        return;
      }

      const target = existing ?? database.createEntry(database.getDefaultGroup());
      const previousFields = existing ? new Map(existing.fields) : undefined;
      target.fields.set('Title', `SSH host key: ${hostname}:${port}`);
      target.fields.set('TunnelNoteType', KNOWN_HOST_TYPE);
      target.fields.set('HostIdentity', identity);
      target.fields.set('Fingerprint', fingerprint);
      try {
        await this.saveUnlocked();
      } catch (error) {
        if (existing && previousFields) {
          existing.fields = previousFields;
        } else {
          const parent = target.parentGroup;
          const index = parent?.entries.indexOf(target) ?? -1;
          if (parent && index >= 0) {
            parent.entries.splice(index, 1);
          }
        }
        throw error;
      }
      this.touchActivity();
    } finally {
      this.endOperation();
    }
  }

  lock(): void {
    this.idleTimer.stop();
    if (this.operationInProgress) {
      this.lockRequested = true;
      return;
    }
    this.clearActiveVault();
  }

  private clearActiveVault(): void {
    if (this.database) {
      clearDatabase(this.database);
    }
    this.database = undefined;
    this.path = undefined;
    this.expectedFileHash = undefined;
    this.notifyState();
  }

  touchActivity(): void {
    if (this.database) {
      this.idleTimer.touch();
    }
  }

  private assertLocked(): void {
    if (this.database) {
      throw new Error('Lock the current vault before opening another one.');
    }
  }

  private beginOperation(): void {
    if (this.operationInProgress) {
      throw new Error('A vault operation is already in progress.');
    }
    this.operationInProgress = true;
  }

  private endOperation(): void {
    this.operationInProgress = false;
    if (this.lockRequested) {
      this.lockRequested = false;
      this.clearActiveVault();
    }
  }

  private requireDatabase(): Kdbx {
    if (!this.database) {
      throw new Error('Unlock a vault before using this operation.');
    }
    return this.database;
  }

  private findHostEntry(hostId: string): KdbxEntry {
    const database = this.requireDatabase();
    const entry = [...database.getDefaultGroup().allEntries()].find(
      (candidate) =>
        getFieldText(candidate.fields.get('TunnelNoteType')) === HOST_TYPE &&
        getFieldText(candidate.fields.get('TunnelNoteId')) === hostId,
    );
    if (!entry) {
      throw new Error('The selected SSH host is not in the unlocked vault.');
    }
    return entry;
  }

  private validateJumpHost(jumpHostId: string, hostId: string): void {
    const visited = new Set<string>([hostId]);
    let currentId: string | undefined = jumpHostId;
    let hopCount = 0;
    while (currentId) {
      if (visited.has(currentId)) {
        throw new Error('Jump-host configuration contains a cycle.');
      }
      if (hopCount >= 3) {
        throw new Error('Jump-host chains are limited to three intermediate hosts.');
      }
      visited.add(currentId);
      const entry = this.findHostEntry(currentId);
      currentId = getFieldText(entry.fields.get('JumpHostId'));
      hopCount += 1;
    }
  }

  private async saveUnlocked(): Promise<void> {
    const database = this.requireDatabase();
    const path = this.path;
    const expectedHash = this.expectedFileHash;
    if (!path || !expectedHash) {
      throw new Error('The unlocked vault has no save location.');
    }

    const data = await database.save();
    const bytes = new Uint8Array(data);
    try {
      try {
        this.expectedFileHash = await writeVaultFile(path, bytes, {
          mode: 'replace',
          expectedHash,
          backupLimit: BACKUP_LIMIT,
        });
      } catch (error) {
        if (error instanceof VaultBackupCleanupError) {
          this.expectedFileHash = error.committedHash;
          this.touchActivity();
        }
        throw error;
      }
      this.touchActivity();
    } finally {
      bytes.fill(0);
    }
  }

  private async createCredentials(password: string): Promise<Credentials> {
    const credentials = new Credentials(ProtectedValue.fromString(password));
    await credentials.ready;
    return credentials;
  }

  private setActiveVault(database: Kdbx, path: string): void {
    this.database = database;
    this.path = path;
  }

  private notifyState(): void {
    const state = this.getState();
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }
}

function configureStrongArgon2id(database: Kdbx, iterations: number): void {
  database.setKdf(Consts.KdfId.Argon2id);
  const parameters = database.header.kdfParameters;
  if (!parameters) {
    throw new Error('KDBX library did not initialize Argon2id parameters.');
  }
  parameters.set('P', VarDictionary.ValueType.UInt32, ARGON_PARALLELISM);
  parameters.set(
    'I',
    VarDictionary.ValueType.UInt64,
    Int64.from(Math.max(ARGON_ITERATIONS, iterations)),
  );
  parameters.set('M', VarDictionary.ValueType.UInt64, Int64.from(ARGON_MEMORY_BYTES));
  parameters.set('V', VarDictionary.ValueType.UInt32, 0x13);
}

function clearCredentials(credentials: Credentials | undefined): void {
  credentials?.passwordHash?.value.fill(0);
  credentials?.passwordHash?.salt.fill(0);
}

function clearDatabase(database: Kdbx): void {
  clearCredentials(database.credentials);
  for (const rootGroup of database.groups) {
    for (const entry of rootGroup.allEntries()) {
      for (const field of entry.fields.values()) {
        clearProtectedField(field);
      }
      for (const historicalEntry of entry.history) {
        for (const field of historicalEntry.fields.values()) {
          clearProtectedField(field);
        }
      }
    }
  }
}

function clearProtectedField(field: KdbxEntryField): void {
  if (field instanceof ProtectedValue) {
    field.value.fill(0);
    field.salt.fill(0);
  }
}

function getFieldText(field: KdbxEntryField | undefined): string | undefined {
  if (field instanceof ProtectedValue) {
    return field.getText();
  }
  return field;
}

function ensureGroup(database: Kdbx, path: string): KdbxGroup {
  let current = database.getDefaultGroup();
  for (const name of path.split('/').map((part) => part.trim())) {
    if (!name) {
      continue;
    }
    const existing = current.groups.find((group) => group.name === name);
    current = existing ?? database.createGroup(current, name);
  }
  return current;
}

function readGroupPath(database: Kdbx, entry: KdbxEntry): string {
  const root = database.getDefaultGroup();
  const names: string[] = [];
  let group = entry.parentGroup;
  while (group && group !== root) {
    names.unshift(group.name ?? '');
    group = group.parentGroup;
  }
  return names.join('/');
}

function readHostSummary(entry: KdbxEntry, database: Kdbx): SshHostSummary {
  // URL is the field other KDBX tools edit; HostName is the legacy copy.
  const hostname =
    getFieldText(entry.fields.get('URL')) || getFieldText(entry.fields.get('HostName'));
  const notes = getFieldText(entry.fields.get('Notes'));
  const group = readGroupPath(database, entry);
  const port = Number(getFieldText(entry.fields.get('Port')));
  const username = getFieldText(entry.fields.get('UserName'));
  const authMethod = getFieldText(entry.fields.get('AuthMethod'));
  const jumpHostId = getFieldText(entry.fields.get('JumpHostId'));
  const os = hostOsSchema.safeParse(getFieldText(entry.fields.get('OsType')));
  return {
    id: getFieldText(entry.fields.get('TunnelNoteId')) ?? '',
    name: getFieldText(entry.fields.get('Title')) ?? '',
    hostname: hostname ?? '',
    port,
    username: username ?? '',
    authMethod: sshHostAuthSchema.parse(authMethod),
    ...(jumpHostId ? { jumpHostId } : {}),
    ...(os.success ? { os: os.data } : {}),
    ...(entry.tags.length > 0 ? { tags: [...entry.tags] } : {}),
    ...(group ? { group } : {}),
    ...(notes ? { notes } : {}),
  };
}

function hostIdentity(hostname: string, port: number): string {
  return `${hostname.trim().toLowerCase()}:${port}`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const data = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(data).set(bytes);
  return data;
}
