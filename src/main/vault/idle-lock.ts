export class IdleLockTimer {
  private timeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private timeoutMs: number,
    private readonly onIdle: () => void,
  ) {}

  setTimeoutMs(ms: number): void {
    this.timeoutMs = ms;
  }

  start(): void {
    this.reset();
  }

  touch(): void {
    this.reset();
  }

  stop(): void {
    if (this.timeout !== undefined) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
  }

  private reset(): void {
    this.stop();
    this.timeout = setTimeout(() => {
      this.timeout = undefined;
      this.onIdle();
    }, this.timeoutMs);
  }
}
