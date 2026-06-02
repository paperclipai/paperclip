import { generateJson } from "./gemini.js";

/**
 * Reply intent tagger — ported from agnb lib/agnb/reply-tagger.ts.
 * Single-call Gemini classifier with structured output. Schema mirrors the
 * agnb.reply_log.reply_intent enum so results write straight back.
 */
export type ReplyIntent =
  | "interested"
  | "not_now"
  | "wrong_person"
  | "unsubscribe"
  | "spam"
  | "objection"
  | "churn_signal"
  | "other";

export interface TaggedReply {
  intent: ReplyIntent;
  confidence: number; // 0-1
  objection_cluster: string | null;
  next_action: string | null;
  summary: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["interested", "not_now", "wrong_person", "unsubscribe", "spam", "objection", "churn_signal", "other"],
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    objection_cluster: {
      type: "string",
      nullable: true,
      enum: ["price", "wrong_fit", "have_alt", "integration_gap", "trust", "timing", "other", null],
    },
    next_action: {
      type: "string",
      nullable: true,
      enum: ["book_demo", "send_pricing", "remove_from_list", "route_to_csm", "follow_up_later", "ignore", null],
    },
    summary: { type: "string", maxLength: 200 },
  },
  required: ["intent", "confidence", "summary"],
};

const SYSTEM = `You are an SDR reply-classifier for an AI voice agent platform (Finn).
Read the prospect's reply to a cold outbound email and classify the buyer signal.
Return a single JSON object matching the schema.

Definitions:
- interested: explicit signal to talk — "book a demo", "send a calendar link", "I'd like to learn more"
- not_now: politely deferring — "circle back Q3", "not now", "next quarter"
- wrong_person: bounce to a colleague — "I'm not the right contact", "forwarded to ..."
- unsubscribe: opt-out — "remove me", "stop emailing", "unsubscribe"
- spam: bounces, auto-replies, out-of-office, undeliverable, irrelevant noise
- objection: pushback that's NOT a soft no — "too expensive", "we already use X", "doesn't fit our stack"
- churn_signal: existing customer signaling pain — only if the email body suggests they're a customer
- other: anything else

Objection clusters: price | wrong_fit | have_alt | integration_gap | trust | timing | other
Next actions: book_demo | send_pricing | remove_from_list | route_to_csm | follow_up_later | ignore`;

export async function tagReply(input: {
  body: string;
  subject?: string;
  from_email?: string;
  from_name?: string;
  signal?: AbortSignal;
}): Promise<TaggedReply> {
  const prompt = [
    input.from_name || input.from_email
      ? `From: ${input.from_name ?? ""} <${input.from_email ?? ""}>`
      : "",
    input.subject ? `Subject: ${input.subject}` : "",
    "",
    "Body:",
    input.body,
  ]
    .filter(Boolean)
    .join("\n");

  const { data } = await generateJson<TaggedReply>(prompt, {
    model: "gemini-2.5-flash",
    temperature: 0.1,
    systemInstruction: SYSTEM,
    jsonSchema: SCHEMA,
    signal: input.signal,
  });
  return data;
}
