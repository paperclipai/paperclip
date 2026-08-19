import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ProcessCodexAppServerTransport,
  createSanitizedCodexEnvironment,
  type CodexAppServerTransport,
  type CodexTransportProcessInfo,
} from "../drivers/codex/app-server-transport.js";
import { createIsolatedCodexAppServerArgs } from "../drivers/codex/codex-app-server-driver.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const executableSuffix = process.platform === "win32" ? ".exe" : "";

export interface CapabilityRunnerdProcessEvidence {
  runnerPid: number | null;
  runnerProcessGroupId: number | null;
  codexPid: number | null;
  runnerExited: boolean;
  runnerExitCode: number | null;
  runnerSignal: NodeJS.Signals | null;
  childEnvironmentKeys: string[];
  diagnostics: string[];
}

export interface CapabilityRunnerdCodexTransportOptions {
  runnerBinary?: string;
  codexCommand?: string;
  codexArgs?: string[];
  environment?: NodeJS.ProcessEnv;
  closeGraceMs?: number;
  onDiagnostic?: (message: string) => void;
  onEvidence?: (evidence: Readonly<CapabilityRunnerdProcessEvidence>) => void;
}

export interface CapabilityRunnerdCodexTransport {
  transport: CodexAppServerTransport;
  evidence(): Readonly<CapabilityRunnerdProcessEvidence>;
}

export function defaultCapabilityRunnerdBinary(): string {
  return resolve(
    packageRoot,
    `runner/target/debug/paperclip-runnerd${executableSuffix}`,
  );
}

/**
 * Starts the real package-local runnerd as process owner. runnerd then starts
 * the real Codex app-server and transparently proxies its stdio JSON-RPC.
 */
export function createCapabilityRunnerdCodexTransport(
  options: CapabilityRunnerdCodexTransportOptions = {},
): CapabilityRunnerdCodexTransport {
  const environment = createSanitizedCodexEnvironment(options.environment);
  const evidence: CapabilityRunnerdProcessEvidence = {
    runnerPid: null,
    runnerProcessGroupId: null,
    codexPid: null,
    runnerExited: false,
    runnerExitCode: null,
    runnerSignal: null,
    childEnvironmentKeys: Object.keys(environment).sort(),
    diagnostics: [],
  };
  const publish = () => options.onEvidence?.(structuredClone(evidence));
  const diagnostic = (message: string) => {
    evidence.diagnostics.push(message);
    if (evidence.diagnostics.length > 64) evidence.diagnostics.shift();
    const match = /capability codex proxy started runner_pid=(\d+) codex_pid=(\d+)/.exec(message);
    if (match) {
      evidence.runnerPid = Number(match[1]);
      evidence.codexPid = Number(match[2]);
    }
    options.onDiagnostic?.(message);
    publish();
  };
  const processUpdate = (info: CodexTransportProcessInfo) => {
    evidence.runnerPid = info.pid;
    evidence.runnerProcessGroupId = info.processGroupId;
    evidence.runnerExited = info.exited;
    evidence.runnerExitCode = info.exitCode;
    evidence.runnerSignal = info.signal;
    publish();
  };
  const codexArgs = options.codexArgs ?? createIsolatedCodexAppServerArgs(options.environment);
  const runnerArgs = [
    "--codex-app-server-proxy",
    "--codex-command",
    options.codexCommand ?? "codex",
    ...codexArgs.flatMap((argument) => ["--codex-arg", argument]),
  ];
  const transport = new ProcessCodexAppServerTransport({
    command: options.runnerBinary ?? defaultCapabilityRunnerdBinary(),
    args: runnerArgs,
    environment,
    processGroup: true,
    closeGraceMs: options.closeGraceMs,
    onDiagnostic: diagnostic,
    onProcess: processUpdate,
  });
  return {
    transport,
    evidence: () => structuredClone(evidence),
  };
}
