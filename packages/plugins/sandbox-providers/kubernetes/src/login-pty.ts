import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import type { PluginLoginPtyOpenParams, PluginLoginPtyInputParams, PluginLoginPtyStopParams, PluginLoginPtyCloseParams } from "@paperclipai/plugin-sdk/protocol";

export interface LoginLeaseScope {
  companyId: string;
  environmentId: string;
  leaseId?: string;
  namespace: string;
  /**
   * Best-effort pod name captured at lease-remember time. NOT used by
   * `connectKubernetesLoginPty` to skip pod-readiness resolution — see
   * login-pty-exec.ts, which always re-resolves/waits for the pod
   * regardless of this field (a cached name here is not a guarantee the
   * pod is actually Ready; using it as a shortcut caused a real bug fixed
   * in this same change). Kept for diagnostics/future callers only.
   */
  podName: string | null;
  /** Attested lease expiry (ISO 8601); the sandbox pod stops at this instant. */
  expiresAt?: string | null;
  config: { inCluster?: boolean; kubeconfig?: string };
}
export interface LoginPtyConnection { write(data: string): void; close(): void }
export type LoginPtyConnector = (scope: LoginLeaseScope, command: string[], io: {
  tty: true;
  output(data: Buffer): void;
  exit(code: number | null): void;
}) => Promise<LoginPtyConnection>;
type Events = { output(route: string, session: string, data: string): void; exit(route: string, session: string, code: number | null): void };
type Entry = { route: string; id: string; lease: string; connection?: LoginPtyConnection; closed: boolean; exited: boolean; bytes: number; decoder: TextDecoder };
const HOME = /^\/tmp\/paperclip-adapter-login\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMANDS = {
  claude: "exec claude setup-token",
  codex: "exec env CODEX_HOME=HOME codex login --device-auth",
  grok: "exec env GROK_HOME=HOME grok login --device-auth",
} as const;
const MAX_CHUNK = 64 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024;
/** Global cap across all companies, to bound this worker's total exec fanout. */
const GLOBAL_MAX_SESSIONS = 16;
/**
 * Per-company cap. `routes`/`sessions` are shared module-level state across
 * every tenant handled by this plugin-worker singleton, so a single global
 * cap alone lets one company's login attempts starve every other company's
 * login attempts. Bound each company independently as well.
 */
const PER_COMPANY_MAX_SESSIONS = 4;

export function createLoginPtyManager(connect: LoginPtyConnector, events: Events) {
  const leases = new Map<string, LoginLeaseScope>();
  const routes = new Map<string, Entry>();
  const sessions = new Map<string, Entry>();
  function terminate(entry: Entry, signal = true) {
    if (entry.closed) return;
    entry.closed = true;
    sessions.delete(entry.id);
    routes.delete(entry.route);
    if (signal) {
      try { entry.connection?.write("\u0003"); } catch { /* already disconnected */ }
    }
    try { entry.connection?.close(); } catch { /* already disconnected */ }
  }
  function exit(entry: Entry, code: number | null) {
    if (entry.exited || entry.closed) return;
    entry.exited = true;
    events.exit(entry.route, entry.id, code);
  }
  return {
    remember(id: string, scope: LoginLeaseScope) {
      this.forget(id);
      leases.set(id, { ...scope, leaseId: id });
    },
    forget(id: string) {
      leases.delete(id);
      for (const entry of [...routes.values()]) if (entry.lease === id) {
        exit(entry, null);
        terminate(entry);
      }
    },
    async open(params: PluginLoginPtyOpenParams) {
      if (params.driverKey !== "kubernetes" || !HOME.test(params.sessionHome) || !Object.hasOwn(COMMANDS, params.loginCommandKey)) {
        throw new Error("LOGIN_PTY_DESCRIPTOR_REJECTED");
      }
      const scope = leases.get(params.providerLeaseId);
      if (!scope || scope.companyId !== params.companyId || scope.environmentId !== params.environmentId) {
        throw new Error("Kubernetes login PTY: lease ownership mismatch or unknown lease");
      }
      if (scope.expiresAt && !(Date.parse(scope.expiresAt) > Date.now())) {
        throw new Error("Kubernetes login PTY: lease has expired");
      }
      if (routes.has(params.hostRouteId)) throw new Error("Kubernetes login PTY: route already open");
      if (routes.size >= GLOBAL_MAX_SESSIONS) throw new Error("Kubernetes login PTY concurrent session limit reached");
      const perCompanyCount = [...routes.values()].filter(
        (r) => leases.get(r.lease)?.companyId === scope.companyId,
      ).length;
      if (perCompanyCount >= PER_COMPANY_MAX_SESSIONS) {
        throw new Error("Kubernetes login PTY concurrent session limit reached for this company");
      }
      const entry: Entry = { route: params.hostRouteId, id: `pty-${randomUUID()}`, lease: params.providerLeaseId, closed: false, exited: false, bytes: 0, decoder: new TextDecoder() };
      routes.set(entry.route, entry);
      const quotedHome = `'${params.sessionHome}'`;
      const line = COMMANDS[params.loginCommandKey as keyof typeof COMMANDS].replace("=HOME ", `=${quotedHome} `);
      try {
        const connection = await connect(scope, ["/bin/sh", "-c", `mkdir -p ${quotedHome} && ${line}`], {
          tty: true,
          output(data) {
            if (entry.closed || entry.exited) return;
            entry.bytes += data.byteLength;
            if (data.byteLength > MAX_CHUNK || entry.bytes > MAX_TOTAL) {
              exit(entry, null);
              terminate(entry);
              return;
            }
            const text = entry.decoder.decode(data, { stream: true });
            if (text) events.output(entry.route, entry.id, text);
          },
          exit(code) { exit(entry, code); terminate(entry, false); },
        });
        if (entry.closed || leases.get(entry.lease) !== scope) {
          connection.close();
          throw new Error("Kubernetes login PTY open cancelled");
        }
        entry.connection = connection;
        sessions.set(entry.id, entry);
        return { workerSessionId: entry.id };
      } catch (error) {
        terminate(entry);
        throw error;
      }
    },
    async input(params: PluginLoginPtyInputParams) {
      if (Buffer.byteLength(params.data, "utf8") > MAX_CHUNK) throw new Error("Kubernetes login PTY input exceeds limit");
      const entry = sessions.get(params.workerSessionId);
      if (entry && !entry.closed && !entry.exited) entry.connection?.write(params.data);
    },
    async stop(params: PluginLoginPtyStopParams) {
      const entry = sessions.get(params.workerSessionId);
      if (entry) { exit(entry, null); terminate(entry); }
    },
    async close(params: PluginLoginPtyCloseParams) {
      const entry = routes.get(params.hostRouteId);
      if (entry) terminate(entry);
      return { hostRouteId: params.hostRouteId };
    },
    shutdown() { for (const id of [...leases.keys()]) this.forget(id); },
  };
}
