/**
 * Environment-driven configuration for the broker host service. All values are
 * validated; unsafe or missing required values make the broker refuse to start
 * (fail closed).
 */
import { parseProtectedPorts } from "./port-policy.js";
import { registryPathUnsafeReason } from "./registry.js";

export interface BrokerHostConfig {
  socketPath: string;
  registryPath: string;
  auditPath: string;
  tailscaleBinPath: string;
  nodeIdentity: string;
  serviceUid: number;
  serviceGid: number;
  runtimeUid: number;
  /**
   * Operator-declared ports the broker must never mutate, parsed from
   * `BROKER_PROTECTED_PORTS` (PAP-17285). Empty when unset.
   */
  protectedPorts: number[];
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value.trim().length === 0) {
    throw new Error(`missing required env: ${key}`);
  }
  return value;
}

function requireUid(env: NodeJS.ProcessEnv, key: string): number {
  const raw = requireEnv(env, key);
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${key} must be a non-negative integer`);
  return Number(raw);
}

export function loadHostConfig(env: NodeJS.ProcessEnv): BrokerHostConfig {
  const config: BrokerHostConfig = {
    socketPath: env.BROKER_SOCKET_PATH ?? "/run/paperclip-tailscale-broker/broker.sock",
    registryPath: env.BROKER_REGISTRY_PATH ?? "/var/lib/paperclip-tailscale-broker/registry.json",
    auditPath: env.BROKER_AUDIT_PATH ?? "/var/log/paperclip-tailscale-broker/audit.log",
    tailscaleBinPath: env.BROKER_TAILSCALE_BIN ?? "/usr/bin/tailscale",
    nodeIdentity: requireEnv(env, "BROKER_NODE_IDENTITY"),
    serviceUid: requireUid(env, "BROKER_SERVICE_UID"),
    serviceGid: requireUid(env, "BROKER_SERVICE_GID"),
    runtimeUid: requireUid(env, "BROKER_RUNTIME_UID"),
    // Throws on a malformed list so the broker refuses to start rather than
    // starting up silently protecting nothing (PAP-17285).
    protectedPorts: parseProtectedPorts(env.BROKER_PROTECTED_PORTS),
  };
  if (!config.tailscaleBinPath.startsWith("/")) {
    throw new Error("BROKER_TAILSCALE_BIN must be an absolute path");
  }
  const unsafe = registryPathUnsafeReason(config.registryPath);
  if (unsafe) {
    throw new Error(`refusing to start: ${unsafe} (${config.registryPath})`);
  }
  return config;
}
