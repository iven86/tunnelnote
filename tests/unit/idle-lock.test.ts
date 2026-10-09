import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdleLockTimer } from '../../src/main/vault/idle-lock';

describe('IdleLockTimer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resets on activity and locks when idle', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const timer = new IdleLockTimer(1_000, onIdle);

    timer.start();
    vi.advanceTimersByTime(800);
    timer.touch();
    vi.advanceTimersByTime(800);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onIdle).toHaveBeenCalledOnce();
    timer.stop();
  });
});
