import { completedSlackFormSessionReceipt } from "./form-idle-history.js";
import { and, gt, inArray, sql } from "drizzle-orm";
import { chatActions, type Db } from "@paperclipai/db";
import { projectSlackFormRetainedOwner, type SlackFormRetainedRow } from "./form-session.js";

export type SlackFormConnectorIdentity = Readonly<{ instanceId: string; environment: "development" | "test" | "staging" | "production" }>;
export function slackFormConnectorIdentity(connector: unknown): SlackFormConnectorIdentity | null {
  if (!connector || typeof connector !== "object") return null;
  let value: unknown;
  try {
    const getter = Reflect.get(connector, "instanceIdentity");
    if (typeof getter !== "function") return null;
    value = Reflect.apply(getter, connector, []);
  } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join() !== "environment,instanceId") return null;
  const instanceId = Reflect.get(value, "instanceId"), environment = Reflect.get(value, "environment");
  if (typeof instanceId !== "string" || !instanceId.length || instanceId.length > 200
    || environment !== "development" && environment !== "test" && environment !== "staging" && environment !== "production") return null;
  return Object.freeze({ instanceId, environment });
}

export function selectSlackFormRetainedConsumer(rows: readonly SlackFormRetainedRow[], identity: SlackFormConnectorIdentity) {
  let owner: ReturnType<typeof projectSlackFormRetainedOwner> = null;
  const attention: { actionId: string; code: string }[] = [];
  for (const row of rows) {
    try {
      const value = projectSlackFormRetainedOwner(row, identity.instanceId, identity.environment);
      if (value && row.kind === "slack_form_session" && row.result?.formAck && typeof row.result.formAck === "object"
        && Reflect.get(row.result.formAck, "phase") === "transferred" && completedSlackFormSessionReceipt(row)) continue;
      if (value && !owner) owner = value;
    } catch {
      attention.push({ actionId: row.id, code: "form_retained_owner_invalid" });
    }
  }
  return { owner, attention };
}

export async function readSlackFormRetainedConsumer(db: Pick<Db, "select">, connector: unknown) {
  const identity = slackFormConnectorIdentity(connector);
  if (!identity) return { owner: null, attention: [] };
  let after: string | undefined;
  const attention: { actionId: string; code: string }[] = [];
  for (;;) {
    const rows = await db.select().from(chatActions).where(and(
      inArray(chatActions.kind, ["slack_form_session", "slack_form_owner", "slack_form_grant"]),
      sql`coalesce(${chatActions.payload}->'binding'->>'instanceId', ${chatActions.payload}->'enrollment'->>'instanceId') = ${identity.instanceId}`,
      after === undefined ? undefined : gt(chatActions.id, after)))
      .orderBy(chatActions.id).limit(32);
    const selected = selectSlackFormRetainedConsumer(rows, identity);
    attention.push(...selected.attention.slice(0, Math.max(0, 32 - attention.length)));
    if (selected.owner) return { owner: selected.owner, attention };
    if (rows.length < 32) return { owner: null, attention };
    const next = rows[rows.length - 1]?.id;
    if (!next || next === after) throw new Error("Slack retained consumer cursor did not advance");
    after = next;
  }
}
