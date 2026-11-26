import { parseProviderMode } from "../../contracts/provider-mode.js";
import { createCursorModeAdmission, resolveCursorSessionMode } from "./cursor-mode.js";
import { ANTIGRAVITY_SWARM_MODE } from "./antigravity-swarm-guard.js";

interface ModeAdmission {
  assertReady(): void;
  isReady(): boolean;
  createGuard(): (direction: "inbound" | "outbound", value: unknown) => void;
}

interface ProviderModeAdapter {
  resolve(mode: unknown): string | undefined;
  admit(mode: string): ModeAdmission;
  configKey: string;
}

// This is an adapter capability registry, not a transport enum. An adapter
// must qualify mode selection and native acknowledgement before registering.
const adapters: Readonly<Record<string, ProviderModeAdapter | undefined>> = {
  cursor: {
    resolve: resolveCursorSessionMode,
    admit: mode => createCursorModeAdmission(resolveCursorSessionMode(mode)),
    configKey: "mode",
  },
  // `swarm` is set by Paperclip only for a turn the signed-in user started with
  // a trusted /swarm. It selects the Antigravity CLI route, whose own runtime
  // sets and verifies the native mode (antigravity-swarm-runtime.ts).
  antigravity: {
    resolve: mode => {
      if (mode === undefined) return undefined;
      if (mode !== ANTIGRAVITY_SWARM_MODE) throw new Error("ACPX antigravity supports only the swarm provider mode");
      return mode;
    },
    admit: () => { throw new Error("The Antigravity swarm route does not run through ACPX mode admission"); },
    configKey: "mode",
  },
};

export function resolveAcpxProviderMode(agent: string, mode: unknown): string | undefined {
  const identifier = parseProviderMode(mode);
  const adapter = adapters[agent];
  if (adapter) return adapter.resolve(identifier);
  if (identifier !== undefined) throw new Error(`ACPX ${agent} does not support configurable native modes`);
  return undefined;
}

export function createAcpxModeBinding(agent: string, mode: unknown) {
  const selectedMode = resolveAcpxProviderMode(agent, mode);
  if (selectedMode === undefined) return null;
  const adapter = adapters[agent]!;
  return { selectedMode, configKey: adapter.configKey, ...adapter.admit(selectedMode) };
}
