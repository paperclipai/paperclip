import { AsyncLocalStorage } from "node:async_hooks";

interface HeldLock {
  readonly owner: object;
  readonly pluginId: string;
  released: boolean;
}

const queuesByOwner = new WeakMap<object, Map<string, Promise<void>>>();
const heldLocks = new AsyncLocalStorage<readonly HeldLock[]>();

function isHeld(owner: object, pluginId: string): boolean {
  return heldLocks.getStore()?.some((held) =>
    !held.released && held.owner === owner && held.pluginId === pluginId) ?? false;
}

function withHeld(held: HeldLock): HeldLock[] {
  return [...(heldLocks.getStore() ?? []).filter((lock) => !lock.released), held];
}

export async function runWithPluginReloadLock<T>(
  owner: object,
  pluginId: string,
  operation: () => Promise<T>,
  onWait?: () => void,
): Promise<T> {
  if (isHeld(owner, pluginId)) return operation();

  let queues = queuesByOwner.get(owner);
  if (!queues) {
    queues = new Map();
    queuesByOwner.set(owner, queues);
  }

  const previous = queues.get(pluginId);
  const held: HeldLock = { owner, pluginId, released: false };
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = (previous ?? Promise.resolve()).then(() => current);
  queues.set(pluginId, tail);

  try {
    if (previous) {
      onWait?.();
      await previous;
    }
    return await heldLocks.run(withHeld(held), operation);
  } finally {
    held.released = true;
    release();
    if (queues.get(pluginId) === tail) queues.delete(pluginId);
  }
}

export function runDetachedWithPluginReloadLock<T>(
  owner: object,
  pluginId: string,
  operation: () => Promise<T>,
  onWait?: () => void,
): Promise<T> {
  return heldLocks.exit(() => runWithPluginReloadLock(owner, pluginId, operation, onWait));
}
