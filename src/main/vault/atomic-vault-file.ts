import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const DEFAULT_BACKUP_LIMIT = 5;
const BACKUP_SUFFIX = '.backup-';

export class VaultConflictError extends Error {
  constructor() {
    super('The vault changed on disk. Reopen it before saving to avoid overwriting changes.');
    this.name = 'VaultConflictError';
  }
}

export class VaultAlreadyExistsError extends Error {
  constructor() {
    super('A vault already exists at the selected location.');
    this.name = 'VaultAlreadyExistsError';
  }
}

export class VaultBackupCleanupError extends Error {
  constructor(
    readonly committedHash: string,
    cause: unknown,
  ) {
    super('The vault was saved, but old backup files could not be pruned.', { cause });
    this.name = 'VaultBackupCleanupError';
  }
}

export function hashVaultData(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function readVaultFile(path: string): Promise<Buffer> {
  await assertRegularVaultFile(path);
  return readFile(path);
}

export interface WriteVaultOptions {
  mode: 'create' | 'replace';
  expectedHash?: string;
  backupLimit?: number;
}

export async function writeVaultFile(
  path: string,
  contents: Uint8Array,
  options: WriteVaultOptions,
): Promise<string> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });

  const previous = await readCurrentFile(path);
  if (options.mode === 'create' && previous !== undefined) {
    throw new VaultAlreadyExistsError();
  }

  if (options.mode === 'replace') {
    if (previous === undefined || hashVaultData(previous) !== options.expectedHash) {
      throw new VaultConflictError();
    }
  }

  const tempPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let tempCreated = false;

  try {
    const file = await open(tempPath, 'wx', 0o600);
    tempCreated = true;
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }

    if (previous !== undefined) {
      await createBackup(path, previous);
    }

    if (options.mode === 'create') {
      try {
        await link(tempPath, path);
      } catch (error) {
        if (isFileExistsError(error)) {
          throw new VaultAlreadyExistsError();
        }
        throw error;
      }
      await unlink(tempPath);
      tempCreated = false;
    } else {
      const current = await readCurrentFile(path);
      if (current === undefined || hashVaultData(current) !== options.expectedHash) {
        throw new VaultConflictError();
      }
      await rename(tempPath, path);
      tempCreated = false;
    }

    await syncDirectory(directory);
    const committedHash = hashVaultData(contents);
    if (previous !== undefined) {
      try {
        await pruneBackups(path, Math.max(0, options.backupLimit ?? DEFAULT_BACKUP_LIMIT));
      } catch (error) {
        throw new VaultBackupCleanupError(committedHash, error);
      }
    }
    return committedHash;
  } finally {
    if (tempCreated) {
      await rm(tempPath, { force: true });
    }
  }
}

async function readCurrentFile(path: string): Promise<Buffer | undefined> {
  try {
    await assertRegularVaultFile(path);
    return await readFile(path);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function assertRegularVaultFile(path: string): Promise<void> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error('Vault paths must refer to regular files, not symbolic links or directories.');
  }
}

async function createBackup(path: string, contents: Uint8Array): Promise<void> {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const backupPath = `${path}${BACKUP_SUFFIX}${stamp}-${randomUUID()}.kdbx`;
  const backupTemp = `${backupPath}.${randomUUID()}.tmp`;
  let tempCreated = false;

  try {
    const file = await open(backupTemp, 'wx', 0o600);
    tempCreated = true;
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await link(backupTemp, backupPath);
    await unlink(backupTemp);
    tempCreated = false;
  } finally {
    if (tempCreated) {
      await rm(backupTemp, { force: true });
    }
  }
}

async function pruneBackups(path: string, limit: number): Promise<void> {
  const directory = dirname(path);
  const prefix = `${basename(path)}${BACKUP_SUFFIX}`;
  const names = (await readdir(directory))
    .filter((name) => name.startsWith(prefix) && name.endsWith('.kdbx'))
    .sort()
    .reverse();

  for (const staleName of names.slice(Math.max(0, limit))) {
    await rm(join(directory, staleName));
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (process.platform === 'win32' && isUnsupportedDirectorySyncError(error)) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function isNotFoundError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function isFileExistsError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST';
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return isNodeError(error) && ['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error.code ?? '');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
