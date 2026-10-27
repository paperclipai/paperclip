import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { codexSemanticToolSpecs, dynamicToolResponse } from "../drivers/codex/codex-driver-values.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

const runner = defaultCapabilityRunnerdBinary();
const digest = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

it.skipIf(process.platform === "win32" || !existsSync(runner))(
  "retains assigned discovery authority across Rust, the proxy, and HTTP MCP",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "runnerd-opencode-assigned-"));
    try {
      const workspace = join(root, "workspace");
      const executable = join(root, "fake-opencode");
      await mkdir(workspace);
      // Linux launches verified executables from an unlinked, sealed memfd. Use
      // a native wrapper like the real OpenCode binary: Node cannot reopen a
      // shebang script through that deleted executable path.
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
      // Exercise the current production bundle even in a Rust-only test lane;
      // neither depend on nor overwrite another test's shared dist artifacts.
      const proxy = join(root, "opencode-app-server-proxy.cjs");
      const proxyBytes = execFileSync(process.execPath, ["--input-type=module", "-e", `
        import { bundleVerifiedProviderEntrypoints } from "./scripts/build-verified-provider-entrypoints.mjs";
        const entries = await bundleVerifiedProviderEntrypoints({ write: false });
        const proxy = entries.find(({ entrypoint }) => entrypoint.name === "opencode-app-server-proxy");
        process.stdout.write(proxy.verifiedResult.outputFiles[0].contents);
      `], { maxBuffer: 16 * 1024 * 1024 });
      await writeFile(proxy, proxyBytes, { mode: 0o755 });
      const operation = "paperclip_search_assigned_tools";
      const seen: string[] = [];
      const { transport } = createRunnerdCodexTransport({
        provider: "opencode", runnerBinary: runner, stateDirectory: join(root, "state"), sourceCodexHome: "",
        providerNodeCommand: providerNode, providerNodeCommandSha256: digest(providerNode),
        opencodeCommand: executable, opencodeCommandSha256: digest(executable),
        opencodeProxyPath: proxy, opencodeProxySha256: digest(proxy),
        environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "synthetic-fixture-key" },
      });
      transport.setServerRequestHandler(async request => {
        expect(request.method).toBe("item/tool/call");
        const tool = request.params.tool;
        expect([operation, "paperclip_finish"]).toContain(tool);
        seen.push(String(tool));
        return dynamicToolResponse(tool === operation ? { tools: [] } : "Accepted completion.");
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let primaryError: unknown;
      try {
        await transport.request("thread/start", {
          cwd: workspace, model: "openrouter/deepseek/deepseek-v4.1-flash-1017",
          completionContract: { revision: "assigned-tools-v1", criterionIds: ["objective"] },
          dynamicTools: [{ name: operation, description: "Search assigned synthetic tools.", inputSchema: { type: "object" } }, ...codexSemanticToolSpecs()],
        });
        const completed = (async () => {
          for await (const notification of transport.notifications()) {
            if (notification.method === "turn/completed") return;
            if (notification.method === "turn/failed") throw new Error("Native OpenCode turn failed");
          }
          throw new Error("Native OpenCode notifications ended before completion");
        })();
        await transport.request("turn/start", { input: [{ type: "text", text: "Discover assigned synthetic tools." }] });
        await Promise.race([completed, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Native assigned-tool smoke timed out")), 20_000);
        })]);
        expect(seen).toEqual([operation, "paperclip_finish"]);
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        try {
          await transport.close();
        } catch (cleanupError) {
          if (primaryError) {
            throw new AggregateError([primaryError, cleanupError], "Native OpenCode assigned-tool probe and cleanup failed", { cause: primaryError });
          }
          throw cleanupError;
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
