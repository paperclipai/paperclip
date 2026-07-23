/**
 * Pure helpers for the Cloudflare Sandbox deployment Worker.
 *
 * Everything here is side-effect free so it can be unit tested without a
 * Workers runtime (see ../test/lib.test.ts).
 */

/** Port the Paperclip server listens on inside the sandbox container. */
export const PAPERCLIP_PORT = 3100;

/**
 * Stable sandbox id. One deployment == one Paperclip control plane, so a
 * fixed id always routes to the same Durable Object / container.
 */
export const SANDBOX_ID = "paperclip";

/** Boot script baked into the container image (container/Dockerfile). */
export const START_COMMAND = "/opt/start-paperclip.sh";

/**
 * Optional R2 binding name for durable attachment storage. When the binding
 * exists, the Worker FUSE-mounts the bucket (credential-less, via the SDK's
 * egress interception) at Paperclip's local-disk storage directory before
 * boot, so uploaded files survive container recycling.
 */
export const ARTIFACTS_BINDING = "ARTIFACTS";

/**
 * Paperclip's local_disk storage provider path (docs/deploy/storage.md)
 * under PAPERCLIP_HOME=/paperclip. Only file uploads live here — never the
 * Postgres data directory, which must not sit on a FUSE mount.
 */
export const STORAGE_MOUNT_PATH = "/paperclip/instances/default/data/storage";

/**
 * Fixed uid/gid of the non-root `paperclip` user created in
 * container/Dockerfile (useradd -u). Pinned so the s3fs mount can be owned
 * by that user; test/config.test.ts enforces the pin matches the Dockerfile.
 */
export const PAPERCLIP_UID = 4100;

/**
 * s3fs options for the attachments mount: expose it as owned by the
 * `paperclip` user (s3fs mounts as root and rejects chown) and allow other
 * users to traverse it. The SDK's R2 defaults are applied on top.
 */
export function storageMountOptions(): { s3fsOptions: string[] } {
  return {
    s3fsOptions: [
      "allow_other",
      `uid=${PAPERCLIP_UID}`,
      `gid=${PAPERCLIP_UID}`,
      "umask=0022",
    ],
  };
}

/** Benign when two isolates race to mount the same path — first one wins. */
export function isMountAlreadyInUse(error: unknown): boolean {
  return error instanceof Error && /already in use/i.test(error.message);
}

/** Process states that mean "no longer serving" (safe to start a new one). */
const DEAD_STATUSES = new Set(["completed", "failed", "killed", "stopped"]);

export interface ProcessLike {
  command?: string;
  status?: string;
}

/** True when the request is a WebSocket upgrade that must not be buffered. */
export function isWebSocketUpgrade(headers: Headers): boolean {
  return headers.get("Upgrade")?.toLowerCase() === "websocket";
}

/** Cookie set once a visitor presents the bootstrap token. */
export const BOOTSTRAP_COOKIE = "paperclip_bootstrap";

/** Query parameter used to present the bootstrap token on first visit. */
export const BOOTSTRAP_PARAM = "bootstrap_token";

/** Minimal cookie-header lookup (no parsing library needed for one value). */
export function getCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** 401 page shown while the deployment is gated by BOOTSTRAP_TOKEN. */
export function accessDeniedPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Paperclip — access restricted</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       font-family:ui-sans-serif,system-ui,sans-serif;background:#0d1017;color:#e6e6e6}
  main{max-width:34rem;padding:2rem}
  h1{font-size:1.1rem;font-weight:600;margin:0 0 .5rem}
  p{margin:.35rem 0;color:#9aa4bf;font-size:.9rem}
  code{color:#7dd3fc}
</style>
</head>
<body>
<main>
  <h1>Access restricted</h1>
  <p>This Paperclip deployment is gated by a bootstrap token.</p>
  <p>Open the URL with <code>?${BOOTSTRAP_PARAM}=&lt;your token&gt;</code> —
     the value you set with <code>wrangler secret put BOOTSTRAP_TOKEN</code>.</p>
  <p>Once the operator account is claimed, the operator can remove the gate
     with <code>wrangler secret delete BOOTSTRAP_TOKEN</code>.</p>
</main>
</body>
</html>`;
}

/** True when a live Paperclip boot process already exists in the sandbox. */
export function isPaperclipRunning(processes: ProcessLike[]): boolean {
  return processes.some(
    (p) => (p.command ?? "").includes(START_COMMAND) && !DEAD_STATUSES.has(p.status ?? "")
  );
}

export interface PaperclipEnvOptions {
  /** Public origin the instance is reachable at, e.g. https://x.workers.dev */
  publicUrl: string;
  deploymentMode?: string;
  deploymentExposure?: string;
  anthropicApiKey?: string;
  databaseUrl?: string;
}

/**
 * Environment passed to the Paperclip boot process. Secrets are only
 * forwarded when actually configured so the container env stays minimal.
 */
export function buildPaperclipEnv(options: PaperclipEnvOptions): Record<string, string> {
  const env: Record<string, string> = {
    HOST: "0.0.0.0",
    PORT: String(PAPERCLIP_PORT),
    PAPERCLIP_HOME: "/paperclip",
    PAPERCLIP_DEPLOYMENT_MODE: options.deploymentMode ?? "authenticated",
    PAPERCLIP_DEPLOYMENT_EXPOSURE: options.deploymentExposure ?? "private",
    PAPERCLIP_PUBLIC_URL: options.publicUrl,
  };
  if (options.anthropicApiKey) env.ANTHROPIC_API_KEY = options.anthropicApiKey;
  if (options.databaseUrl) env.DATABASE_URL = options.databaseUrl;
  return env;
}

/**
 * Matches the Sandbox SDK's own transient startup errors: the container VM is
 * still provisioning, or the port is not accepting connections yet (Paperclip
 * onboards its database on first boot, which takes a minute or two).
 * Deliberately specific to SDK wording so genuine Paperclip 5xx responses are
 * never mistaken for boot noise.
 */
const TRANSIENT_BOOT_PATTERNS = [
  /currently provisioning/i,
  /no container instance/i,
  /container.*(?:not running|starting|is starting)/i,
  /connection refused/i,
  /port.*not (?:ready|mapped|found)/i,
  /network connection lost/i,
  /timed out.*(?:port|start|container)/i,
];

export function isTransientBootMessage(message: string): boolean {
  return TRANSIENT_BOOT_PATTERNS.some((pattern) => pattern.test(message));
}

export function isTransientBootError(error: unknown): boolean {
  return error instanceof Error && isTransientBootMessage(error.message);
}

/**
 * Self-refreshing status page served while the container provisions and
 * Paperclip onboards. Inline styles only — nothing else is reachable yet.
 */
export function bootingPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="refresh" content="10"/>
<title>Paperclip is starting…</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       font-family:ui-sans-serif,system-ui,sans-serif;background:#0d1017;color:#e6e6e6}
  main{text-align:center;padding:2rem}
  .spinner{width:28px;height:28px;margin:0 auto 1.25rem;border-radius:50%;
           border:3px solid #232838;border-top-color:#7dd3fc;animation:spin 1s linear infinite}
  h1{font-size:1.1rem;font-weight:600;margin:0 0 .5rem}
  p{margin:.25rem 0;color:#9aa4bf;font-size:.9rem}
  @keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<main>
  <div class="spinner" role="status" aria-label="loading"></div>
  <h1>Paperclip is starting</h1>
  <p>The sandbox container is provisioning and Paperclip is onboarding its database.</p>
  <p>First boot takes a minute or two. This page refreshes automatically.</p>
</main>
</body>
</html>`;
}

/** 503 + Retry-After so health checkers and browsers both behave. */
export function bootingResponse(): Response {
  return new Response(bootingPage(), {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "retry-after": "15",
      "cache-control": "no-store",
    },
  });
}
