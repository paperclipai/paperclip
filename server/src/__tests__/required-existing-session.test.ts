import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execute as codex } from "../../../packages/adapters/codex-local/src/server/execute.js";
import { execute as cursor } from "../../../packages/adapters/cursor-local/src/server/execute.js";

describe("required existing CLI conversation", () => {
  it.each([
    ["codex", "unknown"],
    ["cursor", "unknown"],
    ["codex", "changed"],
    ["cursor", "changed"],
    ["codex", "signalled"],
    ["cursor", "signalled"],
    ["codex", "ordinary"],
    ["cursor", "ordinary"],
  ] as const)(
    "%s preserves the required session on %s",
    async (adapter, mode) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "required-session-"));
      const cwd = path.join(root, "work"),
        command = path.join(root, "agent.cjs"),
        count = path.join(root, "count");
      await mkdir(cwd);
      await writeFile(
        command,
        `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 0.160.0'); process.exit(0); }
const countPath = ${JSON.stringify(count)};
fs.writeFileSync(countPath, String(Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : 0) + 1));
fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(path.join(root, "args"))}, JSON.stringify(process.argv.slice(2)));
if (${JSON.stringify(mode)} === 'changed' || ${JSON.stringify(mode)} === 'signalled') {
  if (${JSON.stringify(adapter)} === 'codex') {console.log(JSON.stringify({type:'thread.started',thread_id:'fedcba98-4321-4567-8123-123456789abc'})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));}
  else {console.log(JSON.stringify({type:'system',subtype:'init',session_id:'fedcba98-4321-4567-8123-123456789abc'})); console.log(JSON.stringify({type:'result',subtype:'success',session_id:'fedcba98-4321-4567-8123-123456789abc',result:'new session'}));}
  if (${JSON.stringify(mode)} === 'signalled') process.kill(process.pid, 'SIGTERM');
  else process.exit(0);
}
if (${JSON.stringify(adapter)} === 'codex') console.error('Error: no rollout found for thread id 01234567-1234-4567-8123-123456789abc');
else console.log(JSON.stringify({type:'error',message:'Unknown session'}));
process.exit(1);
`,
      );
      await chmod(command, 0o755);
      try {
        const execute = adapter === "codex" ? codex : cursor;
        const result = await execute({
          runId: "required-session-test",
          agent: {
            id: "worker",
            companyId: "company",
            name: "Worker",
            adapterType: adapter === "codex" ? "codex_local" : "cursor",
            adapterConfig: { engine: "cli" },
          },
          runtime: {
            sessionId: "01234567-1234-4567-8123-123456789abc",
            sessionParams: {
              sessionId: "01234567-1234-4567-8123-123456789abc",
              cwd,
            },
            sessionDisplayId: null,
            taskKey: null,
          },
          config: {
            engine: "cli",
            command,
            cwd,
            promptTemplate: "Continue the retained conversation.",
          },
          context: { requireExistingSession: mode !== "ordinary" },
          authToken: "fixture-token",
          onLog: async () => {},
        });
        if (mode === "ordinary") {
          expect(result.errorCode).not.toBe("resume_session_unavailable");
          expect(await readFile(count, "utf8")).toBe("2");
        } else {
          expect(result.errorCode).toBe("resume_session_unavailable");
          expect(await readFile(count, "utf8")).toBe("1");
          expect(
            JSON.parse(await readFile(path.join(root, "args"), "utf8")),
          ).toContain("01234567-1234-4567-8123-123456789abc");
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
