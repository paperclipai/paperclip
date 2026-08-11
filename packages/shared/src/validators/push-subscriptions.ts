import { z } from "zod";

function isPrivateOrReservedIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
}

function isPrivateOrReservedIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "::" || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe8")
    || normalized.startsWith("fe9")
    || normalized.startsWith("fea")
    || normalized.startsWith("feb")
    || (/^::ffff:(\d+\.\d+\.\d+\.\d+)$/.test(normalized)
      && isPrivateOrReservedIpv4(normalized.slice("::ffff:".length)));
}

function isSafePushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (url.protocol !== "https:" || !hostname) return false;
    if (
      hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname.endsWith(".local")
      || hostname.endsWith(".internal")
      || !hostname.includes(".")
    ) return false;
    return !isPrivateOrReservedIpv4(hostname) && !isPrivateOrReservedIpv6(hostname);
  } catch {
    return false;
  }
}

const pushEndpointSchema = z.string().url().refine(isSafePushEndpoint, {
  message: "Push endpoint must use a public HTTPS host",
});

export const subscribePushSubscriptionSchema = z.object({
  endpoint: pushEndpointSchema,
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

export type SubscribePushSubscription = z.infer<typeof subscribePushSubscriptionSchema>;

export const unsubscribePushSubscriptionSchema = z.object({
  endpoint: pushEndpointSchema,
});

export type UnsubscribePushSubscription = z.infer<typeof unsubscribePushSubscriptionSchema>;
