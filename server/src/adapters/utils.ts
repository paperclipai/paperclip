// Re-export everything from the shared adapter-utils/server-utils package.
// This file is kept as a convenience shim so existing in-tree
// imports (process/, http/, heartbeat.ts) don't need rewriting.
import type { ChildProcess } from "node:child_process";
import { logger } from "../middleware/logger.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";
export type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

export const runningProcesses: Map<string, { child: ChildProcess; graceSec: number }> =
  serverUtils.runningProcesses;
export const MAX_CAPTURE_BYTES = serverUtils.MAX_CAPTURE_BYTES;
export const MAX_EXCERPT_BYTES = serverUtils.MAX_EXCERPT_BYTES;
export const parseObject = serverUtils.parseObject;
export const asString = serverUtils.asString;
export const asNumber = serverUtils.asNumber;
export const asBoolean = serverUtils.asBoolean;
export const asStringArray = serverUtils.asStringArray;
export const parseJson = serverUtils.parseJson;
export const appendWithCap = serverUtils.appendWithCap;
export const resolvePathValue = serverUtils.resolvePathValue;
export const renderTemplate = serverUtils.renderTemplate;
export const redactEnvForLogs = serverUtils.redactEnvForLogs;
export const buildPaperclipEnv = serverUtils.buildPaperclipEnv;
export const defaultPathForPlatform = serverUtils.defaultPathForPlatform;
export const ensurePathInEnv = serverUtils.ensurePathInEnv;
export const ensureAbsoluteDirectory = serverUtils.ensureAbsoluteDirectory;
export const ensureCommandResolvable = serverUtils.ensureCommandResolvable;
export const resolveCommandForLogs = serverUtils.resolveCommandForLogs;
export const buildInvocationEnvForLogs = serverUtils.buildInvocationEnvForLogs;

// Re-export runChildProcess with the server's pino logger wired in.
const _runChildProcess = serverUtils.runChildProcess;

export async function runChildProcess(
  runId: string,
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  },
): Promise<serverUtils.RunProcessResult> {
  return _runChildProcess(runId, command, args, {
    ...opts,
    onLogError: (err, id, msg) => logger.warn({ err, runId: id }, msg),
  });
}
