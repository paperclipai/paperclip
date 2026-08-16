#!/usr/bin/env node
/**
 * Broker host entrypoint. Wires the tested BrokerCore to the live Tailscale
 * CLI, /proc listener-ownership check, file registry, file audit sink, and the
 * unix-socket transport. Runs as a dedicated, Tailscale-operator service
 * account — NOT as the Paperclip app/agent account.
 *
 * Usage:
 *   paperclip-tailscale-https-broker            # run the broker
 *   paperclip-tailscale-https-broker --doctor   # read-only preflight, no mutation
 */
import { FileAuditSink } from "./audit.js";
import { BrokerCore } from "./broker-core.js";
import { loadHostConfig } from "./config.js";
import { createPeerResolver } from "./peercred.js";
import { defaultIsAllowedPort } from "./port-policy.js";
import { createProcListenerVerifier } from "./proc-listener.js";
import { startSocketServer } from "./socket-server.js";
import { buildStatusArgv } from "./argv.js";
import { assertPrimaryIntact, parseServeStatus } from "./serve-config.js";
import { createTailscaleRunner, isSupportedTailscaleVersion } from "./tailscale-cli.js";

function runDoctor(): number {
  const config = loadHostConfig(process.env);
  const runner = createTailscaleRunner();
  const version = runner([config.tailscaleBinPath, "version"]);
  const versionOk = version.code === 0 && isSupportedTailscaleVersion(version.stdout);
  const status = runner(buildStatusArgv(config.tailscaleBinPath));
  let primaryOk = false;
  try {
    assertPrimaryIntact(parseServeStatus(JSON.parse(status.stdout)));
    primaryOk = true;
  } catch {
    primaryOk = false;
  }
  const checks = {
    tailscaleVersionSupported: versionOk,
    serveStatusReadable: status.code === 0,
    primaryRouteIntact: primaryOk,
    registryPathSafe: true, // loadHostConfig already threw otherwise
    nodeIdentity: config.nodeIdentity,
  };
  process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  return versionOk && status.code === 0 && primaryOk ? 0 : 1;
}

function main(): void {
  if (process.argv.includes("--doctor")) {
    process.exit(runDoctor());
  }

  const config = loadHostConfig(process.env);
  const core = new BrokerCore({
    tailscaleBinPath: config.tailscaleBinPath,
    registryPath: config.registryPath,
    auditSink: new FileAuditSink(config.auditPath, true),
    peerPolicy: {
      allowedUids: new Set([config.serviceUid]),
      allowedGids: new Set([config.serviceGid]),
    },
    nodeIdentity: config.nodeIdentity,
    isAllowedPort: defaultIsAllowedPort,
    deps: {
      runTailscale: createTailscaleRunner(),
      verifyListenerOwnership: createProcListenerVerifier(config.runtimeUid),
      nowIso: () => new Date().toISOString(),
    },
  });

  const server = startSocketServer({
    socketPath: config.socketPath,
    core,
    resolvePeer: createPeerResolver({
      serviceUid: config.serviceUid,
      serviceGid: config.serviceGid,
      trustSocketPermissions: config.trustSocketPermissions,
    }),
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stderr.write(`[broker] listening on ${config.socketPath}\n`);
}

main();
