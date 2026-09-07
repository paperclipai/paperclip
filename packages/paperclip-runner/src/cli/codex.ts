#!/usr/bin/env node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createCodexTaskEnvelope } from "../contracts/codex.js";
import { CodexAppServerDriver } from "../drivers/codex/codex-app-server-driver.js";
import { runCodexCodexTracer } from "../mock-core/codex-runner.js";

interface CliOptions {
  workingDirectory?: string;
  output?: string;
  steer?: string;
  interrupt: boolean;
  json: boolean;
  denyReadWritePaths: string[];
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { interrupt: false, json: false, denyReadWritePaths: [] };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--") continue;
    if (value === "--json") options.json = true;
    else if (value === "--interrupt") options.interrupt = true;
    else if (value === "--working-directory") options.workingDirectory = args[++index];
    else if (value === "--output") options.output = args[++index];
    else if (value === "--steer") options.steer = args[++index];
    else if (value === "--deny-read-write-path") {
      const path = args[++index];
      if (path === undefined || path.trim().length === 0) {
        throw new Error("--deny-read-write-path requires a path");
      }
      options.denyReadWritePaths.push(resolve(path));
    }
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function formatSummary(trace: Awaited<ReturnType<typeof runCodexCodexTracer>>): string {
  const checks = Object.entries(trace.assertions)
    .map(([name, passed]) => `${passed ? "PASS" : "FAIL"} ${name}`)
    .join("\n");
  return [
    "Codex skillless Codex tracer",
    `driver session: ${trace.metadata.identity.driverSessionId}`,
    `provider session: ${trace.metadata.identity.providerSessionId}`,
    `model: ${trace.context.model} (${trace.context.modelProvider})`,
    `events: ${trace.events.length}`,
    trace.result === null
      ? `result: rejected — ${trace.resultDecision.issues.map((issue) => issue.message).join("; ")}`
      : `result: ${trace.result.reportedWorkDisposition} — ${trace.result.summary}`,
    checks,
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const workingDirectory = options.workingDirectory
    ? resolve(options.workingDirectory)
    : await mkdtemp(join(tmpdir(), "paperclip-codex-safe-"));
  await mkdir(workingDirectory, { recursive: true });
  const isolationCommand = options.denyReadWritePaths.length === 0
    ? null
    : [
        ...options.denyReadWritePaths.flatMap((path) => [
          `test ! -r ${shellQuote(path)}`,
          `test ! -w ${shellQuote(path)}`,
        ]),
        "test -z \"${CODEX_HOME+x}\"",
        "test -z \"${HOME+x}\"",
        "printf 'isolation enforced' > isolation-ok.txt",
        "printf 'isolation enforced\\n'",
      ].join(" && ");
  const envelope = createCodexTaskEnvelope({
    objective: isolationCommand === null
      ? "Create hello.txt in the working directory with exactly: hello from Codex runner"
      : "Prove filesystem isolation, then create the requested files in the working directory.",
    criteria: [
      { id: "file-created", requirement: "hello.txt exists in the supplied working directory." },
      { id: "exact-content", requirement: "hello.txt contains exactly 'hello from Codex runner'." },
      ...(isolationCommand === null
        ? []
        : [{
            id: "filesystem-isolated",
            requirement:
              "Run the supplied isolation command exactly; it must print 'isolation enforced' and create isolation-ok.txt with that exact content.",
          }]),
    ],
    constraints: [
      isolationCommand === null
        ? "Write only hello.txt inside the supplied working directory."
        : "Write only hello.txt and isolation-ok.txt inside the supplied working directory.",
      "Do not use network access.",
      "Do not discover or invoke skills.",
      "Do not call a control-plane API.",
      "Return one semantic completion result.",
      ...(isolationCommand === null
        ? []
        : [`Run this exact shell command before all other work: ${isolationCommand}`]),
      ...(options.steer !== undefined || options.interrupt
        ? ["Before changing files, run the shell command 'sleep 3' once so the operator can send a control command."]
        : []),
    ],
  });
  const driver = new CodexAppServerDriver({
    taskEnvelope: envelope,
    onDiagnostic: (message) => process.stderr.write(`[codex app-server] ${message}\n`),
  });
  const trace = await runCodexCodexTracer({
    driver,
    taskEnvelope: envelope,
    workingDirectory,
    steer: options.steer,
    interrupt: options.interrupt,
  });
  const serialized = `${JSON.stringify(trace, null, 2)}\n`;
  if (options.output) await writeFile(resolve(options.output), serialized, "utf8");
  process.stdout.write(options.json ? serialized : `${formatSummary(trace)}\nworkspace: ${workingDirectory}\n`);
  if (Object.values(trace.assertions).some((passed) => !passed)) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
