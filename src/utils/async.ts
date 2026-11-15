export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `sleep` that stops early when `signal` aborts, rejecting with its reason.
 *
 * For deliberate waits measured in minutes, where a job deleted or timed out
 * meanwhile must not wake up later and act on an account nobody is waiting for.
 */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
