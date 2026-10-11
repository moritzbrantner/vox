// Session mutations (saves, deletes, restores) read the stored session list, change it and write
// it back to browser storage and, on desktop, the native corpus. Windows of the app share both
// stores, so each mutation holds one Web Lock for its whole duration; within a window a queue
// keeps them in call order. Without Web Locks only the queue applies.

export const SESSION_MUTATION_LOCK = "vox:session-mutations";

export type SessionMutationQueue = <T>(mutation: () => Promise<T>) => Promise<T>;

export function createSessionMutationQueue(
  options: { locks?: LockManager | null } = {},
): SessionMutationQueue {
  let tail: Promise<void> = Promise.resolve();
  return <T>(mutation: () => Promise<T>) => {
    // Resolved per mutation, so an omitted option follows navigator.locks as it is when it runs.
    const locks = options.locks === undefined ? defaultLockManager() : options.locks;
    const run = (): Promise<T> =>
      locks ? (locks.request(SESSION_MUTATION_LOCK, () => mutation()) as Promise<T>) : mutation();
    const operation = tail.then(run);
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
}

function defaultLockManager(): LockManager | null {
  return typeof navigator !== "undefined" && "locks" in navigator
    ? (navigator.locks ?? null)
    : null;
}
