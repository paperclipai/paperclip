import type { Db, chatEndpoints } from "@paperclipai/db";
import { chatEndpoints as endpoints } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import type { SealedConnectorEvents } from "./paperclip-cloud-connector.js";

type Event = SealedConnectorEvents["events"][number];
type Endpoint = typeof chatEndpoints.$inferSelect;
type Handler = (endpoint: Endpoint, request: Request) => Promise<void>;
const handlers = new WeakMap<Db, Handler>();
export function registerGitHubBotCloudIngress(db: Db, handler: Handler) {
  handlers.set(db, handler);
  return () => {
    if (handlers.get(db) === handler) handlers.delete(db);
  };
}
/** Cloud proves transport ownership only. The canonical stack ingress authenticates GitHub's original bytes. */
export async function dispatchGitHubBotCloudEvent(
  db: Db,
  event: Event,
): Promise<boolean> {
  const value = event.payload.githubApp;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const packet = value as Record<string, unknown>;
  if (
    typeof packet.registrationId !== "string" ||
    !event.bindingIds.includes(`github-app:${packet.registrationId}`) ||
    typeof packet.rawBody !== "string" ||
    packet.rawBody.length > 1_398_104 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      packet.rawBody,
    ) ||
    !packet.headers ||
    typeof packet.headers !== "object" ||
    Array.isArray(packet.headers)
  )
    return true;
  const headers = packet.headers as Record<string, unknown>;
  if (
    !["x-github-event", "x-github-delivery", "x-hub-signature-256"].every(
      (key) => typeof headers[key] === "string" && headers[key].length <= 200,
    )
  )
    return true;
  const [endpoint] = await db
    .select()
    .from(endpoints)
    .where(
      and(
        eq(endpoints.provider, "github"),
        sql`${endpoints.setup}->'github'->>'cloudRegistrationId' = ${packet.registrationId}`,
      ),
    )
    .limit(1);
  if (
    !endpoint ||
    ["archived", "paused"].includes(endpoint.status) ||
    (endpoint.status === "revoked" && headers["x-github-event"] !== "installation")
  )
    return true;
  const handler = handlers.get(db);
  if (!handler) throw new Error("GitHub bot Cloud ingress is not ready");
  await handler(
    endpoint,
    new Request("https://paperclip.invalid/github-cloud-ingress", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": headers["x-github-event"] as string,
        "x-github-delivery": headers["x-github-delivery"] as string,
        "x-hub-signature-256": headers["x-hub-signature-256"] as string,
      },
      body: new Uint8Array(Buffer.from(packet.rawBody, "base64")),
    }),
  );
  return true;
}
