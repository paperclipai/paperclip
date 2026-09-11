import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { accessSync } from "node:fs";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_RELATIVE = resolve(__dirname, "../proto/openshell.proto");
const PROTO_DOCKER = "/paperclip/plugins/openshell/proto/openshell.proto";

function fileExists(p: string): boolean {
  try {
    accessSync(p);
    return true;
  } catch {
    return false;
  }
}

const PROTO_PATH = fileExists(PROTO_RELATIVE) ? PROTO_RELATIVE : PROTO_DOCKER;
const PROTO_INCLUDE_DIR = resolve(PROTO_PATH, "..");

const _clients = new Map<string, any>();

export interface ClientOptions {
  useTls?: boolean;
  caCert?: string;
}

export function getClient(endpoint: string, opts?: ClientOptions): any {
  const caHash = opts?.caCert
    ? createHash("sha256").update(opts.caCert).digest("hex").slice(0, 12)
    : "none";
  const cacheKey = `${endpoint}:${opts?.useTls ? "tls" : "plain"}:${caHash}`;
  const existing = _clients.get(cacheKey);
  if (existing) return existing;

  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_INCLUDE_DIR],
  });

  const proto = grpc.loadPackageDefinition(packageDef) as any;

  let credentials: grpc.ChannelCredentials;
  if (opts?.useTls) {
    const rootCerts = opts.caCert ? Buffer.from(opts.caCert) : null;
    credentials = grpc.credentials.createSsl(rootCerts);
  } else {
    credentials = grpc.credentials.createInsecure();
  }

  const client = new proto.openshell.v1.OpenShell(endpoint, credentials);
  _clients.set(cacheKey, client);
  return client;
}

export function clearClientCache(): void {
  for (const client of _clients.values()) {
    try {
      client.close();
    } catch {
      // best-effort
    }
  }
  _clients.clear();
}

export interface SandboxInfo {
  name: string;
  id: string;
  phase: string;
}

export async function healthCheck(
  client: any
): Promise<{ ok: boolean; version: string }> {
  return new Promise((resolve) => {
    client.Health({}, { deadline: Date.now() + 5_000 }, (err: any, res: any) => {
      if (err) {
        resolve({ ok: false, version: "" });
        return;
      }
      const status = res?.status || "SERVICE_STATUS_UNSPECIFIED";
      resolve({
        ok: status === "SERVICE_STATUS_HEALTHY",
        version: res?.version || "",
      });
    });
  });
}

export async function createSandbox(
  client: any,
  req: {
    name?: string;
    image?: string;
    environment?: Record<string, string>;
    labels?: Record<string, string>;
    policy?: Record<string, unknown>;
    gpu?: boolean;
    gpuCount?: number;
  }
): Promise<SandboxInfo> {
  const template: Record<string, unknown> = {};
  if (req.image) template.image = req.image;
  if (req.environment) template.environment = req.environment;
  if (req.labels) template.labels = req.labels;

  const spec: Record<string, unknown> = { template };

  if (req.policy) {
    spec.policy = req.policy;
  }

  if (req.gpu) {
    spec.resourceRequirements = {
      gpu: { count: req.gpuCount ?? 1 },
    };
  }

  const request: Record<string, unknown> = { spec };
  if (req.name) request.name = req.name;
  if (req.labels) request.labels = req.labels;

  return new Promise((resolve, reject) => {
    client.CreateSandbox(
      request,
      { deadline: Date.now() + 120_000 },
      (err: any, response: any) => {
        if (err)
          return reject(new Error(`CreateSandbox failed: ${err.message}`));
        const sb = response?.sandbox;
        resolve({
          name: sb?.metadata?.name || req.name || "unknown",
          id: sb?.metadata?.id || "",
          phase: sb?.status?.phase || "SANDBOX_PHASE_UNSPECIFIED",
        });
      }
    );
  });
}

export async function getSandbox(
  client: any,
  name: string
): Promise<SandboxInfo | null> {
  return new Promise((resolve, reject) => {
    client.GetSandbox(
      { name },
      { deadline: Date.now() + 10_000 },
      (err: any, res: any) => {
        if (err) {
          if (err.code === 5) return resolve(null);
          return reject(new Error(`GetSandbox failed: ${err.message}`));
        }
        const sb = res?.sandbox;
        resolve({
          name: sb?.metadata?.name || name,
          id: sb?.metadata?.id || "",
          phase: sb?.status?.phase || "SANDBOX_PHASE_UNSPECIFIED",
        });
      }
    );
  });
}

export async function waitForReady(
  client: any,
  name: string,
  timeoutMs: number
): Promise<SandboxInfo> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const info = await getSandbox(client, name);
    if (!info) throw new Error(`Sandbox ${name} disappeared during readiness wait`);

    if (info.phase === "SANDBOX_PHASE_READY") return info;
    if (info.phase === "SANDBOX_PHASE_ERROR") {
      throw new Error(`Sandbox ${name} entered error phase`);
    }

    await new Promise((r) => setTimeout(r, 2_000));
  }

  throw new Error(
    `Sandbox ${name} did not become ready within ${timeoutMs}ms`
  );
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function execSandbox(
  client: any,
  sandboxId: string,
  command: string[],
  opts?: {
    timeoutSeconds?: number;
    env?: Record<string, string>;
    cwd?: string;
    stdin?: string;
  }
): Promise<ExecResult> {
  const timeoutSecs = opts?.timeoutSeconds ?? 600;
  const deadline = Date.now() + (timeoutSecs + 30) * 1_000;

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let exitCode = -1;
    let timedOut = false;

    const request: Record<string, unknown> = {
      sandboxId,
      command,
      timeoutSeconds: timeoutSecs,
    };
    if (opts?.env) request.environment = opts.env;
    if (opts?.cwd) request.workdir = opts.cwd;
    if (opts?.stdin) request.stdin = Buffer.from(opts.stdin);

    const stream = client.ExecSandbox(request, { deadline });

    stream.on("data", (event: any) => {
      if (event.stdout?.data) {
        stdout += Buffer.from(event.stdout.data).toString();
      }
      if (event.stderr?.data) {
        stderr += Buffer.from(event.stderr.data).toString();
      }
      if (event.exit != null) {
        exitCode = event.exit.exitCode ?? -1;
      }
    });

    stream.on("end", () => {
      resolve({ exitCode, stdout, stderr, timedOut });
    });

    stream.on("error", (err: any) => {
      if (err.code === 4) {
        timedOut = true;
        resolve({ exitCode, stdout, stderr, timedOut: true });
        return;
      }
      if (stdout || stderr) {
        resolve({ exitCode, stdout, stderr, timedOut });
      } else {
        reject(new Error(`ExecSandbox failed: ${err.message}`));
      }
    });
  });
}

export async function deleteSandbox(
  client: any,
  name: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.DeleteSandbox(
      { name },
      { deadline: Date.now() + 30_000 },
      (err: any) => {
        if (err && err.code !== 5) {
          return reject(new Error(`DeleteSandbox failed: ${err.message}`));
        }
        resolve();
      }
    );
  });
}

export async function listSandboxes(
  client: any,
  labelSelector?: string
): Promise<SandboxInfo[]> {
  return new Promise((resolve, reject) => {
    const req: Record<string, unknown> = {};
    if (labelSelector) req.labelSelector = labelSelector;

    client.ListSandboxes(
      req,
      { deadline: Date.now() + 10_000 },
      (err: any, res: any) => {
        if (err) return reject(err);
        const items = (res?.sandboxes || []).map((sb: any) => ({
          name: sb?.metadata?.name || "unknown",
          id: sb?.metadata?.id || "",
          phase: sb?.status?.phase || "SANDBOX_PHASE_UNSPECIFIED",
        }));
        resolve(items);
      }
    );
  });
}
