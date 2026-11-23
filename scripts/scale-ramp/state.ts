import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface RunState {
  schema: "paperclip.scale-ramp.state/v1";
  label: string;
  baseUrl: string;
  companyId: string | null;
  companyCreated: boolean;
  environmentId: string | null;
  projectId: string | null;
  secretId: string | null;
  agentIds: string[];
  taskIds: string[];
  createdAt: string;
}

export const companyName = (label: string) => `Scale ramp ${label}`;
export const projectName = (label: string) => `Scale ramp ${label}`;
export const agentPrefix = (label: string) => `SR ${label} `;
export const agentName = (label: string, index: number) => `${agentPrefix(label)}${String(index + 1).padStart(4, "0")}`;
export const secretPrefix = (label: string) => `scale-ramp ${label} `;
export const taskTag = (label: string) => `[${label}]`;

export const statePath = (dir: string) => path.join(dir, "state.json");

export function emptyState(label: string, baseUrl: string, now: number): RunState {
  return {
    schema: "paperclip.scale-ramp.state/v1", label, baseUrl, companyId: null, companyCreated: false, environmentId: null,
    projectId: null, secretId: null, agentIds: [], taskIds: [], createdAt: new Date(now).toISOString(),
  };
}

export interface StateStore {
  save(state: RunState): Promise<void>;
  load(): Promise<RunState | null>;
}

export function fileStateStore(dir: string): StateStore {
  let queue: Promise<void> = Promise.resolve();
  const write = async (body: string) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = `${statePath(dir)}.${process.pid}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, statePath(dir));
  };
  return {
    save(state) {
      const body = `${JSON.stringify(state, null, 2)}\n`;
      const next = queue.then(() => write(body));
      queue = next.catch(() => undefined);
      return next;
    },
    async load() {
      try {
        return JSON.parse(await readFile(statePath(dir), "utf8")) as RunState;
      } catch {
        return null;
      }
    },
  };
}

export function memoryStateStore(initial: RunState | null = null): StateStore & { current: RunState | null } {
  const store = {
    current: initial ? structuredClone(initial) : null,
    async save(state: RunState) {
      store.current = structuredClone(state);
    },
    async load() {
      return store.current ? structuredClone(store.current) : null;
    },
  };
  return store;
}

export async function mapLimit<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && next < items.length) {
      const item = items[next]!;
      next += 1;
      try {
        await run(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw (failure as { error: unknown }).error;
}
