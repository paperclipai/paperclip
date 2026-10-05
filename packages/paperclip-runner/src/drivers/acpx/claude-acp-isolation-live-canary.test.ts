// Layer 3 of doc/plans/2026-10-03-claude-agent-acp-0.85.1-patch-report.md's
// Verification section: a live canary smoke. Layers 1 and 2 (installation
// integrity's "installed Claude ACP artifact actually carries the isolation
// gates", and claude-acp-isolation-gate.test.ts) prove the gate's shape and
// prove the exact `options` object handed to the SDK is correct. Neither
// ever spawns a real CLI, so neither can catch a gap where the *options are
// right but the real CLI still reads something off disk anyway*.
//
// This file does spawn a real `claude` CLI process against whatever
// credentials are active on this machine and sends one real prompt. That is
// real-world cost and footprint, so — like the existing
// `pnpm smoke:local-provider` — it is opt-in, never run by `pnpm test` or
// CI. Run it explicitly with:
//
//   PAPERCLIP_RUN_LIVE_ACP_CANARY=1 npx vitest run \
//     src/drivers/acpx/claude-acp-isolation-live-canary.test.ts
//
// What it proves: plant three "canaries" that normally belong to the
// project/local settings tiers claude-agent-acp's isolation gate is supposed
// to hide (a project .mcp.json server, a project .claude/skills/ skill, and
// a CLAUDE.md marker string), run one real isolated turn, and confirm none
// of the three reached the model. Two of the three are checked against the
// SDK's own structured `system`/`init` message fields (ground truth, no
// model cooperation needed — confirmed by reading @anthropic-ai/claude-agent
// -sdk@0.3.286's sdk.d.ts: `SDKSystemMessage` carries `mcp_servers: {name,
// status, source}[]` and `skills: string[]`). There is no equivalent
// structured field for a loaded CLAUDE.md's text, so that canary is checked
// by directly asking the model to echo it if present — the same technique
// run-local-provider-smoke.mjs already relies on via `expectedAssistantText`.
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const LIVE = process.env.PAPERCLIP_RUN_LIVE_ACP_CANARY === "1";

const CANARY_MCP_SERVER_NAME = "paperclip-canary-mcp";
const CANARY_SKILL_NAME = "canary";
const CANARY_MARKER = `PAPERCLIP_CANARY_MARKER_${randomBytes(8).toString("hex")}`;

function stubAcpClient() {
  const resolved = async () => undefined;
  return {
    sessionUpdate: vi.fn(resolved),
    requestPermission: vi.fn(resolved),
    readTextFile: vi.fn(resolved),
    writeTextFile: vi.fn(resolved),
    createElicitation: vi.fn(resolved),
    completeElicitation: vi.fn(resolved),
    extNotification: vi.fn(resolved),
  };
}

function stubLogger() {
  return { log: () => {}, error: () => {}, warn: () => {}, info: () => {} };
}

/** Forward every call/property untouched except `next()`, which is tapped
 * read-only so the real turn and real CLI process are never altered —
 * only observed. */
function tapQuery(real: any, onMessage: (message: any) => void) {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "next") {
        return async (...args: unknown[]) => {
          const result = await target.next(...args);
          if (!result.done) onMessage(result.value);
          return result;
        };
      }
      if (prop === Symbol.asyncIterator) {
        return () => receiver;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe.skipIf(!LIVE)(
  "claude-agent-acp 0.85.1 isolation gate (live canary smoke)",
  () => {
    let sdkEntryPath: string;
    let actualSdk: Record<string, any>;
    let capturedInit: any;
    let assistantText: string;
    const tempDirs: string[] = [];
    const originalIsolatedContext = process.env.PAPERCLIP_ACPX_ISOLATED_CONTEXT;
    const originalTaskToolBridgeUrl =
      process.env.PAPERCLIP_ACPX_TASK_TOOL_BRIDGE_URL;

    beforeAll(async () => {
      const requireFromTest = createRequire(import.meta.url);
      const acpPackageJsonPath = requireFromTest.resolve(
        "@agentclientprotocol/claude-agent-acp/package.json",
      );
      sdkEntryPath = createRequire(acpPackageJsonPath).resolve(
        "@anthropic-ai/claude-agent-sdk",
      );
      actualSdk = await vi.importActual(sdkEntryPath);

      vi.doMock(sdkEntryPath, () => ({
        ...actualSdk,
        query: (arg: unknown) =>
          tapQuery(actualSdk.query(arg), (message) => {
            if (message?.type === "system" && message?.subtype === "init") {
              capturedInit = message;
            }
            if (message?.type === "assistant") {
              const content = message.message?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block?.type === "text" && typeof block.text === "string") {
                    assistantText += block.text;
                  }
                }
              }
            }
          }),
      }));
    });

    afterAll(async () => {
      if (originalIsolatedContext === undefined) {
        delete process.env.PAPERCLIP_ACPX_ISOLATED_CONTEXT;
      } else {
        process.env.PAPERCLIP_ACPX_ISOLATED_CONTEXT = originalIsolatedContext;
      }
      if (originalTaskToolBridgeUrl === undefined) {
        delete process.env.PAPERCLIP_ACPX_TASK_TOOL_BRIDGE_URL;
      } else {
        process.env.PAPERCLIP_ACPX_TASK_TOOL_BRIDGE_URL =
          originalTaskToolBridgeUrl;
      }
      await Promise.all(
        tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
      );
    });

    async function runProbe(isolated: boolean) {
      capturedInit = undefined;
      assistantText = "";

      const tempDir = await mkdtemp(join(tmpdir(), "claude-acp-live-canary-"));
      tempDirs.push(tempDir);
      await writeFile(join(tempDir, "CLAUDE.md"), `${CANARY_MARKER}\n`);
      await writeFile(
        join(tempDir, ".mcp.json"),
        JSON.stringify(
          {
            mcpServers: {
              [CANARY_MCP_SERVER_NAME]: { command: "/bin/true", args: [] },
            },
          },
          null,
          2,
        ),
      );
      const skillDir = join(tempDir, ".claude", "skills", CANARY_SKILL_NAME);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          `name: ${CANARY_SKILL_NAME}`,
          "description: Canary skill planted by claude-acp-isolation-live-canary.test.ts. Must never be visible to an isolated session.",
          "---",
          "",
          "# Canary",
          "",
          "If you can read this, project-tier skill discovery leaked into an isolated session.",
          "",
        ].join("\n"),
      );

      if (isolated) process.env.PAPERCLIP_ACPX_ISOLATED_CONTEXT = "1";
      else delete process.env.PAPERCLIP_ACPX_ISOLATED_CONTEXT;
      delete process.env.PAPERCLIP_ACPX_TASK_TOOL_BRIDGE_URL;
      vi.resetModules();
      const { ClaudeAcpAgent } = (await import(
        "@agentclientprotocol/claude-agent-acp"
      )) as { ClaudeAcpAgent: new (client: unknown, logger: unknown) => any };

      const agent = new ClaudeAcpAgent(stubAcpClient(), stubLogger());
      const { sessionId } = await agent.newSession({
        cwd: tempDir,
        mcpServers: [],
      });
      try {
        await agent.prompt({
          sessionId,
          prompt: [
            {
              type: "text",
              text: `If, and only if, your current context contains a file whose entire content is a string starting with "PAPERCLIP_CANARY_MARKER_", reply with exactly that string and nothing else. Otherwise reply with exactly NONE and nothing else. Do not call any tools.`,
            },
          ],
        });
      } finally {
        await agent.closeSession({ sessionId }).catch(() => {});
      }

      expect(capturedInit, "the real CLI never emitted a system/init message").toBeDefined();
      return {
        mcpServerNames: (capturedInit.mcp_servers ?? []).map(
          (server: { name: string }) => server.name,
        ),
        skills: capturedInit.skills ?? [],
        assistantText,
      };
    }

    it(
      "an isolated session never sees a project .mcp.json server, a project skill, or a CLAUDE.md marker",
      async () => {
        const result = await runProbe(true);
        expect(result.mcpServerNames).not.toContain(CANARY_MCP_SERVER_NAME);
        expect(result.skills).not.toContain(CANARY_SKILL_NAME);
        expect(result.assistantText).not.toContain(CANARY_MARKER);
      },
      120_000,
    );

    // Mutation-check twin of the row above (same idea as the "isolation
    // unset" row in claude-acp-isolation-gate.test.ts): with isolation off,
    // the same three canaries must actually leak through. If this ever
    // stopped leaking too, the isolated row above would be passing
    // vacuously — it would mean project/local discovery silently broke for
    // everyone, isolated or not, not that isolation is doing anything.
    it(
      "control: the same canaries DO leak through when isolation is off",
      async () => {
        const result = await runProbe(false);
        expect(result.mcpServerNames).toContain(CANARY_MCP_SERVER_NAME);
        expect(result.skills).toContain(CANARY_SKILL_NAME);
        expect(result.assistantText).toContain(CANARY_MARKER);
      },
      120_000,
    );
  },
);
