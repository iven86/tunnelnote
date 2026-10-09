import { argon2d, argon2id } from 'hash-wasm';
import { CryptoEngine } from 'kdbxweb';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { securityLogger } from '../security/redacting-logger';

let configured = false;
let calibration: Promise<number> | undefined;
let configurationError: Error | undefined;
const MAX_MEMORY_KIB = 512 * 1024;
const MAX_ITERATIONS = 20;
const MAX_PARALLELISM = 8;

export class UnsupportedKdfParametersError extends Error {
  constructor() {
    super('The vault requests Argon2 settings above TunnelNote safety limits.');
    this.name = 'UnsupportedKdfParametersError';
  }
}

export class Argon2InitializationError extends Error {
  constructor(cause: unknown) {
    super(
      `Argon2 WASM initialization failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'Argon2InitializationError';
    this.cause = cause;
  }
}

export function configureArgon2Provider(): void {
  if (configured) {
    return;
  }
  if (configurationError) {
    throw configurationError;
  }

  try {
    CryptoEngine.setArgon2Impl(
      async (password, salt, memory, iterations, length, parallelism, type, version) => {
        if (version !== 0x13) {
          throw new UnsupportedKdfParametersError();
        }
        if (
          memory < 1 ||
          memory > MAX_MEMORY_KIB ||
          iterations < 1 ||
          iterations > MAX_ITERATIONS ||
          parallelism < 1 ||
          parallelism > MAX_PARALLELISM ||
          length !== 32
        ) {
          throw new UnsupportedKdfParametersError();
        }

        const passwordCopy = new Uint8Array(password).slice();
        const saltCopy = new Uint8Array(salt).slice();
        let result: Uint8Array | undefined;
        try {
          const implementation =
            type === CryptoEngine.Argon2TypeArgon2d
              ? argon2d
              : type === CryptoEngine.Argon2TypeArgon2id
                ? argon2id
                : undefined;
          if (!implementation) {
            throw new UnsupportedKdfParametersError();
          }
          result = await implementation({
            password: passwordCopy,
            salt: saltCopy,
            memorySize: memory,
            iterations,
            parallelism,
            hashLength: length,
            outputType: 'binary',
          });

          const output = new Uint8Array(result.byteLength);
          output.set(result);
          return output.buffer;
        } finally {
          passwordCopy.fill(0);
          saltCopy.fill(0);
          result?.fill(0);
        }
      },
    );
    configured = true;
  } catch (error) {
    configurationError = error instanceof Error ? error : new Error(String(error));
    securityLogger.error(`Failed to configure Argon2 provider: ${configurationError.message}`);
    throw new Argon2InitializationError(error);
  }
}

export function benchmarkArgon2idIterations(
  memoryBytes: number,
  parallelism: number,
  targetDurationMs = 1_000,
): Promise<number> {
  if (configurationError) {
    return Promise.reject(new Argon2InitializationError(configurationError));
  }
  calibration ??= runBenchmark(memoryBytes, parallelism, targetDurationMs).catch(
    (error: unknown) => {
      calibration = undefined;
      throw error;
    },
  );
  return calibration;
}

async function runBenchmark(
  memoryBytes: number,
  parallelism: number,
  targetDurationMs: number,
): Promise<number> {
  configureArgon2Provider();
  const password = randomBytes(32);
  const salt = randomBytes(16);
  const passwordBuffer = toArrayBuffer(password);
  const saltBuffer = toArrayBuffer(salt);
  const startedAt = performance.now();
  try {
    const result = await CryptoEngine.argon2(
      passwordBuffer,
      saltBuffer,
      memoryBytes / 1024,
      1,
      32,
      parallelism,
      CryptoEngine.Argon2TypeArgon2id,
      0x13,
    );
    new Uint8Array(result).fill(0);
  } finally {
    password.fill(0);
    salt.fill(0);
    new Uint8Array(passwordBuffer).fill(0);
    new Uint8Array(saltBuffer).fill(0);
  }

  const elapsedMs = Math.max(1, performance.now() - startedAt);
  return Math.max(3, Math.min(12, Math.round(targetDurationMs / elapsedMs)));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}
