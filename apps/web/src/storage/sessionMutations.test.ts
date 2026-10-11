import { describe, expect, it } from "vitest";
import { SESSION_MUTATION_LOCK, createSessionMutationQueue } from "./sessionMutations";

// Acceptance tests for issue #102: session mutations are serialized across windows. Each window has
// its own queue; queues of different windows share one LockManager (the browser's navigator.locks).

type LockCallback = (lock: Lock | null) => unknown;

/** In-memory exclusive LockManager: one holder per name, waiters granted in request order. */
class FakeLockManager {
  readonly requested: string[] = [];
  private readonly held = new Map<string, Lock>();
  private readonly waiting = new Map<string, Array<() => void>>();

  request(
    name: string,
    optionsOrCallback: LockOptions | LockCallback,
    maybeCallback?: LockCallback,
  ) {
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const callback = (
      typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback
    ) as LockCallback;
    this.requested.push(name);
    if (options.ifAvailable && this.held.has(name)) {
      return Promise.resolve().then(() => callback(null));
    }
    return new Promise<unknown>((resolve, reject) => {
      const grant = () => {
        const lock = { name, mode: options.mode ?? "exclusive" } as Lock;
        this.held.set(name, lock);
        Promise.resolve()
          .then(() => callback(lock))
          .then(resolve, reject)
          .finally(() => {
            this.held.delete(name);
            const next = this.waiting.get(name)?.shift();
            next?.();
          });
      };
      if (this.held.has(name)) {
        const queue = this.waiting.get(name) ?? [];
        queue.push(grant);
        this.waiting.set(name, queue);
      } else {
        grant();
      }
    });
  }

  async query(): Promise<LockManagerSnapshot> {
    return {
      held: [...this.held.values()].map((lock) => ({ name: lock.name, mode: lock.mode })),
      pending: [],
    };
  }

  isHeld(name: string) {
    return this.held.has(name);
  }

  asLockManager() {
    return this as unknown as LockManager;
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** A mutation with several awaited steps, each recorded in `log`. */
function steppedMutation(log: string[], label: string, steps = 3) {
  return async () => {
    for (let step = 0; step < steps; step += 1) {
      log.push(`${label}:${step}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return label;
  };
}

describe("SESSION_MUTATION_LOCK", () => {
  it("is the agreed cross-window lock name", () => {
    expect(SESSION_MUTATION_LOCK).toBe("vox:session-mutations");
  });
});

describe("createSessionMutationQueue across windows", () => {
  it("never interleaves the mutations of two queues that share a lock manager", async () => {
    const locks = new FakeLockManager();
    const windowA = createSessionMutationQueue({ locks: locks.asLockManager() });
    const windowB = createSessionMutationQueue({ locks: locks.asLockManager() });
    const log: string[] = [];

    const results = await Promise.all([
      windowA(steppedMutation(log, "a1")),
      windowB(steppedMutation(log, "b1")),
      windowA(steppedMutation(log, "a2")),
      windowB(steppedMutation(log, "b2")),
    ]);

    expect(results).toEqual(["a1", "b1", "a2", "b2"]);
    // Each mutation's steps are contiguous: no other mutation ran in between.
    const labels = log.map((entry) => entry.split(":")[0]);
    const runs = labels.filter((label, index) => label !== labels[index - 1]);
    expect(runs).toHaveLength(4);
    expect(new Set(runs).size).toBe(4);
    expect(log).toHaveLength(12);
    expect(locks.requested.every((name) => name === SESSION_MUTATION_LOCK)).toBe(true);
    expect(locks.requested.length).toBeGreaterThan(0);
  });

  it("holds the lock for the whole mutation, so another window waits until it settles", async () => {
    const locks = new FakeLockManager();
    const windowA = createSessionMutationQueue({ locks: locks.asLockManager() });
    const windowB = createSessionMutationQueue({ locks: locks.asLockManager() });
    const gate = deferred();
    const log: string[] = [];

    const first = windowA(async () => {
      log.push("a:start");
      await gate.promise;
      log.push("a:end");
    });
    await flush();
    expect(locks.isHeld(SESSION_MUTATION_LOCK)).toBe(true);

    const second = windowB(async () => {
      log.push("b");
    });
    await flush();
    expect(log).toEqual(["a:start"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(log).toEqual(["a:start", "a:end", "b"]);
    expect(locks.isHeld(SESSION_MUTATION_LOCK)).toBe(false);
  });

  it("waits while another window holds the lock and runs once it is released", async () => {
    const locks = new FakeLockManager();
    const queue = createSessionMutationQueue({ locks: locks.asLockManager() });
    const otherWindow = deferred();
    const otherWindowAcquired = deferred();
    const otherWindowDone = locks.request(SESSION_MUTATION_LOCK, async () => {
      otherWindowAcquired.resolve();
      await otherWindow.promise;
    });
    await otherWindowAcquired.promise;

    let ran = false;
    const result = queue(async () => {
      ran = true;
      return 42;
    });
    await flush();
    expect(ran).toBe(false);

    otherWindow.resolve();
    await otherWindowDone;
    await expect(result).resolves.toBe(42);
    expect(ran).toBe(true);
  });
});

describe("createSessionMutationQueue within one window", () => {
  it("runs mutations one at a time in call order", async () => {
    const locks = new FakeLockManager();
    const queue = createSessionMutationQueue({ locks: locks.asLockManager() });
    const log: string[] = [];

    await Promise.all([
      queue(steppedMutation(log, "first")),
      queue(steppedMutation(log, "second")),
      queue(steppedMutation(log, "third")),
    ]);

    expect(log).toEqual([
      "first:0",
      "first:1",
      "first:2",
      "second:0",
      "second:1",
      "second:2",
      "third:0",
      "third:1",
      "third:2",
    ]);
  });

  it("rejects a failed mutation's own promise without blocking later ones", async () => {
    const locks = new FakeLockManager();
    const queue = createSessionMutationQueue({ locks: locks.asLockManager() });
    const log: string[] = [];

    const failing = queue(async () => {
      log.push("failing");
      await new Promise((resolve) => setTimeout(resolve, 0));
      throw new Error("disk full");
    });
    const later = queue(async () => {
      log.push("later");
      return "ok";
    });

    await expect(failing).rejects.toThrow("disk full");
    await expect(later).resolves.toBe("ok");
    expect(log).toEqual(["failing", "later"]);
    expect(locks.isHeld(SESSION_MUTATION_LOCK)).toBe(false);
  });

  it("also recovers from a mutation that throws synchronously", async () => {
    const queue = createSessionMutationQueue({ locks: new FakeLockManager().asLockManager() });
    const failing = queue((() => {
      throw new Error("sync failure");
    }) as () => Promise<never>);
    const later = queue(async () => "ok");

    await expect(failing).rejects.toThrow("sync failure");
    await expect(later).resolves.toBe("ok");
  });

  it("serializes in call order without Web Locks", async () => {
    const queue = createSessionMutationQueue({ locks: null });
    const log: string[] = [];

    const failing = queue(async () => {
      log.push("failing");
      throw new Error("nope");
    });
    const results = await Promise.all([
      queue(steppedMutation(log, "one", 2)),
      queue(steppedMutation(log, "two", 2)),
      failing.catch(() => "caught"),
    ]);

    expect(results).toEqual(["one", "two", "caught"]);
    expect(log).toEqual(["failing", "one:0", "one:1", "two:0", "two:1"]);
  });
});

describe("createSessionMutationQueue default lock manager", () => {
  it("uses navigator.locks when no lock manager is given", async () => {
    const locks = new FakeLockManager();
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      get: () => locks.asLockManager(),
    });
    try {
      const queue = createSessionMutationQueue();
      const gate = deferred();
      const pending = queue(() => gate.promise);
      await flush();
      expect(locks.requested).toContain(SESSION_MUTATION_LOCK);
      expect(locks.isHeld(SESSION_MUTATION_LOCK)).toBe(true);
      gate.resolve();
      await pending;
      expect(locks.isHeld(SESSION_MUTATION_LOCK)).toBe(false);
    } finally {
      if (descriptor) {
        Object.defineProperty(navigator, "locks", descriptor);
      } else {
        delete (navigator as { locks?: unknown }).locks;
      }
    }
  });

  it("still serializes when navigator.locks is absent", async () => {
    expect("locks" in navigator && navigator.locks).toBeFalsy();
    const queue = createSessionMutationQueue();
    const log: string[] = [];
    await Promise.all([queue(steppedMutation(log, "x", 2)), queue(steppedMutation(log, "y", 2))]);
    expect(log).toEqual(["x:0", "x:1", "y:0", "y:1"]);
  });
});
