import type { AcpSessionStore } from "acpx/runtime";

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
      return persistedStore.save(persisted);
    },
  };
}
