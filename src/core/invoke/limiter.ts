/** Per-engine concurrency and per-minute limits (R5.1 `limits`). */
import type { LimitsDef } from "../rules";

const MINUTE = 60_000;

/** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** `promise`, or the signal's reason when it aborts first. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

interface Waiter {
  wake: () => void;
}

/** A slot gate for one engine: waits for a free slot and a free place in the last minute's budget. */
export function createLimiter(now: () => number = Date.now) {
  let active = 0;
  const starts: number[] = [];
  const queue: Waiter[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let limits: Pick<LimitsDef, "concurrency" | "perMinute"> = {};

  const pump = () => {
    clearTimeout(timer);
    timer = undefined;
    while (queue.length) {
      if (limits.concurrency && active >= limits.concurrency) return;
      const t = now();
      while (starts.length && starts[0]! <= t - MINUTE) starts.shift();
      if (limits.perMinute && starts.length >= limits.perMinute) {
        timer = setTimeout(pump, starts[0]! + MINUTE - t);
        return;
      }
      active++;
      if (limits.perMinute) starts.push(t);
      queue.shift()!.wake();
    }
  };

  return {
    /** Waits for a slot under `l`; call the returned release when the attempt ends. */
    async acquire(l: LimitsDef = {}, signal?: AbortSignal): Promise<() => void> {
      limits = l;
      if (signal?.aborted) throw signal.reason;
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          wake: () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
        };
        const onAbort = () => {
          const i = queue.indexOf(waiter);
          if (i >= 0) queue.splice(i, 1);
          reject(signal!.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        queue.push(waiter);
        pump();
      });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
        pump();
      };
    },
  };
}

export type Limiter = ReturnType<typeof createLimiter>;
