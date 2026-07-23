import { getSandbox, proxyToSandbox, type Sandbox as SandboxDO } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<SandboxDO>;
  STATE: KVNamespace;
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  PUBLIC_HOST: string;
  PREVIEW_HOST: string;
  ANTHROPIC_API_KEY?: string;
}

const SANDBOX_ID = "agency-main";
const PAPERCLIP_PORT = 3100;
const TERMINAL_PORT = 7681;

async function log(env: Env, event: string, detail: string) {
  try {
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS boot_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT CURRENT_TIMESTAMP, event TEXT, detail TEXT)"
    );
    await env.DB.prepare("INSERT INTO boot_log (event, detail) VALUES (?, ?)")
      .bind(event, detail)
      .run();
  } catch {
    // logging is best-effort
  }
}

async function ensureServices(env: Env, requestHost: string) {
  const sandbox = getSandbox(env.Sandbox, SANDBOX_ID);

  const procsRes = (await sandbox.listProcesses()) as
    | { processes?: Array<{ command?: string; status?: string }> }
    | Array<{ command?: string; status?: string }>;
  const procs = Array.isArray(procsRes) ? procsRes : procsRes?.processes ?? [];
  const running = (needle: string) =>
    procs.some(
      (p) => (p.command ?? "").includes(needle) && p.status !== "completed" && p.status !== "failed"
    );

  const publicUrl = `https://${PAPERCLIP_PORT}-${SANDBOX_ID}-app.${env.PREVIEW_HOST}`;

  if (!running("start-paperclip")) {
    await sandbox.startProcess("/opt/start-paperclip.sh", {
      env: {
        HOST: "0.0.0.0",
        PORT: String(PAPERCLIP_PORT),
        PAPERCLIP_HOME: "/paperclip",
        PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
        PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
        PAPERCLIP_PUBLIC_URL: publicUrl,
        ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
      },
    });
    await log(env, "start", "paperclipai");
  }

  if (!running("/opt/terminal/server.js")) {
    await sandbox.startProcess("node /opt/terminal/server.js", {
      env: {
        PORT: String(TERMINAL_PORT),
        ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
      },
    });
    await log(env, "start", "terminal");
  }

  const exposedRes = (await sandbox.getExposedPorts(env.PREVIEW_HOST || requestHost)) as
    | { ports?: Array<{ port: number; url: string }> }
    | Array<{ port: number; url: string }>;
  const ports = Array.isArray(exposedRes) ? exposedRes : exposedRes?.ports ?? [];
  const urls: Record<string, string> = {};

  for (const [name, port, token] of [
    ["paperclip", PAPERCLIP_PORT, "app"],
    ["terminal", TERMINAL_PORT, "term"],
  ] as const) {
    const existing = ports.find((p: { port: number; url: string }) => p.port === port);
    if (existing) {
      urls[name] = existing.url;
    } else {
      // Stable tokens => deterministic first-level subdomains of the zone,
      // covered by Universal SSL (no wildcard cert needed for *.agency.*).
      const preview = await sandbox.exposePort(port, {
        hostname: env.PREVIEW_HOST || requestHost,
        name,
        token,
      });
      urls[name] = preview.url;
    }
  }

  await env.STATE.put(
    "services",
    JSON.stringify({ sandboxId: SANDBOX_ID, urls, updatedAt: new Date().toISOString() })
  );

  return urls;
}

function landingPage(urls: Record<string, string>): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Paperclip Agency</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0d1017;color:#e6e6e6;display:flex;flex-direction:column;min-height:100vh}
  header{padding:20px 28px;border-bottom:1px solid #232838;display:flex;align-items:center;gap:12px}
  header h1{font-size:16px;margin:0;font-weight:600}
  header .dot{width:10px;height:10px;border-radius:50%;background:#4ade80}
  main{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px}
  .card{border:1px solid #232838;border-radius:10px;overflow:hidden;display:flex;flex-direction:column;min-height:70vh}
  .card h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;margin:0;padding:10px 14px;background:#131826;color:#9aa4bf;display:flex;justify-content:space-between}
  .card h2 a{color:#7dd3fc;text-decoration:none}
  iframe{border:0;flex:1;width:100%;background:#0d1017}
  @media(max-width:1000px){main{grid-template-columns:1fr}}
</style></head>
<body>
<header><span class="dot"></span><h1>paperclip @ agency.bitbuilder.dev — Cloudflare Sandbox</h1></header>
<main>
  <div class="card"><h2>Paperclip Control Plane <a href="${urls.paperclip}" target="_blank">open ↗</a></h2><iframe src="${urls.paperclip}"></iframe></div>
  <div class="card"><h2>Terminal (ghostty-web) <a href="${urls.terminal}" target="_blank">open ↗</a></h2><iframe src="${urls.terminal}"></iframe></div>
</main>
</body></html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const proxied = await proxyToSandbox(request, env);
    if (proxied) return proxied;

    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, worker: "paperclip-agency" });
    }

    if (url.pathname === "/api/state") {
      const state = await env.STATE.get("services");
      return Response.json(state ? JSON.parse(state) : { status: "not booted" });
    }

    if (url.pathname === "/api/log") {
      const rows = await env.DB.prepare(
        "SELECT * FROM boot_log ORDER BY id DESC LIMIT 50"
      ).all().catch(() => ({ results: [] }));
      return Response.json(rows.results ?? []);
    }

    if (url.pathname === "/api/boot" || url.pathname === "/") {
      try {
        const urls = await ensureServices(env, url.host);
        if (url.pathname === "/api/boot") return Response.json({ ok: true, urls });
        return new Response(landingPage(urls), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      } catch (err) {
        await log(env, "error", (err as Error)?.stack ?? String(err));
        return new Response(`boot failed: ${String(err)}`, { status: 500 });
      }
    }

    return new Response("not found", { status: 404 });
  },
};
