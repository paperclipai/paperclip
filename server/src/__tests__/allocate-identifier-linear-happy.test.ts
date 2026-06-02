// Phase 2.2 follow-up — happy-path test for allocateFromLinear().
//
// Lives in a separate test file from allocate-identifier.test.ts so the
// vi.mock() on ../services/secrets.js doesn't bleed into the error-envelope
// tests (which exercise the real secretService cast and the real DB error
// paths). vitest's module mocking is per-file, so isolation here is just
// "don't share the file".
//
// What this test pins down end-to-end (modulo the mocked boundary):
//   - allocateIdentifier dispatches to allocateFromLinear when
//     companies.identifier_provider = 'linear'.
//   - getLinearConfigForCompany picks up settings_json.{teamId, linearTokenRef}
//     and calls secretService.resolveSecretValue with the right args.
//   - createLinearIssue posts the IssueCreate mutation with the resolved
//     PAT as the Authorization header (no "Bearer " prefix), the configured
//     teamId, and the input title.
//   - The result extracts the numeric suffix from Linear's identifier,
//     populates source="linear", and threads externalIssueId.
//
// What this test does NOT pin down:
//   - The OAuth fallback paths in getLinearConfigForCompany (still TODO —
//     a separate test file would mock plugin_state lookups too).
//   - The compensating Linear-delete on tx rollback (covered separately
//     once the issues-create flow has its own integration test).
//   - The actual secretService → company_secrets resolution chain. That
//     would need the local_encrypted SecretProvider standing up with a
//     master-key file at vitest startup, which is a heavier setup than
//     this test needs.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above all imports below — `allocateIdentifier`'s import
// of `secretService` resolves to this stub.
vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveSecretValue: async () => "fake-linear-pat-from-test",
  }),
}));

import { companies, createDb, pluginCompanySettings, plugins } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { allocateIdentifier } from "../services/identifier-allocator.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("allocateFromLinear (happy path, mocked fetch + secrets)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  // `vi.spyOn(globalThis, "fetch")` returns a Mock with the full fetch signature.
  // `ReturnType<typeof vi.spyOn>` strips the generics and produces a wider Mock
  // that doesn't accept the specific spy back. Use any for the local handle.
  let fetchSpy: any = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-allocate-linear-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  async function seedLinearConfigured(opts: { teamId?: string }) {
    const [company] = await db
      .insert(companies)
      .values({
        name: `linear-happy ${randomUUID()}`,
        issuePrefix: `LH${randomUUID().slice(0, 6).toUpperCase()}`,
        identifierProvider: "linear",
      })
      .returning();
    const [plugin] = await db
      .insert(plugins)
      .values({
        pluginKey: "paperclip-plugin-linear",
        packageName: "@kkroo/paperclip-plugin-linear",
        version: "0.9.3",
        manifestJson: {} as never,
      })
      .returning();
    await db.insert(pluginCompanySettings).values({
      companyId: company.id,
      pluginId: plugin.id,
      settingsJson: {
        teamId: opts.teamId ?? "team-uuid-from-linear",
        // The actual UUID doesn't matter — secretService is mocked and the
        // resolveSecretValue stub above ignores all its arguments.
        linearTokenRef: "00000000-0000-0000-0000-000000000001",
      },
    });
    return { company, plugin };
  }

  it("posts IssueCreate to Linear with the configured teamId + resolved PAT, returns the Linear identifier", async () => {
    const { company } = await seedLinearConfigured({ teamId: "team-id-test-9999" });

    fetchSpy!.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "linear-uuid-abcdef",
                identifier: "BLO-9999",
                url: "https://linear.app/blockc/issue/BLO-9999/title-slug",
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await allocateIdentifier({
      db,
      companyId: company.id,
      title: "create me from a test",
      description: "optional body",
    });

    expect(result.source).toBe("linear");
    expect(result.identifier).toBe("BLO-9999");
    expect(result.issueNumber).toBe(9999);
    expect(result.externalIssueId).toBe("linear-uuid-abcdef");

    // Exactly one call to Linear
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy!.mock.calls[0]!;
    expect(url).toBe("https://api.linear.app/graphql");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    // PAT goes through verbatim — no "Bearer " prefix (matches linear-tunnel.ts).
    expect(headers.Authorization).toBe("fake-linear-pat-from-test");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init?.body as string);
    expect(body.query).toMatch(/mutation IssueCreate/);
    expect(body.variables.input.teamId).toBe("team-id-test-9999");
    expect(body.variables.input.title).toBe("create me from a test");
    expect(body.variables.input.description).toBe("optional body");
  });

  it("omits description from the IssueCreate input when caller doesn't provide one", async () => {
    const { company } = await seedLinearConfigured({});

    fetchSpy!.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            issueCreate: {
              success: true,
              issue: { id: "x", identifier: "BLO-1", url: "x" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await allocateIdentifier({ db, companyId: company.id, title: "no body" });

    const body = JSON.parse(fetchSpy!.mock.calls[0]![1]!.body as string);
    expect(body.variables.input).not.toHaveProperty("description");
  });

  it("surfaces Linear GraphQL errors as exceptions", async () => {
    const { company } = await seedLinearConfigured({});

    fetchSpy!.mockResolvedValue(
      new Response(
        JSON.stringify({
          errors: [{ message: "Argument Validation Error", path: ["issueCreate"] }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      allocateIdentifier({ db, companyId: company.id, title: "boom" }),
    ).rejects.toThrow(/Linear IssueCreate GraphQL errors/);
  });

  it("surfaces non-2xx responses as exceptions", async () => {
    const { company } = await seedLinearConfigured({});

    fetchSpy!.mockResolvedValue(
      new Response("rate limited", {
        status: 429,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    await expect(
      allocateIdentifier({ db, companyId: company.id, title: "rate" }),
    ).rejects.toThrow(/Linear IssueCreate HTTP 429/);
  });

  it("surfaces success=false from Linear as an exception", async () => {
    const { company } = await seedLinearConfigured({});

    fetchSpy!.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { issueCreate: { success: false, issue: null } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      allocateIdentifier({ db, companyId: company.id, title: "softfail" }),
    ).rejects.toThrow(/did not return an issue/);
  });
});
