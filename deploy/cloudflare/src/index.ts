/**
 * Cloudflare Worker that serves a full Paperclip instance from a Cloudflare
 * Sandbox container on the Worker's own origin (works on *.workers.dev — no
 * custom domain required).
 *
 * Request flow:
 *   1. Ensure the Paperclip boot process is running in the sandbox
 *      (idempotent; memoized per isolate, re-checked after any failure).
 *   2. WebSocket upgrades  -> sandbox.wsConnect(request, 3100)
 *      Everything else     -> sandbox.containerFetch(request, 3100)
 *   3. While the container provisions / Paperclip onboards, serve a
 *      self-refreshing 503 status page instead of a raw error.
 *
 * See docs/deploy/cloudflare.md for the operator guide.
 */
import { getSandbox, type Sandbox as SandboxType } from "@cloudflare/sandbox";
import {
  ARTIFACTS_BINDING,
  BOOTSTRAP_COOKIE,
  BOOTSTRAP_PARAM,
  PAPERCLIP_PORT,
  SANDBOX_ID,
  START_COMMAND,
  STORAGE_MOUNT_PATH,
  accessDeniedPage,
  bootingResponse,
  bootstrapGateMode,
  buildPaperclipEnv,
  getCookie,
  setupRequiredPage,
  isMountAlreadyInUse,
  isPaperclipRunning,
  isTransientBootError,
  isTransientBootMessage,
  isWebSocketUpgrade,
  storageMountOptions,
} from "./lib";

// Required by the Sandbox SDK: the Durable Object class backing the container,
// and the ContainerProxy entrypoint used for credential-less R2 bucket mounts
// (harmless when no bucket is configured).
export { ContainerProxy, Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<SandboxType>;
  /**
   * Optional R2 bucket for durable attachment storage — uncomment the
   * r2_buckets block in wrangler.jsonc to enable.
   */
  ARTIFACTS?: R2Bucket;
  /** Optional override; defaults to the request origin (e.g. *.workers.dev). */
  PAPERCLIP_PUBLIC_URL?: string;
  PAPERCLIP_DEPLOYMENT_MODE?: string;
  PAPERCLIP_DEPLOYMENT_EXPOSURE?: string;
  /** Secrets (wrangler secret put …); forwarded to the container when set. */
  ANTHROPIC_API_KEY?: string;
  DATABASE_URL?: string;
  /**
   * Required before the deployment serves anything (fail-closed): every
   * request must present this token (?bootstrap_token=…, which sets a
   * cookie) — protects the unclaimed operator invite between first boot and
   * the operator's first login.
   */
  BOOTSTRAP_TOKEN?: string;
  /**
   * Set to "true" (wrangler.jsonc vars) after the operator account is
   * claimed to open the login page to your team; Paperclip's own auth
   * protects everything from then on.
   */
  DISABLE_BOOTSTRAP_GATE?: string;
}

/**
 * Per-isolate memo so steady-state requests skip the listProcesses round
 * trip. Reset whenever proxying fails, which also heals container restarts
 * (the boot process does not survive a sandbox sleep/wake cycle).
 */
let paperclipEnsured = false;

/**
 * Shared in-flight boot so concurrent cold-start requests in one isolate
 * issue a single ensure pass instead of racing startProcess. Cross-isolate
 * duplicates are additionally serialized by the flock in
 * container/start-paperclip.sh — duplicates exit immediately.
 */
let ensureInFlight: Promise<void> | null = null;

/** Constant-time comparison via digest so token checks don't leak timing. */
async function tokensMatch(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

/**
 * Bootstrap gate, fail-closed: with no token configured the deployment
 * serves only the setup page; with a token, only requests presenting it
 * (query param once, cookie afterwards) reach Paperclip. Returns null when
 * the request may proceed, otherwise the response to serve.
 */
async function enforceBootstrapGate(request: Request, env: Env, url: URL): Promise<Response | null> {
  const mode = bootstrapGateMode({
    token: env.BOOTSTRAP_TOKEN,
    disableGate: env.DISABLE_BOOTSTRAP_GATE,
  });
  if (mode === "open") return null;
  if (mode === "setup") {
    return new Response(setupRequiredPage(), {
      status: 403,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  // mode === "token": BOOTSTRAP_TOKEN is guaranteed non-empty here.
  const presented = url.searchParams.get(BOOTSTRAP_PARAM);
  if (presented !== null && (await tokensMatch(presented, env.BOOTSTRAP_TOKEN!))) {
    // Strip the token from the URL and persist access in a cookie.
    url.searchParams.delete(BOOTSTRAP_PARAM);
    return new Response(null, {
      status: 302,
      headers: {
        location: url.toString(),
        "set-cookie":
          `${BOOTSTRAP_COOKIE}=${encodeURIComponent(env.BOOTSTRAP_TOKEN!)}; ` +
          "HttpOnly; Secure; SameSite=Lax; Path=/",
      },
    });
  }

  const cookie = getCookie(request.headers.get("Cookie"), BOOTSTRAP_COOKIE);
  if (cookie !== undefined && (await tokensMatch(decodeURIComponent(cookie), env.BOOTSTRAP_TOKEN!))) {
    return null;
  }

  return new Response(accessDeniedPage(), {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

async function ensurePaperclip(sandbox: SandboxType, env: Env, requestUrl: URL): Promise<void> {
  const processes = await sandbox.listProcesses();
  if (isPaperclipRunning(processes)) return;

  // Mount durable attachment storage before Paperclip boots so the very
  // first upload already lands in R2. Credential-less: the SDK routes s3fs
  // traffic through the Worker's R2 binding (requires the ContainerProxy
  // export above).
  if (env[ARTIFACTS_BINDING]) {
    try {
      await sandbox.mountBucket(ARTIFACTS_BINDING, STORAGE_MOUNT_PATH, storageMountOptions());
    } catch (error) {
      if (!isMountAlreadyInUse(error)) throw error;
    }
  }

  await sandbox.startProcess(START_COMMAND, {
    env: buildPaperclipEnv({
      // origin (not a hardcoded https:// prefix) so wrangler dev's http://
      // origin round-trips correctly and auth cookies behave locally.
      publicUrl: env.PAPERCLIP_PUBLIC_URL || requestUrl.origin,
      deploymentMode: env.PAPERCLIP_DEPLOYMENT_MODE,
      deploymentExposure: env.PAPERCLIP_DEPLOYMENT_EXPOSURE,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      databaseUrl: env.DATABASE_URL,
    }),
  });
}

/**
 * Distinguish the Sandbox SDK's "still starting" 5xx responses from genuine
 * Paperclip errors so operators see the status page, not a JSON stack trace.
 */
async function isProvisioningResponse(response: Response): Promise<boolean> {
  if (response.status < 500) return false;
  if (!response.headers.get("content-type")?.includes("json")) return false;
  const text = await response.clone().text().catch(() => "");
  return isTransientBootMessage(text);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const sandbox = getSandbox(env.Sandbox, SANDBOX_ID);
    const url = new URL(request.url);

    const denied = await enforceBootstrapGate(request, env, url);
    if (denied) return denied;

    try {
      if (!paperclipEnsured) {
        ensureInFlight ??= ensurePaperclip(sandbox, env, url).finally(() => {
          ensureInFlight = null;
        });
        await ensureInFlight;
        paperclipEnsured = true;
      }

      if (isWebSocketUpgrade(request.headers)) {
        return await sandbox.wsConnect(request, PAPERCLIP_PORT);
      }

      const response = await sandbox.containerFetch(request, PAPERCLIP_PORT);
      if (await isProvisioningResponse(response)) {
        paperclipEnsured = false;
        return bootingResponse();
      }
      return response;
    } catch (error) {
      paperclipEnsured = false;
      if (isTransientBootError(error)) {
        return isWebSocketUpgrade(request.headers)
          ? new Response("Paperclip is starting; retry shortly", { status: 503 })
          : bootingResponse();
      }
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
