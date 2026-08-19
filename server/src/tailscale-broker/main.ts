/**
 * Entrypoint for the Tailscale HTTPS broker host service.
 *
 * Runs as a dedicated, Tailscale-operator-capable account (NOT the Paperclip
 * app/agent account). Wires the real Tailscale CLI, /proc listener inspector,
 * on-disk registry, and JSONL audit sink, then serves the Unix socket.
 *
 * Configuration (environment):
 *   PAPERCLIP_TS_BROKER_SOCKET   socket path (default /run/paperclip-tailscale-broker/broker.sock)
 *   PAPERCLIP_TS_BROKER_REGISTRY registry path (default /var/lib/paperclip-tailscale-broker/registry.json)
 *   PAPERCLIP_TS_BROKER_TAILSCALE absolute tailscale binary (default /usr/bin/tailscale)
 *   PAPERCLIP_TS_BROKER_ALLOWED_UIDS  comma-separated allowed caller uids (required)
 *   PAPERCLIP_TS_BROKER_ALLOWED_GIDS  comma-separated allowed caller gids (optional)
 *   PAPERCLIP_TS_BROKER_RUNTIME_UID   uid that must own exposed loopback listeners (optional)
 *   PAPERCLIP_TS_BROKER_PORT_MIN / _MAX   dedicated exposure port range
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createJsonlAuditSink } from "./audit.js";
import { Broker, type BrokerConfig } from "./broker.js";
import { createTailscaleCli } from "./cli.js";
import { createProcListenerInspector } from "./listener-ownership.js";
import { DEFAULT_PORT_POLICY } from "./policy.js";
import { loadRegistry, persistRegistry, type RegistryFile } from "./registry.js";
import { createNativePeerCredentialReader, startBrokerServer } from "./server.js";

function parseUidList(value: string | undefined, field: string): number[] {
  const list = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid ${field}: ${s}`);
      return n;
    });
  return list;
}

export function main(env: NodeJS.ProcessEnv = process.env): void {
  const socketPath = env.PAPERCLIP_TS_BROKER_SOCKET ?? "/run/paperclip-tailscale-broker/broker.sock";
  const registryPath = env.PAPERCLIP_TS_BROKER_REGISTRY ?? "/var/lib/paperclip-tailscale-broker/registry.json";
  const auditPath = env.PAPERCLIP_TS_BROKER_AUDIT ?? "/var/log/paperclip-tailscale-broker/audit.jsonl";
  const binaryPath = env.PAPERCLIP_TS_BROKER_TAILSCALE ?? "/usr/bin/tailscale";

  const allowedUids = parseUidList(env.PAPERCLIP_TS_BROKER_ALLOWED_UIDS, "allowed uids");
  if (allowedUids.length === 0) throw new Error("PAPERCLIP_TS_BROKER_ALLOWED_UIDS is required");
  const allowedGids = parseUidList(env.PAPERCLIP_TS_BROKER_ALLOWED_GIDS, "allowed gids");
  const runtimeUidRaw = env.PAPERCLIP_TS_BROKER_RUNTIME_UID;
  const expectedRuntimeUid = runtimeUidRaw ? Number(runtimeUidRaw) : null;

  const portPolicy = {
    minPort: env.PAPERCLIP_TS_BROKER_PORT_MIN ? Number(env.PAPERCLIP_TS_BROKER_PORT_MIN) : DEFAULT_PORT_POLICY.minPort,
    maxPort: env.PAPERCLIP_TS_BROKER_PORT_MAX ? Number(env.PAPERCLIP_TS_BROKER_PORT_MAX) : DEFAULT_PORT_POLICY.maxPort,
  };

  mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o750 });
  const audit = createJsonlAuditSink((line) => appendFileSync(auditPath, `${line}\n`, { mode: 0o640 }));

  const config: BrokerConfig = { portPolicy, allowedUids, allowedGids, expectedRuntimeUid };
  const broker = new Broker(config, {
    cli: createTailscaleCli({ binaryPath }),
    inspector: createProcListenerInspector(),
    audit,
    loadRegistry: (): RegistryFile => loadRegistry(registryPath),
    saveRegistry: (file) => persistRegistry(registryPath, file),
    now: () => Date.now(),
    correlationId: () => randomUUID(),
  });

  const server = startBrokerServer({
    socketPath,
    broker,
    peerReader: createNativePeerCredentialReader(),
    onFatal: () => process.exit(1),
  });

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.once("listening", () => {
    // eslint-disable-next-line no-console
    console.error(`paperclip-tailscale-broker listening on ${socketPath}`);
  });
}

// Only auto-start when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
