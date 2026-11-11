import { spawn, type ChildProcess } from "node:child_process";
import type { AcpRuntimeOptions } from "acpx/runtime";

// A type alias, not an interface, so callers can treat options as plain records.
export type AcpxAgentSpawnHooks = {
  /** Host-only child cwd (the remote relay); ACP still advertises `cwd`. */
  spawnCwd?: string;
  /** Observes agent stderr chunks; callback failures are ignored. */
  onAgentStderr?: (chunk: string) => void;
  /** Admits the agent process, not ACPX's own command probes; a rejection terminates it. */
  onAgentSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void> | void;
  /**
   * The agent's complete environment, read at each spawn. It replaces the one
   * ACPX derives from this process, so the agent never inherits host variables.
   */
  agentEnvironment?: () => Readonly<Record<string, string>>;
};

/**
 * Express the engine's spawn hooks with stock ACPX 0.22 options. ACPX calls
 * `spawnAgent` only for the agent process, so the agent's pid is known here;
 * `processLifecycle.onSpawned` also fires for command probes and is filtered
 * to that pid before admission. Its rejection terminates the child, as before.
 */
export function stockAcpRuntimeOptions<T extends AcpRuntimeOptions & AcpxAgentSpawnHooks>(
  options: T,
): Omit<T, keyof AcpxAgentSpawnHooks> {
  const { spawnCwd, onAgentStderr, onAgentSpawn, agentEnvironment, ...stock } = options;
  if (spawnCwd === undefined && !onAgentStderr && !onAgentSpawn && !agentEnvironment) return stock;
  const agentPids = new Set<number>();
  const launch = stock.spawnAgent
    ?? ((input: Parameters<NonNullable<AcpRuntimeOptions["spawnAgent"]>>[0]): ChildProcess => spawn(input.command, [...input.args], input.options));
  return {
    ...stock,
    spawnAgent: (input) => {
      const child = launch({ ...input, options: {
        ...input.options,
        ...(spawnCwd === undefined ? {} : { cwd: spawnCwd }),
        ...(agentEnvironment ? { env: { ...agentEnvironment() } } : {}),
      } });
      if (typeof child.pid === "number") agentPids.add(child.pid);
      if (onAgentStderr) {
        child.stderr?.on("data", (chunk: Buffer | string) => {
          try {
            onAgentStderr(String(chunk));
          } catch {
            // Observation never changes the agent's lifecycle.
          }
        });
      }
      return child;
    },
    ...(onAgentSpawn ? {
      processLifecycle: {
        ...stock.processLifecycle,
        onSpawned: async (process) => {
          await stock.processLifecycle?.onSpawned?.(process);
          if (agentPids.has(process.pid)) await onAgentSpawn({ pid: process.pid, startedAt: process.startedAt });
        },
      },
    } : {}),
  };
}

/**
 * ACPX 0.22 rejects raw command strings on Windows and only launches argv
 * arrays there. Split a configured command line with Windows rules: quotes
 * group words and backslashes are path separators, never escapes.
 */
export function splitWindowsAgentCommand(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let hasPart = false;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      hasPart = true;
    } else if (ch === "\"" || ch === "'") {
      quote = ch;
      hasPart = true;
    } else if (/\s/.test(ch)) {
      if (hasPart) parts.push(current);
      current = "";
      hasPart = false;
    } else {
      current += ch;
      hasPart = true;
    }
  }
  if (quote) throw new Error("Invalid agent command: unterminated quote");
  if (hasPart) parts.push(current);
  if (parts.length === 0 || parts[0] === "") throw new Error("Invalid agent command: empty command");
  return parts;
}

/**
 * ACPX reads `ACPX_AUTH_*` credentials from this process's environment for
 * agent authentication. In the shared server those would be host credentials
 * applied to every agent, so refuse to start rather than use them.
 */
export function assertNoHostAcpxAuthEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
  const names = Object.keys(environment).filter(name => name.toUpperCase().startsWith("ACPX_AUTH_"));
  if (names.length > 0) {
    throw new Error(`Remove ${names.join(", ")} from the Paperclip server environment; ACPX would use it to authenticate agents.`);
  }
}
