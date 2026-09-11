import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  closeRegisteredClients,
  ensurePostgresDatabase,
  inspectMigrations,
} from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// The deployed chat branch used 0240–0249 before master added its independent
// 0240–0245 execution-identity chain. These are the exact original SQL hashes,
// not hashes of regenerated DDL: the interaction migration also repairs data
// and must never run again just because its filename moved.
// The next upstream chain occupies0246–0254. Chat files now use0255–0268;
// historical data-repair audit labels remain byte-identical.
const chatMigrations = [
  [
    "0255_previous_captain_america",
    "2cbd1eb88d3bf4c82b72fdfd78dce72ecd7899f85607a76fb7e40b2749fffa00",
    1788580015986,
  ],
  [
    "0256_married_king_cobra",
    "f352a8769496412df3be35050df02110714af3a189d92b3c2ac8d097e2612c7b",
    1788581746772,
  ],
  [
    "0257_bizarre_the_hunter",
    "4e4636a22fb06aac55a998a0c98d043ec70083c198c94a0f5e0a99f18a1debac",
    1788582768429,
  ],
  [
    "0258_typical_sauron",
    "f3cb8b9d3bb3691d98a830c7ba8b4f49bbe9bb01ce2e899583d0b5c9b84d423c",
    1788585030341,
  ],
  [
    "0259_tan_chat",
    "91012c36bfcf66615b537ce808c9cb2f1311bc6efa6aab3ed8afd0d01298af75",
    1788673647823,
  ],
  [
    "0260_chat_interaction_wakeup_idempotency",
    "5e181169a724173d17865d537bd84c385e97e6f78e71aa795cad91734cd37ea0",
    1788688205087,
  ],
  [
    "0261_faulty_iceman",
    "dd7a7571e080471148cff98d1138ddd046e8c1e3c256fa5bc11564d5f4766c28",
    1788704871875,
  ],
  [
    "0262_lying_avengers",
    "59909e4edae56117c7fe0af28aa10fe30a64d151e83fe6e06debcec90658ff09",
    1788708784607,
  ],
  [
    "0263_nebulous_iron_lad",
    "858eb11c0863e361c1ae6995e78ca365f8002e35dcb1e89dbcc8bf65dea879e3",
    1788714691806,
  ],
  [
    "0264_cynical_hellcat",
    "d9aeacc58ae3c52d34bf50f8ea38f55435a6f8f66dc6ee87d3b78e105a86602a",
    1788793844054,
  ],
  [
    "0265_chat_interaction_wakeup_provenance",
    "1547e6e597b50c621691ead1d25624c4bf94ca3259cf24ea4480f3fb915dd849",
    1788880065244,
  ],
  [
    "0266_brave_living_mummy",
    "7c38ccd2fa6a9bde19d62b111f892bcabae9a8eabe5f8bf438f73a407016b56a",
    1788930085103,
  ],
  [
    "0267_warm_wild_child",
    "6902ea71d481a26d6359c6c9b149ff0c8a388e65356b066b2fbaa33622a6c9b8",
    1788934048647,
  ],
  [
    "0268_lively_runaways",
    "20ebd2ac15d9b467abcc5552901ecf592b38499942b3eae7d593c79fd89bd0a8",
    1788942847296,
  ],
] as const;

const identityMigrations = [
  "0240_pink_fantastic_four.sql",
  "0241_conscious_adam_destine.sql",
  "0242_wide_lightspeed.sql",
  "0243_sleepy_metal_master.sql",
  "0244_organic_meltdown.sql",
  "0245_misty_nightshade.sql",
];

const provenanceMigration = "0265_chat_interaction_wakeup_provenance.sql";
const legacyProvenance = "0245_chat_interaction_wakeup_idempotency";
const canonicalProvenance = "0251_chat_interaction_wakeup_idempotency";

async function executeMigration(sql: postgres.Sql, file: string) {
  const content = await readFile(
    new URL(`./migrations/${file}`, import.meta.url),
    "utf8",
  );
  for (const statement of content.split("--> statement-breakpoint")) {
    if (statement.trim()) await sql.unsafe(statement);
  }
}

async function migrationHash(file: string) {
  const content = await readFile(
    new URL(`./migrations/${file}`, import.meta.url),
  );
  return createHash("sha256").update(content).digest("hex");
}

describe("chat and execution identity migration reconciliation", () => {
  it("preserves all fourteen deployed chat SQL hashes after renumbering", async () => {
    for (const [tag, hash] of chatMigrations) {
      expect(await migrationHash(`${tag}.sql`), tag).toBe(hash);
    }
  });

  it("keeps canonical identity history in every regenerated chat checkpoint", async () => {
    const journal = JSON.parse(
      await readFile(
        new URL("./migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    );
    expect(
      journal.entries
        .filter(
          (entry: { idx: number }) => entry.idx >= 240 && entry.idx <= 245,
        )
        .map((entry: { tag: string }) => `${entry.tag}.sql`),
    ).toEqual(identityMigrations);
    expect(
      journal.entries
        .filter(
          (entry: { idx: number }) => entry.idx >= 255 && entry.idx <= 268,
        )
        .map((entry: { tag: string }) => entry.tag),
    ).toEqual(chatMigrations.map(([tag]) => tag));
    let previous = JSON.parse(
      await readFile(
        new URL("./migrations/meta/0254_snapshot.json", import.meta.url),
        "utf8",
      ),
    );
    for (let step = 0; step < chatMigrations.length; step++) {
      const index = String(255 + step).padStart(4, "0");
      const current = JSON.parse(
        await readFile(
          new URL(`./migrations/meta/${index}_snapshot.json`, import.meta.url),
          "utf8",
        ),
      );
      expect(current.prevId, index).toBe(previous.id);
      expect(current.tables["public.run_identity_contexts"], index).toEqual(
        previous.tables["public.run_identity_contexts"],
      );
      expect(
        current.tables["public.heartbeat_runs"].columns
          .active_identity_context_id,
        index,
      ).toBeDefined();
      expect(
        current.tables["public.issues"].columns.origin_identity_context_id,
        index,
      ).toBeDefined();
      expect(
        current.tables["public.issues"].columns
          .continuation_identity_context_id,
        index,
      ).toBeDefined();
      expect(
        current.tables["public.issue_thread_interactions"].columns
          .source_identity_context_id,
        index,
      ).toBeDefined();
      expect(
        Boolean(
          current.tables["public.chat_conversations"].columns
            .session_generation,
        ),
        index,
      ).toBe(step >= 1);
      expect(
        Boolean(
          current.tables["public.chat_endpoints"].indexes
            .chat_endpoints_live_bot_external_uq,
        ),
        index,
      ).toBe(step >= 2);
      expect(
        current.tables[
          "public.chat_publications"
        ].checkConstraints.chat_publications_state_check.value.includes(
          "delivery_unknown",
        ),
        index,
      ).toBe(step >= 3);
      expect(
        current.tables["public.chat_endpoints"].columns.allow_group_chats
          .default,
        index,
      ).toBe(step < 4);
      expect(
        current.tables[
          "public.agent_wakeup_requests"
        ].indexes.agent_wakeup_requests_question_response_delivery_idempotency_uq.where.includes(
          "interaction:%",
        ),
        index,
      ).toBe(step >= 5);
      expect(
        current.tables[
          "public.chat_endpoints"
        ].checkConstraints.chat_endpoints_provider_check.value.includes(
          "discord",
        ),
        index,
      ).toBe(step >= 6);
      expect(
        Boolean(
          current.tables["public.chat_endpoints"].indexes
            .chat_endpoints_live_discord_bot_external_uq,
        ),
        index,
      ).toBe(step >= 7);
      expect(
        Boolean(
          current.tables["public.chat_endpoints"].indexes
            .chat_endpoints_live_global_app_bot_external_uq,
        ),
        index,
      ).toBe(step >= 8);
      expect(
        Boolean(
          current.tables["public.issue_attachments"].columns.originating_run_id,
        ),
        index,
      ).toBe(step >= 9);
      previous = current;
    }
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "chat wake migration provenance",
  () => {
    it(
      "repairs deployed provenance without replaying historical SQL or changing wake execution state",
      async () => {
        const database = await startEmbeddedPostgresTestDatabase(
          "paperclip-chat-provenance-",
        );
        const sql = postgres(database.connectionString, {
          max: 1,
          onnotice: () => {},
        });
        try {
          const companyId = randomUUID(),
            agentId = randomUUID(),
            retainedId = randomUUID();
          await sql`INSERT INTO companies (id,name,issue_prefix) VALUES (${companyId},'Provenance upgrade','PRV')`;
          await sql`INSERT INTO agents (id,company_id,name) VALUES (${agentId},${companyId},'Upgrade agent')`;
          const originalKey = `interaction:${randomUUID()}`;
          const oldLine = `Safely retired duplicate by migration 0245; retained wake request ${retainedId}`;
          const newLine = `Safely retired duplicate by migration 0251; retained wake request ${retainedId}`;
          const retired = {
            migration: legacyProvenance,
            retainedWakeRequestId: retainedId,
            originalIdempotencyKey: originalKey,
            previousStatus: "queued",
            linkedRunId: null,
            resolution: "retired_unstarted_duplicate",
            futureAuditField: { preserved: true },
          };
          const cases: Array<{
            name: string;
            dedupe: postgres.JSONValue;
            key?: string;
            status?: string;
            error?: string | null;
            correct?: boolean;
            correctedError?: string | null;
            id?: string;
          }> = [
            {
              name: "retired first UUID",
              id: "00000000-0000-0000-0000-000000000000",
              dedupe: retired,
              error: oldLine,
              correct: true,
              correctedError: newLine,
            },
            {
              name: "preserves unrelated audit prefix",
              dedupe: retired,
              error: `Unrelated migration 0245 note\n${oldLine}`,
              correct: true,
              correctedError: `Unrelated migration 0245 note\n${newLine}`,
            },
            {
              name: "preserves non-final generated line",
              dedupe: retired,
              error: `${oldLine}\nLater operator note`,
              correct: true,
            },
            {
              name: "does not replace arbitrary suffix",
              dedupe: retired,
              error: `Operator quoted: ${oldLine}`,
              correct: true,
            },
            {
              name: "does not replace another retained ID",
              dedupe: retired,
              error: oldLine.replace(retainedId, randomUUID()),
              correct: true,
            },
            {
              name: "later terminalized rekeyed wake",
              dedupe: {
                ...retired,
                previousStatus: "running",
                linkedRunId: randomUUID(),
                resolution: "rekeyed_preserving_execution_history",
              },
              key: "historical",
              status: "failed",
              error: oldLine,
              correct: true,
            },
            {
              name: "already canonical",
              dedupe: { ...retired, migration: canonicalProvenance },
              error: oldLine,
            },
            {
              name: "unrelated migration",
              dedupe: { ...retired, migration: "0245_misty_nightshade" },
              error: oldLine,
            },
            { name: "array metadata", dedupe: [retired] },
            { name: "null metadata", dedupe: null },
            { name: "string metadata", dedupe: legacyProvenance },
            {
              name: "unknown resolution",
              dedupe: { ...retired, resolution: "unknown" },
            },
            {
              name: "missing linked-run field",
              dedupe: { ...retired, linkedRunId: undefined },
            },
            {
              name: "malformed retained ID",
              dedupe: { ...retired, retainedWakeRequestId: "not-a-uuid" },
            },
            {
              name: "malformed linked-run ID",
              dedupe: {
                ...retired,
                linkedRunId: "not-a-uuid",
                resolution: "rekeyed_preserving_execution_history",
              },
              key: "historical",
            },
            {
              name: "non-interaction source key",
              dedupe: { ...retired, originalIdempotencyKey: "timer:unrelated" },
            },
            {
              name: "non-string previous status",
              dedupe: { ...retired, previousStatus: ["queued"] },
            },
            {
              name: "inconsistent retired resolution",
              dedupe: { ...retired, previousStatus: "running" },
            },
            {
              name: "inconsistent rekeyed resolution",
              dedupe: {
                ...retired,
                resolution: "rekeyed_preserving_execution_history",
              },
              key: "historical",
            },
            {
              name: "unrelated current key",
              dedupe: retired,
              key: "timer:unrelated",
            },
          ];
          // More than one keyset batch, including an unrelated-only middle batch.
          await sql`INSERT INTO agent_wakeup_requests (id,company_id,agent_id,source,payload)
        SELECT ('00000000-0000-0000-0001-' || lpad(n::text,12,'0'))::uuid, ${companyId}, ${agentId}, 'timer', '{"unrelated":true}'::jsonb
        FROM generate_series(1,1001) AS n`;
          const expectedChanges = new Map<
            string,
            { error: string | null; payload: Record<string, unknown> }
          >();
          for (const fixture of cases) {
            const id = fixture.id ?? randomUUID();
            const key =
              fixture.key === "historical"
                ? `historical-interaction-wake-duplicate:${id}`
                : (fixture.key ?? originalKey);
            const payload = {
              unrelated: { preserved: true },
              migrationDedupe: fixture.dedupe,
            };
            const error = fixture.error ?? null;
            await sql`INSERT INTO agent_wakeup_requests
          (id,company_id,agent_id,source,reason,status,idempotency_key,run_id,payload,error,requested_at,claimed_at,finished_at,created_at,updated_at)
          VALUES (${id},${companyId},${agentId},'automation',${fixture.name},${fixture.status ?? "skipped"},${key},${fixture.status === "failed" ? randomUUID() : null},${sql.json(payload)},${error},'2026-09-01T00:00:00Z','2026-09-01T00:00:01Z','2026-09-01T00:00:02Z','2026-09-01T00:00:00Z','2026-09-01T00:00:02Z')`;
            if (fixture.correct)
              expectedChanges.set(id, {
                payload: {
                  ...payload,
                  migrationDedupe: {
                    ...(fixture.dedupe as object),
                    migration: canonicalProvenance,
                  },
                },
                error: fixture.correctedError ?? error,
              });
          }
          await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${await migrationHash(provenanceMigration)}`;
          const legacyHash = chatMigrations[5][1];
          await sql`UPDATE drizzle.__drizzle_migrations SET created_at = ${chatMigrations[5][2]} WHERE hash = ${legacyHash}`;
          const historyBefore =
            await sql`SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`;
          expect(
            historyBefore.filter((row) => row.hash === legacyHash),
          ).toHaveLength(1);
          const rowsBefore =
            await sql`SELECT row_to_json(w) AS row FROM agent_wakeup_requests w WHERE company_id = ${companyId} ORDER BY id`;
          const expected = rowsBefore.map(({ row }) => ({
            row: { ...row, ...expectedChanges.get(row.id) },
          }));
          expect(
            await inspectMigrations(database.connectionString),
          ).toMatchObject({
            status: "needsMigrations",
            pendingMigrations: [provenanceMigration],
          });
          await applyPendingMigrations(database.connectionString);
          expect(
            await sql`SELECT row_to_json(w) AS row FROM agent_wakeup_requests w WHERE company_id = ${companyId} ORDER BY id`,
          ).toEqual(expected);
          expect(
            await sql`SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations WHERE id <= ${historyBefore.at(-1)!.id} ORDER BY id`,
          ).toEqual(historyBefore);
          const historyAfter =
            await sql`SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`;
          expect(historyAfter).toHaveLength(historyBefore.length + 1);
          await executeMigration(sql, provenanceMigration);
          await applyPendingMigrations(database.connectionString);
          expect(
            await sql`SELECT row_to_json(w) AS row FROM agent_wakeup_requests w WHERE company_id = ${companyId} ORDER BY id`,
          ).toEqual(expected);
          expect(
            await sql`SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`,
          ).toEqual(historyAfter);
        } finally {
          await sql.end();
          await database.cleanup();
        }
      },
      EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
    );

    it(
      "corrects both original repair resolutions on a fresh migration path",
      async () => {
        const database = await startEmbeddedPostgresTestDatabase(
          "paperclip-chat-provenance-fresh-",
        );
        const sql = postgres(database.connectionString, {
          max: 1,
          onnotice: () => {},
        });
        try {
          const companyId = randomUUID(),
            agentId = randomUUID(),
            retainedId = randomUUID(),
            queuedId = randomUUID(),
            activeId = randomUUID();
          await sql`INSERT INTO companies (id,name,issue_prefix) VALUES (${companyId},'Fresh provenance','FPV')`;
          await sql`INSERT INTO agents (id,company_id,name) VALUES (${agentId},${companyId},'Fresh agent')`;
          await sql`DROP INDEX agent_wakeup_requests_question_response_delivery_idempotency_uq`;
          const key = `interaction:${randomUUID()}`;
          for (const [id, status, runId] of [
            [retainedId, "succeeded", randomUUID()],
            [queuedId, "queued", null],
            [activeId, "running", randomUUID()],
          ] as const) {
            await sql`INSERT INTO agent_wakeup_requests (id,company_id,agent_id,source,status,run_id,idempotency_key,payload,error)
          VALUES (${id},${companyId},${agentId},'automation',${status},${runId},${key},'{"preserved":true}'::jsonb,'Prior audit')`;
          }
          await executeMigration(sql, `${chatMigrations[5][0]}.sql`);
          const before =
            await sql`SELECT row_to_json(w) AS row FROM agent_wakeup_requests w WHERE company_id = ${companyId} ORDER BY id`;
          expect(
            before.filter(
              ({ row }) =>
                row.payload.migrationDedupe?.migration === legacyProvenance,
            ),
          ).toHaveLength(2);
          expect(
            before.find(({ row }) => row.id === queuedId)!.row.status,
          ).toBe("skipped");
          expect(
            before.find(({ row }) => row.id === activeId)!.row.status,
          ).toBe("running");
          await executeMigration(sql, provenanceMigration);
          const expected = before.map(({ row }) =>
            row.id === retainedId
              ? { row }
              : {
                  row: {
                    ...row,
                    payload: {
                      ...row.payload,
                      migrationDedupe: {
                        ...row.payload.migrationDedupe,
                        migration: canonicalProvenance,
                      },
                    },
                    error:
                      row.id === queuedId
                        ? `Prior audit\nSafely retired duplicate by migration 0251; retained wake request ${retainedId}`
                        : row.error,
                  },
                },
          );
          expect(
            await sql`SELECT row_to_json(w) AS row FROM agent_wakeup_requests w WHERE company_id = ${companyId} ORDER BY id`,
          ).toEqual(expected);
          await executeMigration(sql, provenanceMigration);
          expect(
            await sql`SELECT row_to_json(w) AS row FROM agent_wakeup_requests w WHERE company_id = ${companyId} ORDER BY id`,
          ).toEqual(expected);
        } finally {
          await sql.end();
          await database.cleanup();
        }
      },
      EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
    );
  },
);

(support.supported ? describe : describe.skip)(
  "chat identity migration upgrade",
  () => {
    it(
      "upgrades the actual prior chat schema through the new upstream chain without replaying chat effects",
      async () => {
        const database = await startEmbeddedPostgresTestDatabase(
          "paperclip-chat-upstream-upgrade-",
        );
        const source = postgres(database.connectionString, {
          max: 1,
          onnotice: () => {},
        });
        const directory = await mkdtemp(
          join(tmpdir(), "paperclip-chat-old-migrations-"),
        );
        const name = `legacy_chat_${randomUUID().replaceAll("-", "")}`;
        const legacyUrl = new URL(database.connectionString);
        legacyUrl.pathname = `/${name}`;
        let legacy: postgres.Sql | null = null;
        try {
          expect(
            await ensurePostgresDatabase(database.connectionString, name),
          ).toBe("created");
          legacy = postgres(legacyUrl.href, { max: 1, onnotice: () => {} });
          const journal = JSON.parse(
            await readFile(
              new URL("./migrations/meta/_journal.json", import.meta.url),
              "utf8",
            ),
          );
          const entries = journal.entries as Array<{
            idx: number;
            tag: string;
            when: number;
            version: string;
            breakpoints: boolean;
          }>;
          const priorEntries = entries
            .filter(
              (entry) => entry.idx < 246 || (entry.idx >= 255 && entry.idx <= 268),
            )
            .map((entry, index) => ({
              ...entry,
              idx: index,
              // Exact immutable007 chat-history timestamps. Filenames are not
              // persisted by Drizzle; the SQL hash and applied time are.
              when: entry.idx < 255 ? entry.when : [
                1788832469741, 1788832471197, 1788832472637,
                1788832474071, 1788832475492, 1788832476957,
                1788832478340, 1788832479792, 1788832481237,
                1788832482645, 1788880065244, 1788930085103,
                1788934048647, 1788942847296,
              ][entry.idx - 255]!,
            }));
          expect(priorEntries.every((entry) => Number.isFinite(entry.when))).toBe(true);
          await mkdir(join(directory, "meta"));
          for (const entry of priorEntries) {
            await writeFile(
              join(directory, `${entry.tag}.sql`),
              await readFile(
                new URL(`./migrations/${entry.tag}.sql`, import.meta.url),
              ),
            );
          }
          await writeFile(
            join(directory, "meta/_journal.json"),
            JSON.stringify({ ...journal, entries: priorEntries }),
          );
          // Run the real migration engine over the prior schema, not a current
          // schema with fabricated applied-history rows or dropped columns.
          await migrate(drizzle(legacy), { migrationsFolder: directory });
          const companyId = randomUUID(),
            agentId = randomUUID(),
            applicationId = randomUUID(),
            connectionId = randomUUID(),
            endpointId = randomUUID(),
            issueId = randomUUID(),
            conversationId = randomUUID(),
            publicationId = randomUUID();
          await legacy`INSERT INTO companies (id,name,issue_prefix) VALUES (${companyId},'Prior chat schema','OLD')`;
          await legacy`INSERT INTO agents (id,company_id,name) VALUES (${agentId},${companyId},'Prior agent')`;
          await legacy`INSERT INTO tool_applications (id,company_id,name,type) VALUES (${applicationId},${companyId},'Slack','rest_api')`;
          await legacy`INSERT INTO tool_connections (id,company_id,application_id,name,uid,connection_purpose,transport) VALUES (${connectionId},${companyId},${applicationId},'Slack','old-chat','channel','chat_sdk')`;
          await legacy`INSERT INTO chat_endpoints (id,company_id,connection_id,provider,public_id,assigned_agent_id) VALUES (${endpointId},${companyId},${connectionId},'slack',${randomUUID()},${agentId})`;
          await legacy`INSERT INTO issues (id,company_id,title) VALUES (${issueId},${companyId},'Retained source')`;
          await legacy`INSERT INTO chat_conversations (id,company_id,endpoint_id,issue_id,external_conversation_id,external_thread_id,external_label) VALUES (${conversationId},${companyId},${endpointId},${issueId},'COLD','slack:COLD:1700.1','Retained thread')`;
          await legacy`INSERT INTO chat_publications (id,company_id,endpoint_id,conversation_id,issue_id,idempotency_key,payload,state,attempts) VALUES (${publicationId},${companyId},${endpointId},${conversationId},${issueId},'retained-unknown','{"text":"Do not resend"}'::jsonb,'delivery_unknown',1)`;
          const before =
            await legacy`SELECT row_to_json(p) AS row FROM chat_publications p ORDER BY id`;
          const historyBefore =
            await legacy`SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`;
          const pending = entries
            .filter(
              (entry) => (entry.idx >= 246 && entry.idx <= 254) || entry.idx > 268,
            )
            .map((entry) => `${entry.tag}.sql`);
          expect(pending).toHaveLength(9 + entries.filter((entry) => entry.idx > 268).length);
          expect(await inspectMigrations(legacyUrl.href)).toMatchObject({
            status: "needsMigrations",
            pendingMigrations: pending,
          });
          await applyPendingMigrations(legacyUrl.href);
          expect((await inspectMigrations(legacyUrl.href)).status).toBe(
            "upToDate",
          );
          expect(
            await legacy`SELECT row_to_json(p) AS row FROM chat_publications p ORDER BY id`,
          ).toEqual(before);
          const historyAfter =
            await legacy`SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`;
          expect(historyAfter.slice(0, historyBefore.length)).toEqual(
            historyBefore,
          );
          expect(historyAfter).toHaveLength(
            historyBefore.length + pending.length,
          );
          for (const [, hash] of chatMigrations)
            expect(
              historyAfter.filter((row) => row.hash === hash),
            ).toHaveLength(1);
          const schema = async (sql: postgres.Sql) => ({
            columns:
              await sql`SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name`,
            indexes:
              await sql`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`,
            constraints:
              await sql`SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,k.conname`,
          });
          expect(await schema(legacy)).toEqual(await schema(source));
          await applyPendingMigrations(legacyUrl.href);
          expect(
            await legacy`SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`,
          ).toEqual(historyAfter);
          expect(
            await legacy`SELECT row_to_json(p) AS row FROM chat_publications p ORDER BY id`,
          ).toEqual(before);
        } finally {
          try {
            await legacy?.end();
          } finally {
            try {
              await source.end();
            } finally {
              try {
                await closeRegisteredClients(legacyUrl.href);
              } finally {
                try {
                  await database.cleanup();
                } finally {
                  await rm(directory, { recursive: true, force: true });
                }
              }
            }
          }
        }
      },
      EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
    );

    it(
      "migrates a fresh database and upgrades deployed chat history without replaying chat SQL",
      async () => {
        const database = await startEmbeddedPostgresTestDatabase(
          "paperclip-chat-identity-migration-",
        );
        const sql = postgres(database.connectionString, {
          max: 1,
          onnotice: () => {},
        });
        try {
          expect(
            (await inspectMigrations(database.connectionString)).status,
          ).toBe("upToDate");
          expect(
            (
              await sql`SELECT to_regclass('public.run_identity_contexts')::text AS identity, to_regclass('public.chat_publications')::text AS publications`
            )[0],
          ).toEqual({
            identity: "run_identity_contexts",
            publications: "chat_publications",
          });

          // Restore the schema/history shape of a deployed pre-identity chat DB.
          // This disposable database is owned solely by this test; no live fixture
          // is modified. Its already-applied chat SQL retains the original hashes
          // and timestamps, even though the checkout now uses new filenames.
          await sql`ALTER TABLE heartbeat_runs DROP COLUMN active_identity_context_id`;
          await sql`ALTER TABLE issues DROP COLUMN origin_identity_context_id, DROP COLUMN continuation_identity_context_id`;
          await sql`ALTER TABLE issue_thread_interactions DROP COLUMN source_identity_context_id`;
          await sql`DROP TABLE run_identity_contexts`;
          for (const file of identityMigrations) {
            await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${await migrationHash(file)}`;
          }
          for (const [, hash, timestamp] of chatMigrations) {
            await sql`UPDATE drizzle.__drizzle_migrations SET created_at = ${timestamp} WHERE hash = ${hash}`;
          }

          const companyId = randomUUID(),
            agentId = randomUUID(),
            applicationId = randomUUID(),
            connectionId = randomUUID(),
            endpointId = randomUUID(),
            issueId = randomUUID(),
            conversationId = randomUUID(),
            publicationId = randomUUID();
          await sql`INSERT INTO companies (id,name,issue_prefix) VALUES (${companyId},'Chat upgrade','CUP')`;
          await sql`INSERT INTO agents (id,company_id,name) VALUES (${agentId},${companyId},'Chat agent')`;
          await sql`INSERT INTO tool_applications (id,company_id,name,type) VALUES (${applicationId},${companyId},'Slack','rest_api')`;
          await sql`INSERT INTO tool_connections (id,company_id,application_id,name,uid,connection_purpose,transport) VALUES (${connectionId},${companyId},${applicationId},'Slack','slack-upgrade','channel','chat_sdk')`;
          await sql`INSERT INTO chat_endpoints (id,company_id,connection_id,provider,public_id,assigned_agent_id) VALUES (${endpointId},${companyId},${connectionId},'slack',${randomUUID()},${agentId})`;
          await sql`INSERT INTO issues (id,company_id,title) VALUES (${issueId},${companyId},'Existing chat task')`;
          await sql`INSERT INTO chat_conversations (id,company_id,endpoint_id,issue_id,external_conversation_id,external_thread_id,external_label) VALUES (${conversationId},${companyId},${endpointId},${issueId},'CUPGRADE','slack:CUPGRADE:1700.1','Existing Slack thread')`;
          await sql`INSERT INTO chat_publications (id,company_id,endpoint_id,conversation_id,issue_id,idempotency_key,payload,state,attempts) VALUES (${publicationId},${companyId},${endpointId},${conversationId},${issueId},'existing-unknown-file','{"attachmentIds":["existing-attachment"]}'::jsonb,'delivery_unknown',1)`;
          const rowsBefore =
            await sql`SELECT row_to_json(p) AS row FROM chat_publications p WHERE id = ${publicationId}`;
          const historyBefore =
            await sql`SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`;
          expect(
            await inspectMigrations(database.connectionString),
          ).toMatchObject({
            status: "needsMigrations",
            pendingMigrations: identityMigrations,
          });

          await applyPendingMigrations(database.connectionString);
          expect(
            (await inspectMigrations(database.connectionString)).status,
          ).toBe("upToDate");
          expect(
            await sql`SELECT row_to_json(p) AS row FROM chat_publications p WHERE id = ${publicationId}`,
          ).toEqual(rowsBefore);
          expect(
            await sql`SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations WHERE id <= ${historyBefore.at(-1)!.id} ORDER BY id`,
          ).toEqual(historyBefore);
          expect(
            (
              await sql`SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations`
            )[0].count,
          ).toBe(historyBefore.length + identityMigrations.length);
          expect(
            (
              await sql`SELECT origin_identity_context_id,continuation_identity_context_id FROM issues WHERE id = ${issueId}`
            )[0],
          ).toEqual({
            origin_identity_context_id: null,
            continuation_identity_context_id: null,
          });
          const historyAfter =
            await sql`SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`;
          await applyPendingMigrations(database.connectionString);
          expect(
            await sql`SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`,
          ).toEqual(historyAfter);
        } finally {
          await sql.end();
          await database.cleanup();
        }
      },
      EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
    );
  },
);
