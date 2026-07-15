// Bounds how many agent dispatches run concurrently within a single workflow run.
//
// The permit is acquired around the *real* backend call and released when that
// call settles -- deliberately NOT when a race against the abort signal resolves.
// The backend honors abort asynchronously (its abort handler is a fire-and-forget
// interrupt), so releasing on the abort race would free the slot while the real
// dispatch is still in flight and let the next attempt over-subscribe the pool.
// Holding the permit until `generated` itself settles keeps the bound honest.
//
// This is not built on async-queue.ts: that is a value-stream AsyncIterable, not a
// permit primitive.
export class AgentConcurrencyPool {
  private available: number;
  private readonly waiters: PermitWaiter[] = [];

  constructor(public readonly size: number) {
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`AgentConcurrencyPool size must be a positive integer; got ${String(size)}.`);
    }
    this.available = size;
  }

  // Resolves with a release function once a permit is free. If `signal` aborts
  // before a permit is granted, rejects with an abort Error and holds nothing.
  // The returned release is idempotent; the caller owns calling it exactly when
  // the dispatch it guards has settled.
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(permitAbortError());
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(permitAbortError());
      };
      const waiter: PermitWaiter = {
        grant: () => {
          // Returns whether this waiter accepted the handed-off permit. A waiter
          // aborted between being shifted and granted returns false so the permit
          // moves to the next waiter (or back to the pool) instead of leaking.
          if (settled) return false;
          settled = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(this.makeRelease());
          return true;
        },
      };
      this.waiters.push(waiter);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.handOff();
    };
  }

  private handOff(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter?.grant()) return;
    }
    this.available += 1;
  }
}

interface PermitWaiter {
  grant: () => boolean;
}

function permitAbortError(): Error {
  return new Error('agent concurrency permit wait aborted');
}
