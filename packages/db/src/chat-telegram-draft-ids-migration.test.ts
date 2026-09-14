import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describeEmbeddedPostgres("Telegram draft ID migration", () => {
  it(
    "never reuses draft IDs across rollback, concurrent allocation, or exhaustion",
    async () => {
      // Exhaustion is deliberately tested only in this disposable cluster, not
      // in a shared fixture database or the configured application database.
      const database = await startEmbeddedPostgresTestDatabase(
        "paperclip-telegram-draft-ids-",
      );
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, {
        max: 8,
        onnotice: () => {},
      });
      cleanups.push(async () => sql.end());

      const [configuration] = await sql`
        SELECT seqstart::integer AS start, seqmin::integer AS min,
          seqmax::integer AS max, seqincrement::integer AS increment,
          seqcache::integer AS cache, seqcycle AS cycle
        FROM pg_sequence WHERE seqrelid = 'public.chat_telegram_draft_ids'::regclass
      `;
      expect(configuration).toEqual({
        start: 1,
        min: 1,
        max: 2_147_483_647,
        increment: 1,
        cache: 1,
        cycle: false,
      });
      // No table owns this content-free sequence: deleting a company or its
      // endpoint cannot cascade away the non-reuse boundary.
      const dependencies = await sql`
        SELECT 1 FROM pg_depend
        WHERE classid = 'pg_class'::regclass
          AND objid = 'public.chat_telegram_draft_ids'::regclass
          AND deptype IN ('a', 'i')
      `;
      expect(dependencies).toHaveLength(0);

      let rolledBackId = 0;
      await expect(
        sql.begin(async (transaction) => {
          const [row] = await transaction`
          SELECT nextval('public.chat_telegram_draft_ids')::integer AS id
        `;
          rolledBackId = row.id;
          throw new Error("deliberate draft ownership transaction rollback");
        }),
      ).rejects.toThrow("deliberate draft ownership transaction rollback");
      expect(rolledBackId).toBe(1);

      const allocated = await Promise.all(
        Array.from({ length: 64 }, async () => {
          const [row] = await sql`
          SELECT nextval('public.chat_telegram_draft_ids')::integer AS id
        `;
          return row.id as number;
        }),
      );
      expect(allocated.sort((a, b) => a - b)).toEqual(
        Array.from({ length: 64 }, (_, index) => rolledBackId + index + 1),
      );

      await sql`SELECT setval('public.chat_telegram_draft_ids', 2147483647, false)`;
      const [last] =
        await sql`SELECT nextval('public.chat_telegram_draft_ids')::integer AS id`;
      expect(last.id).toBe(2_147_483_647);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          sql`SELECT nextval('public.chat_telegram_draft_ids')`,
        ).rejects.toMatchObject({
          code: "2200H",
        });
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});
