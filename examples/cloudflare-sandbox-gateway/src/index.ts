import {
  getSandbox,
  proxyToSandbox,
  Sandbox as CloudflareSandbox,
} from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<PaperclipSandbox>;
  GATEWAY_TOKEN?: string;
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function unauthorized() {
  return json({ error: "Unauthorized" }, { status: 401 });
}

function readBearer(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function requireAuth(request: Request, env: Env) {
  const required = (env.GATEWAY_TOKEN ?? "").trim();
  if (!required) return true;
  return readBearer(request) === required;
}

function sandboxName(namespace: string, sandboxId: string) {
  return `${namespace}:${sandboxId}`;
}

function readSandbox(env: Env, namespace: string, sandboxId: string) {
  return getSandbox(env.Sandbox, sandboxName(namespace, sandboxId));
}

async function readBody(request: Request) {
  return (await request.json()) as Record<string, unknown>;
}

async function streamExec(
  sandbox: ReturnType<typeof getSandbox>,
  payload: Record<string, unknown>,
) {
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  const command = String(payload.command ?? "").trim();
  const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
  const env = typeof payload.env === "object" && payload.env !== null ? payload.env as Record<string, string> : {};

  const writeEvent = async (event: Record<string, unknown>) => {
    await writer.write(encoder.encode(`${JSON.stringify(event)}\n`));
  };

  queueMicrotask(async () => {
    try {
      const result = await sandbox.exec(command, {
        cwd,
        env,
        stream: true,
        onOutput: async (streamName: string, data: string) => {
          await writeEvent({
            type: streamName === "stderr" ? "stderr" : "stdout",
            chunk: data,
          });
        },
      });

      await writeEvent({
        type: "exit",
        exitCode: result.exitCode ?? null,
        signal: null,
        timedOut: false,
      });
    } catch (error) {
      await writeEvent({
        type: "stderr",
        chunk: `${error instanceof Error ? error.message : String(error)}\n`,
      });
      await writeEvent({
        type: "exit",
        exitCode: 1,
        signal: null,
        timedOut: false,
      });
    } finally {
      await writer.close();
    }
  });

  return new Response(stream.readable, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
    },
  });
}

export class Sandbox extends CloudflareSandbox {}
export class PaperclipSandbox extends CloudflareSandbox {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const proxy = await proxyToSandbox(request, env);
    if (proxy) return proxy;

    if (!requireAuth(request, env)) {
      return unauthorized();
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/v1/health") {
      return json({ ok: true, detail: "Cloudflare sandbox gateway ready" });
    }

    if (request.method === "POST" && url.pathname === "/v1/sandboxes") {
      const payload = await readBody(request);
      const sandboxId = String(payload.sandboxId ?? "").trim();
      if (!sandboxId) {
        return json({ error: "sandboxId is required" }, { status: 400 });
      }
      const namespace = String(payload.namespace ?? "paperclip").trim() || "paperclip";
      const sandbox = readSandbox(env, namespace, sandboxId);
      const sandboxEnv =
        typeof payload.env === "object" && payload.env !== null
          ? Object.fromEntries(
              Object.entries(payload.env as Record<string, unknown>).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            )
          : {};
      if (Object.keys(sandboxEnv).length > 0) {
        await sandbox.setEnvVars(sandboxEnv);
      }
      return json({ sandboxId });
    }

    const sandboxMatch = url.pathname.match(/^\/v1\/sandboxes\/([^/]+)(?:\/(exec|files))?$/);
    if (!sandboxMatch) {
      return json({ error: "Not found" }, { status: 404 });
    }

    const sandboxId = decodeURIComponent(sandboxMatch[1] ?? "");
    const suffix = sandboxMatch[2] ?? "";
    const namespace = url.searchParams.get("namespace") ?? "paperclip";
    const sandbox = readSandbox(env, namespace, sandboxId);

    if (request.method === "GET" && !suffix) {
      return json({ sandboxId, status: "running", endpoint: null });
    }

    if (request.method === "DELETE" && !suffix) {
      await sandbox.destroy();
      return json({ ok: true });
    }

    if (request.method === "POST" && suffix === "exec") {
      const payload = await readBody(request);
      return streamExec(sandbox, payload);
    }

    if (request.method === "PUT" && suffix === "files") {
      const payload = await readBody(request);
      await sandbox.writeFile(String(payload.path ?? ""), String(payload.content ?? ""));
      return json({ ok: true });
    }

    if (request.method === "GET" && suffix === "files") {
      const filePath = url.searchParams.get("path") ?? "";
      const result = await sandbox.readFile(filePath);
      return json({ content: result.content });
    }

    return json({ error: "Not found" }, { status: 404 });
  },
};
