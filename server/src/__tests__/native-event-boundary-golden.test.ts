import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  localIntegrityBoundaryGolden as fixture,
  localIntegrityEventsFor as eventsFor,
} from "../../../packages/paperclip-runner/test-support/local-integrity-boundary-golden.js";

import { redactEventPayload } from "../redaction.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { validatePrpEvent } from "../vendor/paperclip-runner/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping native event boundary golden: ${embeddedPostgresSupport.reason ?? "unsupported host"}`,
  );
}

describeEmbeddedPostgres(
  "canonical native event storage and API boundary",
  () => {
    it("preserves each profile-tagged canonical discriminator and identity through storage and sanitization", async () => {
      const temporary = await startEmbeddedPostgresTestDatabase(
        "paperclip-native-boundary-",
      );
      const db = createDb(temporary.connectionString);
      const companyId = "73000000-0000-4000-8000-000000000001";

      try {
        await db.insert(companies).values({
          id: companyId,
          name: "Native boundary fixture",
          issuePrefix: "NBG",
        });

        for (const [profileIndex, profile] of fixture.profiles.entries()) {
          const agentId = `73000000-0000-4000-8000-${String(profileIndex + 201).padStart(12, "0")}`;
          await db.insert(agents).values({
            id: agentId,
            companyId,
            name: profile.id,
          });
          await db.insert(heartbeatRuns).values({
            id: profile.runId,
            companyId,
            agentId,
            status: "running",
          });

          const inputEvents = eventsFor(profile);
          for (const event of inputEvents) {
            expect(validatePrpEvent(event), event.sourceEventId).toEqual({
              ok: true,
              event: expect.any(Object),
              issues: [],
            });
            await appendHeartbeatRunEvent(db, {
              companyId,
              runId: profile.runId,
              agentId,
              eventType: event.eventType,
              stream: "system",
              level: "info",
              payload: { prpEvent: event },
              nativeSource: {
                sourceInstanceId: event.sourceInstanceId,
                sourceEventId: event.sourceEventId,
                sourceSeq: event.sourceSeq,
                protocolSchemaVersion: event.schemaVersion,
                canonicalPayload: event,
              },
            });
          }

          const rows = await db
            .select()
            .from(heartbeatRunEvents)
            .where(eq(heartbeatRunEvents.runId, profile.runId))
            .orderBy(asc(heartbeatRunEvents.seq));
          expect(rows).toHaveLength(inputEvents.length);
          expect(rows.map((row) => row.eventType)).toEqual(
            fixture.expected.eventTypes,
          );
          expect(rows.map((row) => row.sourceEventId)).toEqual(
            inputEvents.map((event) => event.sourceEventId),
          );

          const apiEvents = rows.map((row) => ({
            ...row,
            payload: redactEventPayload(row.payload),
          }));
          for (const [index, apiEvent] of apiEvents.entries()) {
            const envelope = apiEvent.payload?.prpEvent as Record<
              string,
              unknown
            >;
            const expected = inputEvents[index]!;
            expect(apiEvent.eventType, expected.sourceEventId).toBe(
              expected.eventType,
            );
            expect(envelope.eventType, expected.sourceEventId).toBe(
              expected.eventType,
            );
            expect(envelope.sourceEventId, expected.sourceEventId).toBe(
              expected.sourceEventId,
            );
            expect(envelope.itemId, expected.sourceEventId).toBe(
              expected.itemId,
            );
            expect(envelope.payload, expected.sourceEventId).toEqual(
              expected.payload,
            );
          }

          const payloadBySourceId = new Map(
            apiEvents.map((event) => {
              const envelope = event.payload?.prpEvent as Record<
                string,
                unknown
              >;
              return [
                String(envelope.sourceEventId).split(":").at(-1),
                envelope.payload as Record<string, unknown>,
              ];
            }),
          );
          expect(payloadBySourceId.get("progress-completed")).toMatchObject({
            itemId: fixture.expected.assistantItems[0]!.itemId,
            channel: "progress",
            providerPhase: "commentary",
          });
          expect(payloadBySourceId.get("reasoning-completed")).toMatchObject({
            itemId: fixture.expected.reasoningItemId,
            channel: "detail",
          });
          expect(payloadBySourceId.get("final-completed")).toMatchObject({
            itemId: fixture.expected.assistantItems[1]!.itemId,
            channel: "final",
            providerPhase: "final_answer",
          });
          expect(payloadBySourceId.get("question-created")).toMatchObject({
            request: {
              requestId: fixture.expected.questionRequestId,
              input: { schema: "paperclip.question_set.v1" },
            },
          });
        }
      } finally {
        await temporary.cleanup();
      }
    }, 60_000);
  },
);
