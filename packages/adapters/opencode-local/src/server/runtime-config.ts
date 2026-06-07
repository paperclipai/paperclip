import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";

type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
};

function resolveXdgConfigHome(env: Record<string, string>): string {
  return (
    (typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()) ||
    (typeof process.env.XDG_CONFIG_HOME === "string" && process.env.XDG_CONFIG_HOME.trim()) ||
    path.join(os.homedir(), ".config")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(filepath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filepath, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

type ProxyHandle = { proxyUrl: string; close: () => Promise<void> };

// Starts a local HTTP proxy that transparently forwards all requests to
// `targetBaseUrl`, but injects `think: false` into POST request bodies whose
// `model` field matches /gemma4/i. This suppresses Gemma 4 harmony-channel
// thinking tokens without any opencode config schema changes (opencode strips
// unknown model-config fields like `providerOptions`).
function startGemma4ThinkProxy(targetBaseUrl: string): Promise<ProxyHandle> {
  return new Promise((resolve, reject) => {
    let targetOrigin: string;
    let targetPathname: string;
    try {
      const parsed = new URL(targetBaseUrl);
      targetOrigin = parsed.origin;
      targetPathname = parsed.pathname === "/" ? "" : parsed.pathname;
    } catch {
      reject(new Error(`Invalid Ollama baseURL: ${targetBaseUrl}`));
      return;
    }

    const server = http.createServer((clientReq, clientRes) => {
      const chunks: Buffer[] = [];
      clientReq.on("data", (chunk: Buffer) => chunks.push(chunk));
      clientReq.on("end", () => {
        let body = Buffer.concat(chunks);

        if (clientReq.method === "POST" && body.length > 0) {
          try {
            const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
            const model = typeof parsed.model === "string" ? parsed.model : "";
            if (/gemma4/i.test(model) && !("think" in parsed)) {
              parsed.think = false;
              body = Buffer.from(JSON.stringify(parsed));
            }
          } catch {
            // Non-JSON body — forward unchanged
          }
        }

        const forwardHeaders: http.OutgoingHttpHeaders = { ...clientReq.headers };
        const targetHostname = new URL(targetOrigin).hostname;
        const targetPort = new URL(targetOrigin).port;
        forwardHeaders["host"] = targetPort
          ? `${targetHostname}:${targetPort}`
          : targetHostname;
        if (body.length > 0) forwardHeaders["content-length"] = String(body.length);
        delete forwardHeaders["transfer-encoding"];

        const proxyReq = http.request(
          {
            hostname: targetHostname,
            port: targetPort ? Number(targetPort) : 80,
            path: clientReq.url ?? "/",
            method: clientReq.method,
            headers: forwardHeaders,
          },
          (proxyRes) => {
            clientRes.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
            proxyRes.pipe(clientRes);
          },
        );

        proxyReq.on("error", () => {
          if (!clientRes.headersSent) clientRes.writeHead(502);
          clientRes.end();
        });

        if (body.length > 0) proxyReq.write(body);
        proxyReq.end();
      });
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const proxyUrl = `http://127.0.0.1:${port}${targetPathname}`;
      resolve({
        proxyUrl,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

export async function prepareOpenCodeRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  targetIsRemote?: boolean;
}): Promise<PreparedOpenCodeRuntimeConfig> {
  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, true);
  if (!skipPermissions) {
    return {
      env: input.env,
      notes: [],
      cleanup: async () => {},
    };
  }

  // For remote execution targets the host XDG_CONFIG_HOME path is meaningless
  // (and actively harmful — it leaks a macOS-only path into the remote Linux
  // env). Callers that need to ship a runtime opencode config to the remote
  // box do that via prepareAdapterExecutionTargetRuntime in execute.ts; this
  // host-fs helper is local-only.
  if (input.targetIsRemote) {
    return {
      env: input.env,
      notes: [],
      cleanup: async () => {},
    };
  }

  const sourceConfigDir = path.join(resolveXdgConfigHome(input.env), "opencode");
  const runtimeConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-config-"));
  const runtimeConfigDir = path.join(runtimeConfigHome, "opencode");
  const runtimeConfigPath = path.join(runtimeConfigDir, "opencode.json");

  await fs.mkdir(runtimeConfigDir, { recursive: true });
  try {
    await fs.cp(sourceConfigDir, runtimeConfigDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      throw err;
    }
  }

  const existingConfig = await readJsonObject(runtimeConfigPath);
  const existingPermission = isPlainObject(existingConfig.permission)
    ? existingConfig.permission
    : {};
  const nextConfig: Record<string, unknown> = {
    ...existingConfig,
    permission: {
      ...existingPermission,
      external_directory: "allow",
    },
  };

  const notes: string[] = [
    "Injected runtime OpenCode config with permission.external_directory=allow to avoid headless approval prompts.",
  ];

  // Opencode strips unknown model-config fields (e.g. providerOptions, thinking),
  // so config-level think suppression does not work. Instead, for each provider
  // whose model map contains a gemma4 key, start a thin HTTP proxy that injects
  // `think: false` into POST bodies before forwarding to the real Ollama endpoint.
  const proxyHandles: Array<{ close: () => Promise<void> }> = [];
  if (isPlainObject(nextConfig.provider)) {
    for (const providerData of Object.values(nextConfig.provider)) {
      if (!isPlainObject(providerData)) continue;
      const models = isPlainObject(providerData.models) ? providerData.models : {};
      const hasGemma4 = Object.keys(models).some((k) => /gemma4/i.test(k));
      if (!hasGemma4) continue;
      const options = isPlainObject(providerData.options) ? providerData.options : {};
      const baseURL = typeof options.baseURL === "string" ? options.baseURL : null;
      if (!baseURL) continue;

      const proxy = await startGemma4ThinkProxy(baseURL);
      proxyHandles.push(proxy);
      providerData.options = { ...options, baseURL: proxy.proxyUrl };
      notes.push(
        `Started think:false proxy for Gemma 4 models (${baseURL} → ${proxy.proxyUrl}).`,
      );
    }
  }

  await fs.writeFile(runtimeConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  return {
    env: {
      ...input.env,
      XDG_CONFIG_HOME: runtimeConfigHome,
    },
    notes,
    cleanup: async () => {
      await Promise.all([
        fs.rm(runtimeConfigHome, { recursive: true, force: true }),
        ...proxyHandles.map((h) => h.close()),
      ]);
    },
  };
}
