import { z } from "zod";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import {
  companySecrets,
  providerBillingSnapshots,
  type Db,
} from "@paperclipai/db";
import {
  centsToUnits,
  usdToUnits,
  unitsToCents,
  importProviderCostsSchema,
  type ImportProviderCosts,
} from "@paperclipai/shared";
import { secretService } from "./secrets.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { createFinanceEventInTransaction } from "./finance.js";
import { forbidden, unprocessable } from "../errors.js";

const pageSchema = z.object({
  data: z
    .array(
      z.object({
        start_time: z.number().int().optional(),
        end_time: z.number().int().optional(),
        starting_at: z.iso.datetime({ offset: true }).optional(),
        ending_at: z.iso.datetime({ offset: true }).optional(),
        results: z
          .array(
            z.object({
              project_id: z.string().nullable().optional(),
              workspace_id: z.string().nullable().optional(),
              amount: z.union([
                z.string(),
                z.object({ value: z.number().finite(), currency: z.string() }),
              ]),
              currency: z.string().optional(),
            }),
          )
          .max(5000),
      }),
    )
    .max(31),
  has_more: z.boolean(),
  next_page: z.string().max(4000).nullable().optional(),
});
export interface DailyProviderCost {
  day: string;
  scopeId: string;
  amountCents: string;
}

async function boundedJson(response: Response) {
  if (!response.ok || !response.body)
    throw unprocessable(
      "Provider billing is unavailable. Check the admin credential and selected account.",
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 2_000_000)
        throw unprocessable(
          "Provider billing response is too large; use a shorter period.",
        );
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Complete every page before writing. Group only by project/workspace so a
 * provider's line-item changes cannot manufacture duplicate charges. */
export async function fetchProviderDailyCosts(
  input: ImportProviderCosts,
  credential: string,
  fetcher = fetch,
): Promise<DailyProviderCost[]> {
  const parsed = importProviderCostsSchema.parse(input);
  const from = Date.parse(parsed.from),
    to = Date.parse(parsed.to);
  const base = new URL(
    parsed.provider === "openai"
      ? "https://api.openai.com/v1/organization/costs"
      : "https://api.anthropic.com/v1/organizations/cost_report",
  );
  base.searchParams.set(
    parsed.provider === "openai" ? "start_time" : "starting_at",
    parsed.provider === "openai"
      ? String(from / 1000)
      : new Date(from).toISOString(),
  );
  base.searchParams.set(
    parsed.provider === "openai" ? "end_time" : "ending_at",
    parsed.provider === "openai"
      ? String(to / 1000)
      : new Date(to).toISOString(),
  );
  base.searchParams.set("bucket_width", "1d");
  base.searchParams.set("limit", "31");
  base.searchParams.append(
    "group_by[]",
    parsed.provider === "openai" ? "project_id" : "workspace_id",
  );
  const headers: Record<string, string> =
    parsed.provider === "openai"
      ? {
          Authorization: `Bearer ${credential}`,
          "OpenAI-Organization": parsed.accountId,
        }
      : { "x-api-key": credential, "anthropic-version": "2023-06-01" };
  headers["User-Agent"] = "Paperclip/1.0 (https://paperclip.ing)";
  const totals = new Map<string, bigint>();
  const seen = new Set<string>();
  const days = new Set<number>();
  // Missing requested scopes in an otherwise complete daily report mean zero.
  for (let time = from; time < to; time += 86400000)
    for (const scope of parsed.scopeIds)
      totals.set(`${new Date(time).toISOString().slice(0, 10)}:${scope}`, 0n);
  const cursors = new Set<string>();
  const signal = AbortSignal.timeout(30_000);
  if (parsed.provider === "anthropic") {
    const identity = z.object({ id: z.string() }).parse(
      await boundedJson(
        await fetcher("https://api.anthropic.com/v1/organizations/me", {
          headers,
          signal,
          redirect: "error",
        }),
      ),
    );
    if (identity.id !== parsed.accountId)
      throw unprocessable(
        "The admin credential belongs to a different provider organization.",
      );
  }
  for (let page = 0; page < 100; page++) {
    const response = await fetcher(base, {
      headers,
      signal,
      redirect: "error",
    });
    const body = pageSchema.parse(await boundedJson(response));
    for (const bucket of body.data) {
      const start =
        parsed.provider === "openai"
          ? (bucket.start_time ?? NaN) * 1000
          : Date.parse(bucket.starting_at ?? "");
      const end =
        parsed.provider === "openai"
          ? (bucket.end_time ?? NaN) * 1000
          : Date.parse(bucket.ending_at ?? "");
      if (
        !Number.isFinite(start) ||
        start < from ||
        end > to ||
        end - start !== 86400000 ||
        start % 86400000 !== 0
      )
        throw unprocessable("Provider returned an unexpected billing period.");
      days.add(start);
      for (const result of bucket.results) {
        const scopeField = parsed.provider === "openai" ? "project_id" : "workspace_id";
        if (!Object.hasOwn(result, scopeField)) {
          throw unprocessable("Provider report is missing the requested project/workspace grouping.");
        }
        const scope =
          (parsed.provider === "openai"
            ? result.project_id
            : result.workspace_id) ?? "default";
        if (!parsed.scopeIds.includes(scope)) continue;
        const identity = `${new Date(start).toISOString().slice(0, 10)}:${scope}`;
        if (seen.has(identity))
          throw unprocessable("Provider returned overlapping billing buckets.");
        seen.add(identity);
        const currency =
          typeof result.amount === "object"
            ? result.amount.currency
            : result.currency;
        if (currency?.toUpperCase() !== "USD")
          throw unprocessable("Only USD provider cost reports are supported.");
        const units =
          parsed.provider === "openai" && typeof result.amount === "object"
            ? usdToUnits(result.amount.value)
            : parsed.provider === "anthropic" &&
                typeof result.amount === "string"
              ? centsToUnits(result.amount)
              : -1n;
        if (units < 0n)
          throw unprocessable("Provider returned an invalid billing amount.");
        totals.set(identity, units);
      }
    }
    if (!body.has_more) {
      if (days.size !== (to - from) / 86400000)
        throw unprocessable(
          "Provider report is incomplete; no financial events were changed.",
        );
      return [...totals].map(([key, value]) => ({
        day: key.slice(0, 10),
        scopeId: key.slice(11),
        amountCents: unitsToCents(value),
      }));
    }
    if (!body.next_page || cursors.has(body.next_page))
      throw unprocessable("Provider returned an invalid billing cursor.");
    cursors.add(body.next_page);
    base.searchParams.set("page", body.next_page);
  }
  throw unprocessable("Provider billing report exceeded the page limit.");
}

export async function importProviderDailyCosts(
  db: Db,
  companyId: string,
  raw: ImportProviderCosts,
  actorId: string,
  fetcher = fetch,
) {
  const input = importProviderCostsSchema.parse(raw);
  const [secret] = await db
    .select()
    .from(companySecrets)
    .where(
      and(
        eq(companySecrets.id, input.secretId),
        eq(companySecrets.companyId, companyId),
      ),
    );
  if (!secret || secret.scope !== "company")
    throw forbidden("Select a company billing credential.");
  const credential = await secretService(db).resolveSecretValue(
    companyId,
    secret.id,
    "latest",
    {
      accessContext: {
        consumerType: "system",
        consumerId: "provider-billing-import",
        actorType: "user",
        actorId,
      },
    },
  );
  // Compare database revisions, not application clocks: concurrent importers
  // can run on different hosts or start in the same millisecond.
  const snapshots = await db
    .select()
    .from(providerBillingSnapshots)
    .where(
      and(
        eq(providerBillingSnapshots.companyId, companyId),
        eq(providerBillingSnapshots.provider, input.provider),
        eq(providerBillingSnapshots.accountId, input.accountId),
        inArray(providerBillingSnapshots.scopeId, input.scopeIds),
        gte(providerBillingSnapshots.day, input.from),
        lt(providerBillingSnapshots.day, input.to),
      ),
    );
  const expectedRevisions = new Map(
    snapshots.map((row) => [`${row.day}:${row.scopeId}`, row.revision]),
  );
  const daily = await fetchProviderDailyCosts(input, credential, fetcher);
  return applyProviderDailyCosts(
    db,
    companyId,
    input,
    daily,
    actorId,
    expectedRevisions,
  );
}

export async function applyProviderDailyCosts(
  db: Db,
  companyId: string,
  input: ImportProviderCosts,
  daily: DailyProviderCost[],
  actorId: string,
  expectedRevisions?: ReadonlyMap<string, number>,
) {
  return withAccountingTransaction(db, companyId, async (tx, publications) => {
    let eventsCreated = 0;
    for (const day of daily) {
      const where = and(
        eq(providerBillingSnapshots.companyId, companyId),
        eq(providerBillingSnapshots.provider, input.provider),
        eq(providerBillingSnapshots.accountId, input.accountId),
        eq(providerBillingSnapshots.scopeId, day.scopeId),
        eq(providerBillingSnapshots.day, day.day),
      );
      const [previous] = await tx
        .select()
        .from(providerBillingSnapshots)
        .where(where);
      const delta =
        centsToUnits(day.amountCents) -
        centsToUnits(previous?.amountCents ?? "0");
      if (previous && delta === 0n) continue;
      if (
        expectedRevisions &&
        (previous?.revision ?? 0) !==
          (expectedRevisions.get(`${day.day}:${day.scopeId}`) ?? 0)
      )
        throw unprocessable(
          "A newer provider report was imported. Fetch the report again.",
        );
      const revision = (previous?.revision ?? 0) + 1;
      const [snapshot] = previous
        ? await tx
            .update(providerBillingSnapshots)
            .set({
              amountCents: day.amountCents,
              revision,
              updatedAt: new Date(),
            })
            .where(where)
            .returning()
        : await tx
            .insert(providerBillingSnapshots)
            .values({
              companyId,
              provider: input.provider,
              accountId: input.accountId,
              ...day,
              revision,
            })
            .returning();
      if (!delta) continue;
      await createFinanceEventInTransaction(
        tx,
        publications,
        companyId,
        {
          idempotencyKey: `provider-report:${snapshot.id}:${revision}`,
          biller: input.provider,
          eventKind: "inference_charge",
          direction: delta < 0n ? "credit" : "debit",
          currency: "USD",
          amountCents: unitsToCents(delta < 0n ? -delta : delta),
          occurredAt: new Date(`${day.day}T00:00:00.000Z`),
          description:
            `${input.provider} cost report · ${day.scopeId} · ${day.day}${revision > 1 ? " (correction)" : ""}`.slice(
              0,
              500,
            ),
          metadataJson: {
            source: "provider_cost_report",
            accountId: input.accountId,
            scopeId: day.scopeId,
            revision,
            totalCents: day.amountCents,
          },
        },
        { actorType: "user", actorId },
      );
      eventsCreated++;
    }
    return { daysRead: daily.length, eventsCreated };
  });
}
