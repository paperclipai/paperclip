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
  PAPERCLIP_PORT,
  SANDBOX_ID,
  START_COMMAND,
  STORAGE_MOUNT_PATH,
  bootingResponse,
  buildPaperclipEnv,
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
}

/**
 * Per-isolate memo so steady-state requests skip the listProcesses round
 * trip. Reset whenever proxying fails, which also heals container restarts
 * (the boot process does not survive a sandbox sleep/wake cycle).
 */
let paperclipEnsured = false;

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
      publicUrl: env.PAPERCLIP_PUBLIC_URL || `https://${requestUrl.host}`,
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

    try {
      if (!paperclipEnsured) {
        await ensurePaperclip(sandbox, env, url);
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
