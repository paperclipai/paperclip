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

export interface Phase7RunnerdProcessEvidence {
  runnerPid: number | null;
  runnerProcessGroupId: number | null;
  codexPid: number | null;
  runnerExited: boolean;
  runnerExitCode: number | null;
  runnerSignal: NodeJS.Signals | null;
  childEnvironmentKeys: string[];
  diagnostics: string[];
}

export interface Phase7RunnerdCodexTransportOptions {
  runnerBinary?: string;
  codexCommand?: string;
  codexArgs?: string[];
  environment?: NodeJS.ProcessEnv;
  closeGraceMs?: number;
  onDiagnostic?: (message: string) => void;
  onEvidence?: (evidence: Readonly<Phase7RunnerdProcessEvidence>) => void;
}

export interface Phase7RunnerdCodexTransport {
  transport: CodexAppServerTransport;
  evidence(): Readonly<Phase7RunnerdProcessEvidence>;
}

export function defaultPhase7RunnerdBinary(): string {
  return resolve(
    packageRoot,
    `runner/target/debug/paperclip-runnerd${executableSuffix}`,
  );
}

/**
 * Starts the real package-local runnerd as process owner. runnerd then starts
 * the real Codex app-server and transparently proxies its stdio JSON-RPC.
 */
export function createPhase7RunnerdCodexTransport(
  options: Phase7RunnerdCodexTransportOptions = {},
): Phase7RunnerdCodexTransport {
  const environment = createSanitizedCodexEnvironment(options.environment);
  const evidence: Phase7RunnerdProcessEvidence = {
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
    const match = /phase7 codex proxy started runner_pid=(\d+) codex_pid=(\d+)/.exec(message);
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
    command: options.runnerBinary ?? defaultPhase7RunnerdBinary(),
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
