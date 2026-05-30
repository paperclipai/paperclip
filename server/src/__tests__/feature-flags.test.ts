import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  featureFlags,
} from "@paperclipai/db";
import {
  FEATURE_FLAG_KEYS,
  isFeatureFlagEnabled,
  upsertFeatureFlag,
} from "../services/feature-flags.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres feature-flags tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("feature flags", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-feature-flags-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(featureFlags);
    await db.delete(companies);
  });

  async function makeCompany(): Promise<string> {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Test Co",
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  it("defaults to disabled when no row exists", async () => {
    companyId = await makeCompany();
    const state = await isFeatureFlagEnabled(db, {
      companyId,
      key: FEATURE_FLAG_KEYS.WORKSPACE_RUNTIME_V2,
    });
    expect(state.enabled).toBe(false);
    expect(state.source).toBe("default");
  });

  it("returns company-level state when no agent override is present", async () => {
    companyId = await makeCompany();
    await upsertFeatureFlag(db, {
      companyId,
      key: FEATURE_FLAG_KEYS.WORKSPACE_RUNTIME_V2,
      enabled: true,
    });
    const state = await isFeatureFlagEnabled(db, {
      companyId,
      key: FEATURE_FLAG_KEYS.WORKSPACE_RUNTIME_V2,
    });
    expect(state.enabled).toBe(true);
    expect(state.source).toBe("company");
  });

  it("prefers per-agent override over company-level value", async () => {
    companyId = await makeCompany();
    const coderAgentId = randomUUID();
    const otherAgentId = randomUUID();
    await upsertFeatureFlag(db, {
      companyId,
      key: FEATURE_FLAG_KEYS.WORKSPACE_RUNTIME_V2,
      enabled: false,
      agentOverrides: { [coderAgentId]: true },
    });

    const coderState = await isFeatureFlagEnabled(db, {
      companyId,
      key: FEATURE_FLAG_KEYS.WORKSPACE_RUNTIME_V2,
      agentId: coderAgentId,
    });
    expect(coderState.enabled).toBe(true);
    expect(coderState.source).toBe("agent_override");

    const otherState = await isFeatureFlagEnabled(db, {
      companyId,
      key: FEATURE_FLAG_KEYS.WORKSPACE_RUNTIME_V2,
      agentId: otherAgentId,
    });
    expect(otherState.enabled).toBe(false);
    expect(otherState.source).toBe("company");
  });

  it("supports negative per-agent overrides (force-off for specific agent)", async () => {
    companyId = await makeCompany();
    const agentId = randomUUID();
    await upsertFeatureFlag(db, {
      companyId,
      key: FEATURE_FLAG_KEYS.WORKSPACE_RUNTIME_V2,
      enabled: true,
      agentOverrides: { [agentId]: false },
    });
    const state = await isFeatureFlagEnabled(db, {
      companyId,
      key: FEATURE_FLAG_KEYS.WORKSPACE_RUNTIME_V2,
      agentId,
    });
    expect(state.enabled).toBe(false);
    expect(state.source).toBe("agent_override");
  });

  it("upserts cleanly — second call updates the row in place", async () => {
    companyId = await makeCompany();
    await upsertFeatureFlag(db, {
      companyId,
      key: FEATURE_FLAG_KEYS.WORKSPACE_RUNTIME_V2,
      enabled: false,
    });
    await upsertFeatureFlag(db, {
      companyId,
      key: FEATURE_FLAG_KEYS.WORKSPACE_RUNTIME_V2,
      enabled: true,
    });
    const rows = await db.select().from(featureFlags);
    expect(rows.length).toBe(1);
    expect(rows[0]!.enabled).toBe("on");
  });
});
