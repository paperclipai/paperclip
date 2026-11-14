import { and, eq, inArray, ne, or, sql, type SQLWrapper } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { slackNativeProgressPolicy } from "./chat-channels/slack/native-progress.js";

export type NativeProgressBase = { createdAt: Date; state: string; redactedError: string | null };
export type NativeProgressHistory = { createdAt: Date; publishedAt: Date | null; state: string };
export type NativeProgressPolicy = {
  latestPublicNote?: (db: Pick<Db, "select">, scope: { companyId: string; runId: string }, signal?: AbortSignal) => Promise<{ seq: number; text: string } | null>;
  acceptsBase: (base: NativeProgressBase, hasPublicNote: boolean) => boolean;
  nextDelivery: (input: { base: NativeProgressBase; previous: NativeProgressHistory[]; eventCreatedAt: Date; now: number }) => { ready: boolean; dueAt?: number };
};

const defaultPolicy: NativeProgressPolicy = {
  acceptsBase: base => ["pending", "retry", "streaming", "published"].includes(base.state),
  nextDelivery: ({ base, previous, eventCreatedAt }) => ({
    ready: eventCreatedAt.getTime() - Math.max(base.createdAt.getTime(), ...previous.map(row => row.createdAt.getTime())) >= 20_000,
  }),
};

export function nativeChatProgressPolicy(provider: string): NativeProgressPolicy {
  return provider === "slack" ? slackNativeProgressPolicy : defaultPolicy;
}

export function nativeProgressBaseEligible(provider: SQLWrapper, base: { state: SQLWrapper; redactedError: SQLWrapper }) {
  return or(inArray(base.state, ["pending", "retry", "streaming", "published"]),
    and(eq(provider, "slack"), slackNativeProgressPolicy.additionalBaseEligibility(base)));
}

export function nativeProgressEventEligible(provider: SQLWrapper, eventCreatedAt: SQLWrapper, baseCreatedAt: SQLWrapper) {
  return or(eq(provider, "slack"), and(ne(provider, "slack"), sql`${eventCreatedAt} >= ${baseCreatedAt} + interval '20 seconds'`));
}
