import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RoutineExceptionCapabilityBroker } from "./routine-exception-evaluation.js";
import { POL_APPROVAL_RELEASE_CAPABILITIES } from "./routine-exception-evaluators/pol-approval-release-v1.js";
import { POL_RUNTIME_SOURCE_OF_TRUTH_CAPABILITIES } from "./routine-exception-evaluators/pol-runtime-source-of-truth-v1.js";

const MAX_BROKER_OUTPUT_BYTES = 1024 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const ALLOWED_CAPABILITY_IDS = new Set<string>([
  ...POL_RUNTIME_SOURCE_OF_TRUTH_CAPABILITIES,
  ...POL_APPROVAL_RELEASE_CAPABILITIES,
]);

type BrokerProcessInput = {
  command: string;
  capabilityId: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
};

type HostBrokerDeps = {
  runtimeEnv?: Record<string, string | undefined>;
  verifyExecutable?: (command: string, expectedDigest: string) => Promise<void>;
  invokeProcess?: (input: BrokerProcessInput) => Promise<unknown>;
};

async function verifyExecutable(command: string, expectedDigest: string) {
  const digest = crypto.createHash("sha256").update(await readFile(command)).digest("hex");
  if (
    digest.length !== expectedDigest.length ||
    !crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(expectedDigest))
  ) {
    throw new Error("CAPABILITY_BROKER_DIGEST_MISMATCH");
  }
}

function invokeProcess({
  command,
  capabilityId,
  input,
  signal,
}: BrokerProcessInput): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const capture = (chunks: Buffer[], chunk: Buffer, currentBytes: number) => {
      const remaining = MAX_BROKER_OUTPUT_BYTES - currentBytes;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return currentBytes + chunk.length;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = capture(stdout, chunk, stdoutBytes);
      if (stdoutBytes > MAX_BROKER_OUTPUT_BYTES) child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = capture(stderr, chunk, stderrBytes);
      if (stderrBytes > MAX_BROKER_OUTPUT_BYTES) child.kill();
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code, closeSignal) => {
      if (stdoutBytes > MAX_BROKER_OUTPUT_BYTES || stderrBytes > MAX_BROKER_OUTPUT_BYTES) {
        reject(new Error("CAPABILITY_BROKER_OUTPUT_TOO_LARGE"));
        return;
      }
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 2_000);
        reject(new Error(`CAPABILITY_BROKER_FAILED:${code ?? closeSignal ?? "unknown"}:${detail}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch {
        reject(new Error("CAPABILITY_BROKER_RESULT_INVALID"));
      }
    });
    child.stdin.end(JSON.stringify({
      schemaVersion: 1,
      capabilityId,
      input,
    }));
  });
}

export function createHostProcessRoutineExceptionCapabilityBroker(
  deps: HostBrokerDeps = {},
): RoutineExceptionCapabilityBroker {
  const runtimeEnv = deps.runtimeEnv ?? process.env;
  const command = runtimeEnv.PAPERCLIP_ROUTINE_EXCEPTION_BROKER_EXECUTABLE?.trim() ?? "";
  const expectedDigest =
    runtimeEnv.PAPERCLIP_ROUTINE_EXCEPTION_BROKER_SHA256?.trim().toLowerCase() ?? "";
  const verify = deps.verifyExecutable ?? verifyExecutable;
  const invoke = deps.invokeProcess ?? invokeProcess;

  return {
    async invoke(capabilityId, input, signal) {
      if (!ALLOWED_CAPABILITY_IDS.has(capabilityId)) {
        throw new Error("CAPABILITY_DENIED");
      }
      if (!command || !path.isAbsolute(command) || !SHA256_HEX.test(expectedDigest)) {
        throw new Error("CAPABILITY_BROKER_UNAVAILABLE");
      }
      await verify(command, expectedDigest);
      return invoke({ command, capabilityId, input, signal });
    },
  };
}
