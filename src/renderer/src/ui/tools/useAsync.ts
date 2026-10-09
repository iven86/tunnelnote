import { useCallback, useState } from 'react';

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation failed.';
}

/** Runs an async action, exposing busy and error state. */
export function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (caught: unknown) {
      setError(errorText(caught));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { error, busy, run, setError };
}
