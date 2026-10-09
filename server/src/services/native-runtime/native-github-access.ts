import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import {
  cleanupGitHubOperationLaunchers,
  prepareGitHubOperationLaunchers,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import { githubBrokerEnvironment } from "@paperclipai/adapter-utils/github-launcher";

type Binding = { companyId: string; agentId: string; issueId: string; runId: string };
type LauncherInput = Parameters<typeof prepareGitHubOperationLaunchers>[0];
export type NativeGitHubAccess = Awaited<ReturnType<typeof createNativeGitHubAccess>>;

/** A process-lifetime transport, with authority only while its controller owns a run.
 * No run token or GitHub credential is stored in the provider's environment/files.
 * The resolver still checks the active run and current identity/grants per operation.
 */
export async function createNativeGitHubAccess(input: {
  scope: Omit<Binding, "runId">;
  target: LauncherInput["target"];
  cwd: string;
  env: NodeJS.ProcessEnv;
  resolveCredentials: (binding: Binding) => Promise<unknown>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}, startBridge = startAdapterExecutionTargetPaperclipBridge) {
  const token = randomBytes(32).toString("hex");
  const location = { runId: `native-session-${randomUUID()}`, target: input.target };
  let active: Binding | null = null;
  let stopped = false;
  let ready = true;
  let stopping: Promise<void> | undefined;
  let bridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    req.resume();
    const reply = (status: number, body: unknown) => {
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
    const bearer = req.headers.authorization ?? "";
    const expected = `Bearer ${token}`;
    if (req.headers.origin || req.headers.cookie || req.headers["sec-fetch-site"] ||
        Buffer.byteLength(bearer) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(bearer), Buffer.from(expected))) {
      reply(403, { error: "GitHub session authentication required" });
      return;
    }
    if (req.method !== "POST" || req.url !== "/runtime-tools/github/credentials") {
      reply(404, { error: "Unknown GitHub session operation" });
      return;
    }
    const binding = active;
    if (!binding || stopped) {
      reply(403, { error: "No active GitHub run" });
      return;
    }
    try {
      // Bind at receipt; body/headers cannot select a run or responsible user.
      const result = await input.resolveCredentials({ ...binding });
      if (active !== binding || stopped) {
        reply(403, { error: "GitHub run ended during credential acquisition" });
        return;
      }
      reply(200, result);
    } catch (error) {
      const status = (error as { status?: number })?.status;
      // Never leak secret-store/provider errors. Preserve steering's retry signal.
      reply(status === 409 ? 409 : status === 403 ? 403 : 503,
        { error: "GitHub credentials unavailable" });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const stop = () => stopping ??= (async () => {
    stopped = true;
    active = null;
    server.closeAllConnections();
    const results = await Promise.allSettled([
      bridge?.stop(),
      new Promise<void>(resolve => server.close(() => resolve())),
      cleanupGitHubOperationLaunchers(location),
    ]);
    if (results.some(result => result.status === "rejected")) {
      await input.onLog?.("stderr", "[paperclip] GitHub session cleanup incomplete.\n").catch(() => undefined);
    }
  })();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("GitHub broker did not listen");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      bridge = await startBridge({
        ...location,
        runtimeRootDir: input.target?.kind === "remote"
          ? path.posix.join(input.target.remoteCwd, ".paperclip-runtime", "github", location.runId)
          : null,
        adapterKey: "native-github",
        hostApiToken: token,
        hostApiUrl: url,
        onLog: input.onLog,
      });
      if (input.target?.kind === "remote" && !bridge) {
        throw new Error("GitHub session requires a remote callback bridge");
      }
    } catch {
      // GitHub remains optional. Stage anonymous wrappers for this session;
      // the supervisor retries transport setup on the next run.
      ready = false;
      await new Promise<void>(resolve => server.close(() => resolve()));
      await input.onLog?.("stderr", "[paperclip] GitHub runtime transport unavailable; continuing without managed GitHub access.\n").catch(() => undefined);
    }
    const env = await prepareGitHubOperationLaunchers({
      ...location, cwd: input.cwd,
      env: {
        ...githubBrokerEnvironment({ PATH: input.env.PATH }, {
          url: ready ? bridge?.env.PAPERCLIP_API_URL ?? url : "",
          token: ready ? bridge?.env.PAPERCLIP_API_KEY ?? token : "",
        }),
        // Never retain an old run's bridge authentication override.
        PAPERCLIP_GITHUB_BRIDGE_TOKEN: ready ? bridge?.env.PAPERCLIP_API_KEY ?? token : "",
      },
    });
    return {
      env,
      ready,
      activate(binding: Binding) {
        if (stopped || active) throw new Error("GitHub session is closed or busy");
        if (binding.companyId !== input.scope.companyId || binding.agentId !== input.scope.agentId ||
            binding.issueId !== input.scope.issueId) throw new Error("GitHub session scope mismatch");
        const owner = { ...binding };
        active = owner;
        return () => { if (active === owner) active = null; };
      },
      stop,
    };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}
