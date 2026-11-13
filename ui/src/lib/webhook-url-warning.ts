export type WebhookUrlWarningReason = "loopback" | "private" | "tailscale" | "https" | "invalid";

function ipv4Warning(parts: number[]): WebhookUrlWarningReason | null {
  const [a, b] = parts;
  if (a === 127 || a === 0) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return "private";
  return null;
}

/** URL hints only: DNS, firewall rules, and Tailscale Funnel cannot be inferred here. */
export function webhookUrlWarningReason(value: string): WebhookUrlWarningReason | null {
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { return "invalid"; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid";
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "::") return "loopback";
  if (host.includes(":")) {
    // URL normalizes IPv4-mapped IPv6 addresses to two hexadecimal words.
    const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(host);
    if (mapped) {
      const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
      const warning = ipv4Warning([high >> 8, high & 255, low >> 8, low & 255]);
      if (warning) return warning;
    }
    if (/^(f[cd][\da-f]{2}|fe[89ab][\da-f]|fec[\da-f]):/.test(host)) return "private";
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const warning = ipv4Warning(host.split(".").map(Number));
    if (warning) return warning;
  } else {
    if (host.endsWith(".ts.net")) return "tailscale";
    if (!host.includes(".") || /\.(local|internal|lan|home|corp|intranet|private|test)$/.test(host)
      || host.endsWith(".home.arpa")) return "private";
  }
  return url.protocol === "https:" ? null : "https";
}
