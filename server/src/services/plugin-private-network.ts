import type { PluginPrivateNetworkHostDeclaration } from "@paperclipai/plugin-sdk";
import { badRequest } from "../errors.js";

export interface StoredPluginPrivateNetworkHostConfig {
  host: string;
  updatedAt?: string;
}

export interface PluginPrivateNetworkHostSettingsJson {
  privateNetworkHosts?: Record<string, StoredPluginPrivateNetworkHostConfig>;
  [key: string]: unknown;
}

const PRIVATE_NETWORK_HOST_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;

const DNS_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const IPV4_LITERAL_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function assertPluginPrivateNetworkHostKey(hostKey: string) {
  if (!PRIVATE_NETWORK_HOST_KEY_PATTERN.test(hostKey)) {
    throw badRequest("hostKey must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, colons, underscores, or hyphens");
  }
}

export function findPrivateNetworkHostDeclaration(
  declarations: PluginPrivateNetworkHostDeclaration[] | undefined,
  hostKey: string,
) {
  return declarations?.find((declaration) => declaration.hostKey === hostKey) ?? null;
}

export function requirePrivateNetworkHostDeclaration(
  declarations: PluginPrivateNetworkHostDeclaration[] | undefined,
  hostKey: string,
) {
  assertPluginPrivateNetworkHostKey(hostKey);
  const declaration = findPrivateNetworkHostDeclaration(declarations, hostKey);
  if (!declaration) {
    throw badRequest("Private network host key is not declared by this plugin manifest");
  }
  return declaration;
}

export function normalizePrivateNetworkHostValue(hostValue: string): string {
  const trimmed = hostValue.trim().toLowerCase();
  if (!trimmed) {
    throw badRequest("host must be a non-empty hostname or IPv4 address");
  }
  if (trimmed.includes("*")) {
    throw badRequest("host must not contain a wildcard — name the exact approved host");
  }
  if (/[\s/?#@]/.test(trimmed) || trimmed.includes("://")) {
    throw badRequest("host must be a bare hostname or IPv4 address, without a scheme, path, or credentials");
  }

  if (IPV4_LITERAL_PATTERN.test(trimmed)) {
    const parts = trimmed.split(".");
    if (parts.some((part) => part.length > 1 && part.startsWith("0"))) {
      throw badRequest("IPv4 octets must not have leading zeros — use the canonical decimal form (e.g. \"10.0.1.4\", not \"10.0.1.004\")");
    }
    const octets = parts.map((part) => Number(part));
    if (octets.every((octet) => octet >= 0 && octet <= 255)) {
      return trimmed;
    }
    throw badRequest("host is not a valid IPv4 address");
  }

  if (trimmed.includes(":")) {
    throw badRequest("host must not include a port — configure the port separately in the plugin's own target URL");
  }

  const labels = trimmed.split(".");
  if (trimmed.length > 253 || labels.some((label) => !DNS_LABEL_PATTERN.test(label))) {
    throw badRequest("host must be a valid DNS hostname or IPv4 address");
  }
  return trimmed;
}

export function getStoredPrivateNetworkHosts(settingsJson: Record<string, unknown> | null | undefined) {
  const hosts = (settingsJson as PluginPrivateNetworkHostSettingsJson | undefined)?.privateNetworkHosts;
  if (!hosts || typeof hosts !== "object") return {};
  return hosts;
}

export function buildApprovedPrivateNetworkHostSet(
  declarations: PluginPrivateNetworkHostDeclaration[] | undefined,
  storedHosts: Record<string, StoredPluginPrivateNetworkHostConfig>,
): Set<string> {
  const approved = new Set<string>();
  for (const declaration of declarations ?? []) {
    const stored = storedHosts[declaration.hostKey];
    if (stored?.host) {
      approved.add(stored.host.trim().toLowerCase());
    }
  }
  return approved;
}
