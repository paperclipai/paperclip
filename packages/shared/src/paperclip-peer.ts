import { defaultConnectionAgentInstructions, type ConnectionAgentInstructions, type ConnectionInstructionTemplate } from "./connection-instructions.js";

/**
 * Another Paperclip instance connected through "Connect your own MCP server".
 *
 * Every Paperclip serves its assistant connection at the same path. Recognizing
 * that address lets setup name the connection after the instance it reaches and
 * tell agents those tools act somewhere else. Agents already have their own
 * Paperclip tools, so without this the two sets look alike: same names, same
 * product in every description.
 *
 * Everything here is derived from the address the person typed. Nothing the
 * remote server returns is used, so a remote instance cannot choose the name or
 * the instructions agents read.
 */
export const PAPERCLIP_PEER_MCP_PATH = "/mcp/paperclip";

export interface PaperclipPeer {
  /** `https://acme.paperclip.app` */
  origin: string;
  /** `acme.paperclip.app`, with a port when one is present. */
  host: string;
  /** Short distinctive part of the host: `acme`, `staging`, `localhost-3101`. */
  label: string;
  /** Default connection name. The label comes first so it reads distinctively. */
  name: string;
  /** Tool-name prefix agents see. Derived from the address, so renaming never changes it. */
  toolNamespace: string;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const GENERIC_HOST_LABELS = new Set(["www", "paperclip"]);

function isIpAddress(hostname: string) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[");
}

function hostLabel(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(hostname) || isIpAddress(hostname) || !hostname.includes(".")) {
    const base = hostname.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "paperclip";
    return url.port ? `${base}-${url.port}` : base;
  }
  const parts = hostname.split(".");
  // Drop the registrable domain (approximated as the last two labels) and
  // generic labels, so `acme.paperclip.app` becomes `acme` and
  // `paperclip.staging.paperclip.app` becomes `staging`.
  const subdomain = (parts.length >= 3 ? parts.slice(0, -2) : parts.slice(0, -1))
    .filter((part) => !GENERIC_HOST_LABELS.has(part));
  const chosen = subdomain.length > 0 ? subdomain : parts.slice(0, -1);
  const label = chosen.join("-").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return label.slice(0, 40) || "paperclip";
}

/** The other Paperclip this MCP address points at, or null for any other server. */
export function paperclipPeerFromMcpUrl(value: string | null | undefined): PaperclipPeer | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.pathname.replace(/\/+$/, "") !== PAPERCLIP_PEER_MCP_PATH) return null;
  const label = hostLabel(url);
  return {
    origin: url.origin,
    host: url.host,
    label,
    name: label === "paperclip" ? `Paperclip ${url.host}` : `${label} Paperclip`,
    toolNamespace: label === "paperclip" ? "paperclip" : `${label}-paperclip`,
  };
}

function loopbackEquivalent(url: URL) {
  const hostname = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return LOOPBACK_HOSTNAMES.has(hostname) ? `${url.protocol}//loopback:${port}` : `${url.protocol}//${url.host.toLowerCase()}`;
}

/** True when the peer is this same instance, under any of its own origins. */
export function isSamePaperclipInstance(peer: PaperclipPeer, ownOrigins: Array<string | null | undefined>): boolean {
  const target = loopbackEquivalent(new URL(peer.origin));
  return ownOrigins.some((origin) => {
    if (!origin) return false;
    try {
      return loopbackEquivalent(new URL(origin)) === target;
    } catch {
      return false;
    }
  });
}

export const PAPERCLIP_PEER_INSTRUCTIONS_TEMPLATE_ID = "paperclip.peer";

/** Default guidance for a peer connection; the connection screen edits and resets against it. */
export function paperclipPeerInstructionTemplate(peer: PaperclipPeer): ConnectionInstructionTemplate {
  return {
    id: PAPERCLIP_PEER_INSTRUCTIONS_TEMPLATE_ID,
    version: 1,
    text: [
      `These tools act on a different Paperclip instance at ${peer.origin}, not the Paperclip you work in.`,
      "For your own tasks, comments and documents, keep using your own Paperclip tools.",
      `Use these tools only when your task asks you to send, read or update work on ${peer.host}.`,
      `Whatever you send there is visible to that instance's organization, so include only what the task asks you to share.`,
      `Task IDs and links from ${peer.host} do not exist in your own Paperclip: quote the full ${peer.origin} links these tools return.`,
    ].join(" "),
  };
}

/** Standing guidance attached to a new peer connection. People can edit or turn it off. */
export function paperclipPeerAgentInstructions(peer: PaperclipPeer): ConnectionAgentInstructions {
  return defaultConnectionAgentInstructions(paperclipPeerInstructionTemplate(peer))!;
}
