import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { posix } from 'node:path';
import type { FileEntryWithStats, SFTPWrapper, Stats as SftpStats } from 'ssh2';
import type { SftpDirectoryEntry, SftpTransferEvent } from '../../shared/ssh-contract';

const MAX_LISTING_ENTRIES = 2000;
const MAX_ACTIVE_TRANSFERS_PER_SESSION = 20;
const MAX_EDIT_BYTES = 1024 * 1024;

interface LocalRoot {
  id: string;
  sessionId: string;
  path: string;
  displayName: string;
}

interface TransferJob {
  id: string;
  sessionId: string;
  rootId: string;
  direction: 'upload' | 'download';
  localPath: string;
  remotePath: string;
  overwrite: boolean;
  resume: boolean;
  status: SftpTransferEvent['status'];
  transferredBytes: number;
  totalBytes: number;
  cancelled: boolean;
  input?: NodeJS.ReadableStream & { destroy(error?: Error): void };
  output?: NodeJS.WritableStream & { destroy(error?: Error): void };
  lastProgressAt: number;
  message?: string;
}

export type SftpEventSink = (event: SftpTransferEvent) => void;

export interface SftpSessionProvider {
  openSftp(sessionId: string): Promise<SFTPWrapper>;
  assertSessionConnected(sessionId: string): void;
  onSessionClosed(listener: (sessionId: string) => void): () => void;
}

export class SftpService {
  private readonly localRoots = new Map<string, LocalRoot>();
  private readonly transfers = new Map<string, TransferJob>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly sessions: SftpSessionProvider,
    private readonly emit: SftpEventSink,
  ) {
    sessions.onSessionClosed((sessionId) => this.closeSession(sessionId));
  }

  async registerLocalRoot(
    sessionId: string,
    selectedPath: string,
  ): Promise<{
    rootId: string;
    displayName: string;
  }> {
    this.sessions.assertSessionConnected(sessionId);
    const rootPath = await realpath(selectedPath);
    const details = await stat(rootPath);
    if (!details.isDirectory()) {
      throw new Error('Choose a local folder to use for SFTP transfers.');
    }
    const root: LocalRoot = {
      id: randomUUID(),
      sessionId,
      path: rootPath,
      displayName: basename(rootPath) || rootPath,
    };
    this.localRoots.set(sessionId, root);
    return { rootId: root.id, displayName: root.displayName };
  }

  assertSessionConnected(sessionId: string): void {
    this.sessions.assertSessionConnected(sessionId);
  }

  async listLocal(
    sessionId: string,
    rootId: string,
    relativePath: string,
  ): Promise<{ path: string; entries: SftpDirectoryEntry[] }> {
    const root = this.requireRoot(sessionId, rootId);
    const directory = await this.resolveLocalPath(root, relativePath);
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory()) {
      throw new Error('The selected local SFTP location is not a directory.');
    }
    const names = await readdir(directory, { withFileTypes: true });
    const entries: SftpDirectoryEntry[] = [];
    for (const item of names.slice(0, MAX_LISTING_ENTRIES)) {
      const itemPath = join(directory, item.name);
      const metadata = await lstat(itemPath);
      const type = metadata.isSymbolicLink()
        ? 'symlink'
        : metadata.isDirectory()
          ? 'directory'
          : metadata.isFile()
            ? 'file'
            : 'other';
      entries.push({
        name: item.name,
        type,
        size: metadata.isFile() ? metadata.size : 0,
        modifiedAt: Math.max(0, metadata.mtimeMs),
      });
    }
    entries.sort(compareEntries);
    return { path: normalizeRelativePath(relativePath), entries };
  }

  async listRemote(
    sessionId: string,
    requestedPath: string,
  ): Promise<{ path: string; entries: SftpDirectoryEntry[] }> {
    const sftp = await this.sessions.openSftp(sessionId);
    const safePath = validateRemotePath(requestedPath);
    const path = await callbackResult<string>((callback) => sftp.realpath(safePath, callback));
    const items = await callbackResult<FileEntryWithStats[]>((callback) =>
      sftp.readdir(path, callback),
    );
    const entries: SftpDirectoryEntry[] = items
      .filter((item) => isSafeRemoteName(item.filename))
      .slice(0, MAX_LISTING_ENTRIES)
      .map((item) => ({
        name: item.filename,
        type: item.attrs.isSymbolicLink()
          ? 'symlink'
          : item.attrs.isDirectory()
            ? 'directory'
            : item.attrs.isFile()
              ? 'file'
              : 'other',
        size: item.attrs.isFile() ? Math.max(0, item.attrs.size) : 0,
        modifiedAt: Math.max(0, item.attrs.mtime * 1000),
      }));
    entries.sort(compareEntries);
    return { path, entries };
  }

  startTransfer(request: {
    sessionId: string;
    rootId: string;
    direction: 'upload' | 'download';
    localPath: string;
    remotePath: string;
    overwrite: boolean;
    resume: boolean;
  }): string {
    this.requireRoot(request.sessionId, request.rootId);
    validateRelativePath(request.localPath);
    validateRemotePath(request.remotePath);
    const sessionTransfers = [...this.transfers.values()].filter(
      (job) =>
        job.sessionId === request.sessionId &&
        (job.status === 'queued' || job.status === 'transferring'),
    );
    if (sessionTransfers.length >= MAX_ACTIVE_TRANSFERS_PER_SESSION) {
      throw new Error('The SFTP transfer queue is full for this session.');
    }

    const job: TransferJob = {
      ...request,
      id: randomUUID(),
      status: 'queued',
      transferredBytes: 0,
      totalBytes: 0,
      cancelled: false,
      lastProgressAt: 0,
    };
    this.transfers.set(job.id, job);
    this.emitTransfer(job);
    const previous = this.queues.get(job.sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.performTransfer(job))
      .catch(() => undefined);
    this.queues.set(job.sessionId, next);
    void next.finally(() => {
      if (this.queues.get(job.sessionId) === next) {
        this.queues.delete(job.sessionId);
      }
      this.trimTransferHistory(job.sessionId);
    });
    return job.id;
  }

  cancelTransfer(sessionId: string, transferId: string): void {
    const job = this.transfers.get(transferId);
    if (!job || job.sessionId !== sessionId) {
      throw new Error('This SFTP transfer is no longer available.');
    }
    if (job.status !== 'queued' && job.status !== 'transferring') {
      return;
    }
    job.cancelled = true;
    job.input?.destroy();
    job.output?.destroy();
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.message = 'Cancelled before transfer started.';
      this.emitTransfer(job);
    }
  }

  async readRemoteText(
    sessionId: string,
    remotePath: string,
  ): Promise<{ remotePath: string; text: string; revision: string }> {
    const sftp = await this.sessions.openSftp(sessionId);
    const safePath = validateRemotePath(remotePath);
    const bytes = await this.readRemoteBytes(sftp, safePath);
    if (!isUtf8(bytes)) {
      bytes.fill(0);
      throw new Error('The remote file is not valid UTF-8 text.');
    }
    const revision = digest(bytes);
    const text = bytes.toString('utf8');
    bytes.fill(0);
    return { remotePath: safePath, text, revision };
  }

  async writeRemoteText(
    sessionId: string,
    remotePath: string,
    text: string,
    expectedRevision: string,
  ): Promise<{ revision: string }> {
    const sftp = await this.sessions.openSftp(sessionId);
    const safePath = validateRemotePath(remotePath);
    const current = await this.readRemoteBytes(sftp, safePath);
    const currentRevision = digest(current);
    const expected = Buffer.from(expectedRevision, 'hex');
    const currentHash = Buffer.from(currentRevision, 'hex');
    current.fill(0);
    if (!timingSafeEqual(expected, currentHash)) {
      throw new Error('The remote file changed since it was opened. Reload it before saving.');
    }

    const bytes = Buffer.from(text, 'utf8');
    if (bytes.byteLength > MAX_EDIT_BYTES) {
      bytes.fill(0);
      throw new Error('The edited remote file exceeds the 1 MiB limit.');
    }
    const tempPath = `${safePath}.tunnelnote-${randomUUID()}.tmp`;
    try {
      await callbackResult<void>((callback) => sftp.writeFile(tempPath, bytes, callback));
      const latest = await this.readRemoteBytes(sftp, safePath);
      const latestRevision = digest(latest);
      latest.fill(0);
      if (
        !timingSafeEqual(Buffer.from(expectedRevision, 'hex'), Buffer.from(latestRevision, 'hex'))
      ) {
        throw new Error('The remote file changed while it was being edited.');
      }
      await callbackResult<void>((callback) =>
        sftp.ext_openssh_rename(tempPath, safePath, callback),
      );
      return { revision: digest(bytes) };
    } catch (error) {
      let cleanupFailed = false;
      try {
        await callbackResult<void>((callback) => sftp.unlink(tempPath, callback));
      } catch {
        cleanupFailed = true;
      }
      if (error instanceof Error && error.message.includes('changed while it was being edited')) {
        throw new Error(
          cleanupFailed
            ? `${error.message} A temporary remote file could not be removed.`
            : error.message,
          { cause: error },
        );
      }
      throw new Error(
        cleanupFailed
          ? 'Unable to atomically save the remote file; a temporary file could not be removed.'
          : 'Unable to atomically save the remote file. The original was not replaced.',
        { cause: error },
      );
    } finally {
      bytes.fill(0);
    }
  }

  closeSession(sessionId: string): void {
    this.localRoots.delete(sessionId);
    for (const job of this.transfers.values()) {
      if (
        job.sessionId === sessionId &&
        (job.status === 'queued' || job.status === 'transferring')
      ) {
        this.cancelTransfer(sessionId, job.id);
      }
    }
  }

  private async performTransfer(job: TransferJob): Promise<void> {
    if (job.cancelled) {
      return;
    }
    try {
      this.requireRoot(job.sessionId, job.rootId);
      const sftp = await this.sessions.openSftp(job.sessionId);
      if (job.cancelled) {
        return;
      }
      job.status = 'transferring';
      if (job.direction === 'upload') {
        await this.upload(sftp, job);
      } else {
        await this.download(sftp, job);
      }
      if (job.cancelled) {
        job.status = 'cancelled';
        job.message = 'Transfer cancelled; partial data is available to resume.';
      } else {
        job.status = 'completed';
        job.transferredBytes = job.totalBytes;
        job.message = 'Transfer completed.';
      }
    } catch {
      job.status = job.cancelled ? 'cancelled' : 'failed';
      job.message = job.cancelled
        ? 'Transfer cancelled; partial data is available to resume.'
        : 'SFTP transfer failed. Check the paths, permissions, and connection.';
    } finally {
      job.input = undefined;
      job.output = undefined;
      this.emitTransfer(job);
    }
  }

  private async upload(sftp: SFTPWrapper, job: TransferJob): Promise<void> {
    const root = this.requireRoot(job.sessionId, job.rootId);
    const sourcePath = await this.resolveLocalTransferPath(root, job.localPath);
    const sourceStats = await lstat(sourcePath);
    if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) {
      throw new Error('Choose a regular local file; symbolic links cannot be transferred.');
    }
    const targetExists = await remoteExists(sftp, job.remotePath);
    if (targetExists && !job.overwrite) {
      throw new Error('The remote destination already exists.');
    }
    const remotePartPath = transferPartPath(job.remotePath, job.localPath);
    const existingPartSize = job.resume ? await remoteFileSize(sftp, remotePartPath) : 0;
    if (existingPartSize > sourceStats.size) {
      throw new Error('The remote partial file is larger than the local source and cannot resume.');
    }
    job.transferredBytes = existingPartSize;
    job.totalBytes = sourceStats.size;
    this.emitTransfer(job);
    const source = createReadStream(sourcePath, {
      ...(existingPartSize > 0 ? { start: existingPartSize } : {}),
    });
    const sink = sftp.createWriteStream(remotePartPath, {
      flags: existingPartSize > 0 ? 'r+' : 'wx',
      ...(existingPartSize > 0 ? { start: existingPartSize } : {}),
    });
    job.input = source;
    job.output = sink;
    await this.pipeWithProgress(job, source, sink);
    if (job.cancelled) {
      return;
    }
    if (targetExists) {
      await callbackResult<void>((callback) =>
        sftp.ext_openssh_rename(remotePartPath, job.remotePath, callback),
      );
    } else {
      await callbackResult<void>((callback) =>
        sftp.rename(remotePartPath, job.remotePath, callback),
      );
    }
  }

  private async download(sftp: SFTPWrapper, job: TransferJob): Promise<void> {
    const root = this.requireRoot(job.sessionId, job.rootId);
    const destinationPath = await this.resolveLocalTransferPath(root, job.localPath);
    const destinationParentPath = dirname(job.localPath);
    const destinationParent = await this.resolveLocalTransferPath(
      root,
      destinationParentPath === '.' ? '' : destinationParentPath,
      true,
    );
    const parentStats = await lstat(destinationParent);
    if (!parentStats.isDirectory()) {
      throw new Error('The local destination folder does not exist.');
    }
    const destinationExists = await localFileExists(destinationPath);
    if (destinationExists && !job.overwrite) {
      throw new Error('The local destination already exists.');
    }
    const metadata = await callbackResult<SftpStats>((callback) =>
      sftp.lstat(job.remotePath, callback),
    );
    if (!metadata.isFile()) {
      throw new Error('Only regular remote files can be downloaded.');
    }
    const partPath = localTransferPartPath(destinationPath, job.remotePath);
    const existingPartSize = await localFileSize(partPath);
    const partSize = job.resume ? existingPartSize : 0;
    if (partSize > metadata.size) {
      throw new Error('The local partial file is larger than the remote source and cannot resume.');
    }
    job.transferredBytes = partSize;
    job.totalBytes = metadata.size;
    this.emitTransfer(job);
    const source = sftp.createReadStream(job.remotePath, {
      ...(partSize > 0 ? { start: partSize } : {}),
    });
    const sink = createWriteStream(partPath, {
      flags: partSize > 0 ? 'a' : 'wx',
    });
    job.input = source;
    job.output = sink;
    await this.pipeWithProgress(job, source, sink);
    if (job.cancelled) {
      return;
    }
    if (destinationExists) {
      try {
        await rename(partPath, destinationPath);
      } catch (error) {
        if (!isDestinationExistsError(error)) {
          throw error;
        }
        await rm(destinationPath, { force: true });
        await rename(partPath, destinationPath);
      }
    } else {
      await rename(partPath, destinationPath);
    }
  }

  private async pipeWithProgress(
    job: TransferJob,
    source: NodeJS.ReadableStream,
    sink: NodeJS.WritableStream,
  ): Promise<void> {
    const progress = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        job.transferredBytes += chunk.length;
        const now = Date.now();
        if (now - job.lastProgressAt >= 150) {
          job.lastProgressAt = now;
          this.emitTransfer(job);
        }
        callback(null, chunk);
      },
    });
    await pipeline(source, progress, sink);
  }

  private async readRemoteBytes(sftp: SFTPWrapper, path: string): Promise<Buffer> {
    const metadata = await callbackResult<SftpStats>((callback) => sftp.lstat(path, callback));
    if (!metadata.isFile() || metadata.size > MAX_EDIT_BYTES) {
      throw new Error('The remote file is larger than the editor limit.');
    }
    const stream = sftp.createReadStream(path, { start: 0, end: MAX_EDIT_BYTES });
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_EDIT_BYTES) {
          stream.destroy();
          for (const collected of chunks) {
            collected.fill(0);
          }
          bytes.fill(0);
          throw new Error('The remote file is larger than the editor limit.');
        }
        chunks.push(bytes);
      }
    } catch (error) {
      for (const collected of chunks) {
        collected.fill(0);
      }
      if (error instanceof Error && error.message.includes('larger than the editor limit')) {
        throw error;
      }
      throw new Error('Unable to read the remote text file.', { cause: error });
    }
    const contents = Buffer.concat(chunks);
    for (const chunk of chunks) {
      chunk.fill(0);
    }
    return contents;
  }

  private async resolveLocalPath(root: LocalRoot, relativePath: string): Promise<string> {
    const segments = validateRelativePath(relativePath, true);
    const candidate = resolve(root.path, ...segments);
    if (!isContained(root.path, candidate)) {
      throw new Error('The local path is outside the selected SFTP folder.');
    }
    const actualPath = await realpath(candidate);
    if (!isContained(root.path, actualPath)) {
      throw new Error('The local path resolves outside the selected SFTP folder.');
    }
    return actualPath;
  }

  private async resolveLocalTransferPath(
    root: LocalRoot,
    relativePath: string,
    allowRoot = false,
  ): Promise<string> {
    const segments = validateRelativePath(relativePath, allowRoot);
    if (segments.length === 0) {
      return root.path;
    }
    let candidate = root.path;
    for (const [index, segment] of segments.entries()) {
      candidate = join(candidate, segment);
      const details = await lstat(candidate);
      if (details.isSymbolicLink()) {
        throw new Error('Symbolic links cannot be used as SFTP transfer paths.');
      }
      if (index < segments.length - 1 && !details.isDirectory()) {
        throw new Error('The local SFTP path contains a non-directory parent.');
      }
    }
    const actualPath = await realpath(candidate);
    if (!isContained(root.path, actualPath)) {
      throw new Error('The local path resolves outside the selected SFTP folder.');
    }
    return actualPath;
  }

  private requireRoot(sessionId: string, rootId: string): LocalRoot {
    const root = this.localRoots.get(sessionId);
    if (!root || root.id !== rootId) {
      throw new Error('Choose a local SFTP folder for this SSH session first.');
    }
    return root;
  }

  private emitTransfer(job: TransferJob): void {
    this.emit({
      type: 'transfer',
      sessionId: job.sessionId,
      transferId: job.id,
      direction: job.direction,
      status: job.status,
      transferredBytes: job.transferredBytes,
      totalBytes: job.totalBytes,
      ...(job.message ? { message: job.message } : {}),
    });
  }

  private trimTransferHistory(sessionId: string): void {
    const finished = [...this.transfers.values()]
      .filter(
        (job) =>
          job.sessionId === sessionId && job.status !== 'queued' && job.status !== 'transferring',
      )
      .sort((left, right) => left.lastProgressAt - right.lastProgressAt);
    for (const job of finished.slice(0, Math.max(0, finished.length - 50))) {
      this.transfers.delete(job.id);
    }
  }
}

function validateRemotePath(path: string): string {
  if (path.length === 0 || path.length > 4096 || path.includes('\0')) {
    throw new Error('The remote path is invalid.');
  }
  return path;
}

function validateRelativePath(path: string, allowRoot = false): string[] {
  if (path.length === 0 && allowRoot) {
    return [];
  }
  if (path.length === 0 || path.length > 4096 || path.includes('\0') || path.includes('\\')) {
    throw new Error('The local path is invalid.');
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(
      'Local SFTP paths cannot contain empty, current, or parent directory segments.',
    );
  }
  return segments;
}

function normalizeRelativePath(path: string): string {
  return validateRelativePath(path, true).join('/');
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isSafeRemoteName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\0')
  );
}

function compareEntries(left: SftpDirectoryEntry, right: SftpDirectoryEntry): number {
  if (left.type === 'directory' && right.type !== 'directory') {
    return -1;
  }
  if (right.type === 'directory' && left.type !== 'directory') {
    return 1;
  }
  return left.name.localeCompare(right.name);
}

function transferPartPath(remotePath: string, localPath: string): string {
  const suffix = createHash('sha256')
    .update(`${remotePath}\0${localPath}`)
    .digest('hex')
    .slice(0, 12);
  return posix.join(posix.dirname(remotePath), `.${posix.basename(remotePath)}.${suffix}.tnpart`);
}

function localTransferPartPath(destinationPath: string, remotePath: string): string {
  const suffix = createHash('sha256').update(remotePath).digest('hex').slice(0, 12);
  return join(dirname(destinationPath), `.${basename(destinationPath)}.${suffix}.tnpart`);
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function remoteExists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  try {
    await callbackResult<SftpStats>((callback) => sftp.lstat(path, callback));
    return true;
  } catch (error) {
    if (isMissingRemoteFile(error)) {
      return false;
    }
    throw new Error('Unable to check the remote destination.', { cause: error });
  }
}

async function remoteFileSize(sftp: SFTPWrapper, path: string): Promise<number> {
  try {
    const metadata = await callbackResult<SftpStats>((callback) => sftp.lstat(path, callback));
    if (!metadata.isFile()) {
      throw new Error('The remote partial transfer is not a regular file.');
    }
    return metadata.size;
  } catch (error) {
    if (isMissingRemoteFile(error)) {
      return 0;
    }
    throw error;
  }
}

function isMissingRemoteFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 2);
}

function isDestinationExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'ENOTEMPTY')
  );
}

async function localFileExists(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error('The local destination must be a regular file.');
    }
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function localFileSize(path: string): Promise<number> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error('The local partial transfer must be a regular file.');
    }
    return details.size;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

function callbackResult<T>(
  invoke: (callback: (error: Error | null | undefined, value: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    invoke((error, value) => {
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    });
  });
}
