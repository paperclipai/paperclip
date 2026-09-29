import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("chat tenant foreign keys", () => {
  it(
    "rejects cross-company references without breaking nullable-link deletion",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase(
        "paperclip-chat-tenant-fks-",
      );
      const sql = postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
      });
      try {
        const make = async () => {
          const ids = Object.fromEntries(
            [
              "company",
              "agent",
              "application",
              "connection",
              "endpoint",
              "issue",
              "comment",
              "conversation",
              "delivery",
              "publication",
              "principal",
              "action",
              "link",
            ].map((key) => [key, randomUUID()]),
          );
          await sql`INSERT INTO companies (id,name,issue_prefix) VALUES (${ids.company},'Tenant fixture',${ids.company})`;
          await sql`INSERT INTO agents (id,company_id,name) VALUES (${ids.agent},${ids.company},'Agent')`;
          await sql`INSERT INTO tool_applications (id,company_id,name,type) VALUES (${ids.application},${ids.company},'Fixture','mcp_http')`;
          await sql`INSERT INTO tool_connections (id,company_id,application_id,uid,name,transport) VALUES (${ids.connection},${ids.company},${ids.application},${randomUUID()},'Fixture','rest_api')`;
          await sql`INSERT INTO chat_endpoints (id,company_id,connection_id,provider,public_id,assigned_agent_id) VALUES (${ids.endpoint},${ids.company},${ids.connection},'slack',${randomUUID()},${ids.agent})`;
          await sql`INSERT INTO issues (id,company_id,title) VALUES (${ids.issue},${ids.company},'Fixture')`;
          await sql`INSERT INTO issue_comments (id,company_id,issue_id,body) VALUES (${ids.comment},${ids.company},${ids.issue},'Fixture')`;
          await sql`INSERT INTO chat_conversations (id,company_id,endpoint_id,issue_id,external_conversation_id,external_label) VALUES (${ids.conversation},${ids.company},${ids.endpoint},${ids.issue},'C1','Fixture')`;
          await sql`INSERT INTO chat_external_principals (id,company_id,provider,provider_account_id,external_id,kind,display_name) VALUES (${ids.principal},${ids.company},'slack','T1','U1','user','Fixture')`;
          await sql`INSERT INTO chat_deliveries (id,company_id,endpoint_id,conversation_id,principal_id,provider_event_id,deduplication_key,event_kind,normalized_event) VALUES (${ids.delivery},${ids.company},${ids.endpoint},${ids.conversation},${ids.principal},'E1','E1','message','{}')`;
          await sql`INSERT INTO chat_publications (id,company_id,endpoint_id,conversation_id,issue_id,comment_id,idempotency_key,payload) VALUES (${ids.publication},${ids.company},${ids.endpoint},${ids.conversation},${ids.issue},${ids.comment},'P1','{}')`;
          await sql`INSERT INTO chat_actions (id,company_id,endpoint_id,delivery_id,conversation_id,principal_id,kind,provider_action_id) VALUES (${ids.action},${ids.company},${ids.endpoint},${ids.delivery},${ids.conversation},${ids.principal},'fixture','A1')`;
          await sql`INSERT INTO chat_message_links (id,company_id,endpoint_id,conversation_id,delivery_id,publication_id,comment_id,provider_message_id,direction) VALUES (${ids.link},${ids.company},${ids.endpoint},${ids.conversation},${ids.delivery},${ids.publication},${ids.comment},'M1','outbound')`;
          return ids;
        };
        const own = await make();
        const foreign = await make();
        const references = [
          ["chat_endpoints", "assigned_agent_id", "endpoint", "agent"],
          ["chat_conversations", "issue_id", "conversation", "issue"],
          ["chat_publications", "issue_id", "publication", "issue"],
          ["chat_publications", "comment_id", "publication", "comment"],
          ["chat_message_links", "endpoint_id", "link", "endpoint"],
          ["chat_message_links", "delivery_id", "link", "delivery"],
          ["chat_message_links", "publication_id", "link", "publication"],
          ["chat_message_links", "comment_id", "link", "comment"],
          ["chat_actions", "delivery_id", "action", "delivery"],
          ["chat_actions", "conversation_id", "action", "conversation"],
          ["chat_actions", "principal_id", "action", "principal"],
        ];
        for (const [table, column, row, target] of references) {
          await expect(
            sql.unsafe(`UPDATE "${table}" SET "${column}" = $1 WHERE id = $2`, [
              foreign[target],
              own[row],
            ]),
            `${table}.${column}`,
          ).rejects.toMatchObject({ code: "23503" });
          // A same-company reference remains valid after the rejected statement.
          await sql.unsafe(
            `UPDATE "${table}" SET "${column}" = $1 WHERE id = $2`,
            [own[target], own[row]],
          );
        }
        await sql`DELETE FROM issue_comments WHERE id = ${own.comment}`;
        await sql`DELETE FROM chat_publications WHERE id = ${own.publication}`;
        await sql`DELETE FROM chat_deliveries WHERE id = ${own.delivery}`;
        const [link] =
          await sql`SELECT company_id, comment_id, publication_id, delivery_id FROM chat_message_links WHERE id = ${own.link}`;
        expect(link).toEqual({
          company_id: own.company,
          comment_id: null,
          publication_id: null,
          delivery_id: null,
        });
        const [action] =
          await sql`SELECT company_id, delivery_id FROM chat_actions WHERE id = ${own.action}`;
        expect(action).toEqual({ company_id: own.company, delivery_id: null });
        // Durable action references retain their original conversation/principal;
        // unlike delivery_id these parents had no legacy SET NULL behavior.
        await expect(
          sql`DELETE FROM chat_conversations WHERE id = ${own.conversation}`,
        ).rejects.toMatchObject({ code: "23503" });
        await expect(
          sql`DELETE FROM chat_external_principals WHERE id = ${own.principal}`,
        ).rejects.toMatchObject({ code: "23503" });
        await expect(
          sql`DELETE FROM agents WHERE id = ${own.agent}`,
        ).rejects.toMatchObject({ code: "23001" });
        // Existing chat history deliberately restricts deleting its task.
        await expect(
          sql`DELETE FROM issues WHERE id = ${own.issue}`,
        ).rejects.toMatchObject({ code: "23001" });
        const [conversation] =
          await sql`SELECT company_id, issue_id FROM chat_conversations WHERE id = ${own.conversation}`;
        expect(conversation).toEqual({
          company_id: own.company,
          issue_id: own.issue,
        });
        // Existing company deletion requires its service's explicit child cleanup.
        // A direct rejected delete must not partially cascade into chat history.
        await expect(
          sql`DELETE FROM companies WHERE id = ${foreign.company}`,
        ).rejects.toMatchObject({ code: "23503" });
        expect(
          await sql`SELECT id FROM chat_actions WHERE id = ${foreign.action}`,
        ).toHaveLength(1);
        // This tests the endpoint/conversation ownership graph with no resource
        // binding; it does not qualify preexisting resource SET NULL constraints.
        await sql`DELETE FROM chat_endpoints WHERE id = ${foreign.endpoint}`;
        for (const table of [
          "chat_endpoints",
          "chat_conversations",
          "chat_deliveries",
          "chat_publications",
          "chat_actions",
          "chat_message_links",
        ]) {
          expect(
            await sql.unsafe(
              `SELECT id FROM "${table}" WHERE company_id = $1`,
              [foreign.company],
            ),
            table,
          ).toHaveLength(0);
        }
        expect(
          await sql`SELECT id FROM chat_actions WHERE id = ${own.action}`,
        ).toHaveLength(1);
        const nullable = await make();
        await sql`DELETE FROM chat_actions WHERE id = ${nullable.action}`;
        const resourceId = randomUUID();
        await sql`INSERT INTO chat_endpoint_resources (id,company_id,endpoint_id,type,provider_resource_id,label) VALUES (${resourceId},${nullable.company},${nullable.endpoint},'channel','C1','Fixture')`;
        await sql`UPDATE chat_conversations SET resource_id = ${resourceId} WHERE id = ${nullable.conversation}`;
        await sql`DELETE FROM chat_endpoint_resources WHERE id = ${resourceId}`;
        expect(
          (
            await sql`SELECT company_id, resource_id FROM chat_conversations WHERE id = ${nullable.conversation}`
          )[0],
        ).toEqual({ company_id: nullable.company, resource_id: null });
        await sql`DELETE FROM chat_conversations WHERE id = ${nullable.conversation}`;
        expect(
          (
            await sql`SELECT company_id, conversation_id FROM chat_deliveries WHERE id = ${nullable.delivery}`
          )[0],
        ).toEqual({ company_id: nullable.company, conversation_id: null });
        await sql`DELETE FROM chat_external_principals WHERE id = ${nullable.principal}`;
        expect(
          (
            await sql`SELECT company_id, principal_id FROM chat_deliveries WHERE id = ${nullable.delivery}`
          )[0],
        ).toEqual({ company_id: nullable.company, principal_id: null });
        const resourceBound = await make();
        const boundResourceId = randomUUID();
        await sql`INSERT INTO chat_endpoint_resources (id,company_id,endpoint_id,type,provider_resource_id,label) VALUES (${boundResourceId},${resourceBound.company},${resourceBound.endpoint},'channel','C1','Fixture')`;
        await sql`UPDATE chat_conversations SET resource_id = ${boundResourceId} WHERE id = ${resourceBound.conversation}`;
        await sql`DELETE FROM chat_endpoints WHERE id = ${resourceBound.endpoint}`;
        expect(
          await sql`SELECT id FROM chat_conversations WHERE company_id = ${resourceBound.company}`,
        ).toHaveLength(0);
        expect(
          await sql`SELECT id FROM chat_message_links WHERE company_id = ${resourceBound.company}`,
        ).toHaveLength(0);
      } finally {
        try {
          await sql.end();
        } finally {
          await database.cleanup();
        }
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});
