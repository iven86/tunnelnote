import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ZodType } from 'zod';

/** Small atomic JSON file store for non-secret application data. */
export class JsonStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly schema: ZodType<T>,
    private readonly fallback: () => T,
  ) {}

  async read(): Promise<T> {
    try {
      return this.schema.parse(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.fallback();
      }
      throw new Error('The stored TunnelNote data is unreadable or invalid.', { cause: error });
    }
  }

  async write(value: T): Promise<void> {
    const safe = this.schema.parse(value);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(safe, null, 2), { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
