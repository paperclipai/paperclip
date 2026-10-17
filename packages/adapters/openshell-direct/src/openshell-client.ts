/**
 * OpenShell gRPC client -- calls the OpenShell gateway directly.
 *
 * Uses dynamic proto loading via @grpc/proto-loader to avoid
 * needing a proto compilation step.
 */
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { accessSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH_RELATIVE = resolve(__dirname, "../proto/openshell.proto");
const PROTO_PATH_ABSOLUTE = "/paperclip/adapters/openshell-direct/proto/openshell.proto";

function existsSync(p: string): boolean {
  try { accessSync(p); return true; } catch { return false; }
}

const PROTO_PATH = existsSync(PROTO_PATH_RELATIVE) ? PROTO_PATH_RELATIVE : PROTO_PATH_ABSOLUTE;

const _clients = new Map<string, any>();

function getClient(endpoint: string): any {
  const existing = _clients.get(endpoint);
  if (existing) return existing;

  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [resolve(__dirname, "../proto")],
  });

  const proto = grpc.loadPackageDefinition(packageDef) as any;
  const client = new proto.openshell.v1.OpenShell(
    endpoint,
    grpc.credentials.createInsecure()
  );

  _clients.set(endpoint, client);
  return client;
}

export interface SandboxInfo {
  name: string;
  phase: string;
  id?: string;
}

export async function healthCheck(endpoint: string): Promise<boolean> {
  const client = getClient(endpoint);
  return new Promise((resolve) => {
    client.Health({}, { deadline: Date.now() + 5000 }, (err: any) => {
      resolve(!err);
    });
  });
}

export async function getSandbox(endpoint: string, name: string): Promise<SandboxInfo> {
  const client = getClient(endpoint);
  return new Promise((resolve, reject) => {
    client.GetSandbox({ name }, { deadline: Date.now() + 10000 }, (err: any, res: any) => {
      if (err) return reject(new Error(`GetSandbox failed: ${err.message}`));
      const sb = res?.sandbox;
      resolve({
        name: sb?.metadata?.name || name,
        phase: sb?.status?.phase || "unknown",
        id: sb?.metadata?.id,
      });
    });
  });
}

export async function createSandbox(
  endpoint: string,
  opts: {
    name?: string;
    image?: string;
    cpu?: string;
    memory?: string;
    gpu?: boolean;
    environment?: Record<string, string>;
    labels?: Record<string, string>;
  }
): Promise<SandboxInfo> {
  const client = getClient(endpoint);

  const template: any = {};
  if (opts.image) template.image = opts.image;
  if (opts.environment) template.environment = opts.environment;
  if (opts.labels) template.labels = opts.labels;

  const spec: any = { template };

  if (opts.gpu) {
    spec.resourceRequirements = { gpu: { count: 1 } };
  }

  const request: any = { spec };
  if (opts.name) request.name = opts.name;
  if (opts.labels) request.labels = opts.labels;

  return new Promise((resolve, reject) => {
    client.CreateSandbox(request, { deadline: Date.now() + 120000 }, (err: any, response: any) => {
      if (err) return reject(new Error(`CreateSandbox failed: ${err.message}`));
      const sb = response?.sandbox;
      resolve({
        name: sb?.metadata?.name || opts.name || "unknown",
        phase: sb?.status?.phase || "unknown",
        id: sb?.metadata?.id,
      });
    });
  });
}

export async function waitForSandboxReady(
  endpoint: string,
  name: string,
  timeoutMs = 120000
): Promise<void> {
  const client = getClient(endpoint);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const phase = await new Promise<string>((resolve, reject) => {
      client.GetSandbox({ name }, { deadline: Date.now() + 10000 }, (err: any, res: any) => {
        if (err) return reject(err);
        resolve(res?.sandbox?.status?.phase || "unknown");
      });
    });

    if (phase === "SANDBOX_PHASE_READY") return;
    if (phase === "SANDBOX_PHASE_ERROR") {
      throw new Error(`Sandbox ${name} failed to start (phase: ${phase})`);
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error(`Sandbox ${name} did not become ready within ${timeoutMs}ms`);
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function execInSandbox(
  endpoint: string,
  sandboxId: string,
  command: string[],
  opts?: { timeoutSecs?: number; env?: Record<string, string> }
): Promise<ExecResult> {
  const client = getClient(endpoint);

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ((opts?.timeoutSecs || 600) + 30) * 1000;
    let stdout = "";
    let stderr = "";
    let exitCode = -1;

    const stream = client.ExecSandbox({
      sandboxId,
      command,
      environment: opts?.env || {},
      timeoutSeconds: opts?.timeoutSecs || 600,
    }, { deadline });

    stream.on("data", (event: any) => {
      if (event.stdout) stdout += Buffer.from(event.stdout.data).toString();
      if (event.stderr) stderr += Buffer.from(event.stderr.data).toString();
      if (event.exit) exitCode = event.exit.exitCode;
    });

    stream.on("end", () => {
      resolve({ stdout, stderr, exitCode });
    });

    stream.on("error", (err: any) => {
      if (stdout || stderr) {
        resolve({ stdout, stderr, exitCode });
      } else {
        reject(new Error(`ExecSandbox failed: ${err.message}`));
      }
    });
  });
}

export async function deleteSandbox(endpoint: string, name: string): Promise<void> {
  const client = getClient(endpoint);
  return new Promise((resolve, reject) => {
    client.DeleteSandbox({ name }, { deadline: Date.now() + 30000 }, (err: any) => {
      if (err && err.code !== 5 /* NOT_FOUND */) {
        return reject(new Error(`DeleteSandbox failed: ${err.message}`));
      }
      resolve();
    });
  });
}

export async function listSandboxes(endpoint: string): Promise<SandboxInfo[]> {
  const client = getClient(endpoint);
  return new Promise((resolve, reject) => {
    client.ListSandboxes({}, { deadline: Date.now() + 10000 }, (err: any, res: any) => {
      if (err) return reject(err);
      const items = (res?.sandboxes || []).map((sb: any) => ({
        name: sb?.metadata?.name || "unknown",
        phase: sb?.status?.phase || "unknown",
        id: sb?.metadata?.id,
      }));
      resolve(items);
    });
  });
}
