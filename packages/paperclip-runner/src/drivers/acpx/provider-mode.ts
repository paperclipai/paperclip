import { parseProviderMode } from "../../contracts/provider-mode.js";
import { createCursorModeAdmission, resolveCursorSessionMode } from "./cursor-mode.js";

interface ModeAdmission {
  assertReady(): void;
  isReady(): boolean;
  createGuard(): (direction: "inbound" | "outbound", value: unknown) => void;
}

interface ProviderModeAdapter {
  resolve(mode: unknown): string;
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
