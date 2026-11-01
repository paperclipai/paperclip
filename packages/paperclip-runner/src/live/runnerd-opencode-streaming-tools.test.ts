import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { codexSemanticToolSpecs, dynamicToolResponse } from "../drivers/codex/codex-driver-values.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

const runner = defaultCapabilityRunnerdBinary();
const compilerAvailable = process.platform !== "win32" && spawnSync("cc", ["--version"]).status === 0;
const digest = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

it.skipIf(!compilerAvailable || !existsSync(runner)).each(["discovery", "completion"])(
  "acknowledges %s before its MCP deadline after a burst of streamed text",
  async tool => {
    const root = await mkdtemp(join(tmpdir(), "runnerd-opencode-streaming-"));
    try {
      const workspace = join(root, "workspace");
      const executable = join(root, "fake-opencode");
      await mkdir(workspace);
      const providerNode = process.platform === "linux" ? join(root, "node") : process.execPath;
      if (process.platform === "linux") {
        await cp(process.execPath, providerNode, { dereference: true });
        await chmod(providerNode, 0o500);
      }
      const fixture = resolve("test/fixtures/fake-opencode-server.mjs");
      execFileSync("cc", ["-x", "c", "-o", executable, "-"], {
        input: `#include <unistd.h>\n#include <stdlib.h>\nint main(int argc, char **argv) { char **args = calloc(argc + 2, sizeof(char *)); args[0] = ${JSON.stringify(providerNode)}; args[1] = ${JSON.stringify(fixture)}; for (int i = 1; i < argc; i++) args[i + 1] = argv[i]; execv(args[0], args); return 127; }`,
      });
      await chmod(executable, 0o755);
      const proxy = join(root, "opencode-app-server-proxy.cjs");
      const proxyBytes = execFileSync(process.execPath, ["--input-type=module", "-e", `
        import { bundleVerifiedProviderEntrypoints } from "./scripts/build-verified-provider-entrypoints.mjs";
        const entries = await bundleVerifiedProviderEntrypoints({ write: false });
        process.stdout.write(entries.find(({ entrypoint }) => entrypoint.name === "opencode-app-server-proxy").verifiedResult.outputFiles[0].contents);
      `], { maxBuffer: 16 * 1024 * 1024 });
      await writeFile(proxy, proxyBytes, { mode: 0o755 });
      const seen: string[] = [];
      const text: string[] = [];
      const { transport } = createRunnerdCodexTransport({
        provider: "opencode", runnerBinary: runner, stateDirectory: join(root, "state"), sourceCodexHome: "",
        providerNodeCommand: providerNode, providerNodeCommandSha256: digest(providerNode),
        opencodeCommand: executable, opencodeCommandSha256: digest(executable),
        opencodeProxyPath: proxy, opencodeProxySha256: digest(proxy),
        environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "synthetic-fixture-key" },
      });
      transport.setServerRequestHandler(async request => {
        seen.push(String(request.params.tool));
        return dynamicToolResponse(request.params.tool === "paperclip_finish" ? "Accepted completion." : { tools: [] });
      });
      let completed: Promise<void> | undefined;
      try {
        await transport.request("thread/start", {
          cwd: workspace, model: "openrouter/deepseek/deepseek-v4.1-flash-1017",
          completionContract: { revision: "streaming-tools-v1", criterionIds: ["objective"] },
          dynamicTools: [{ name: "paperclip_search_assigned_tools", description: "Search assigned synthetic tools.", inputSchema: { type: "object" } }, ...codexSemanticToolSpecs()],
        });
        completed = (async () => {
          for await (const event of transport.notifications()) {
            if (event.method === "item/agentMessage/delta") text.push(String(event.params.delta));
            if (event.method === "turn/completed") return;
          }
        })();
        await transport.request("turn/start", { input: [{ type: "text", text: `stream-backlog-${tool}` }] });
        await expect.poll(async () => {
          try { return JSON.parse(await readFile(join(workspace, "fake-stream-backlog-receipt.json"), "utf8")); }
          catch { return null; }
        }, { timeout: 15_000 }).toMatchObject({ acknowledged: true });
        await completed;
        expect(seen).toEqual(tool === "discovery" ? ["paperclip_search_assigned_tools", "paperclip_finish"] : ["paperclip_finish"]);
        expect(text.join("")).toBe("Streaming progress. ".repeat(800));
      } finally {
        await transport.close();
        await completed;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
