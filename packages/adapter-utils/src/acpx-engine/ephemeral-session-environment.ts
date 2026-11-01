import type { AcpSessionStore } from "acpx/runtime";

// ACPX saves one record from several writers (live checkpoint, turn end,
// finalize, close) with no lock. Each save renames a temp file onto the record
// file, and on Windows two overlapping renames onto one file fail with EPERM.
// Chain every save of one record so they never overlap.
const pendingSaves = new Map<string, Promise<void>>();

function saveInOrder(recordId: string, save: () => Promise<void>): Promise<void> {
  const previous = pendingSaves.get(recordId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(save);
  const settled = current.catch(() => undefined);
  pendingSaves.set(recordId, settled);
  void settled.then(() => {
    if (pendingSaves.get(recordId) === settled) pendingSaves.delete(recordId);
  });
  return current;
}

/** Keep the current run's environment in memory, outside persisted conversation state. */
export function createEphemeralSessionEnvironmentStore(
  persistedStore: AcpSessionStore,
  currentEnvironment: Readonly<Record<string, string>>,
): AcpSessionStore {
  return {
    async load(id) {
      const record = await persistedStore.load(id);
      if (!record) return undefined;
      return {
        ...record,
        acpx: {
          ...record.acpx,
          session_options: {
            ...record.acpx?.session_options,
            env: { ...currentEnvironment },
          },
        },
      };
    },
    save(record) {
      const persisted = { ...record };
      if (record.acpx?.session_options !== undefined) {
        const { env: _environment, ...sessionOptions } = record.acpx.session_options;
        persisted.acpx = { ...record.acpx, session_options: sessionOptions };
      }
      return saveInOrder(record.acpxRecordId, () => persistedStore.save(persisted));
    },
  };
}
