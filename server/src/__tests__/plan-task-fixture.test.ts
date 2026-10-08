import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { companySkillRoutes } from "../routes/company-skills.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/error-handler.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { preparePlanSkills, selectPlanSkills, verifyPlanSkills, verifyPlanSelection } from "../../../tests/runner-e2e/plan-task-skills.js";
import { planInvocations, planInvocationPrompt } from "../../../tests/runner-e2e/plan-task-exposure.js";
import { nativeTaskSkillInputs } from "../../../packages/paperclip-runner/src/backends/runtime-context.js";
import { resolveRunnerdCodexSkillInputs } from "../../../packages/paperclip-runner/src/live/runnerd-codex-transport.js";
import type { NativeRuntimeContextSnapshot } from "../../../packages/paperclip-runner/src/contracts/runtime-context.js";
import { PLAN_SKILLS, PLAN_VARIANTS, planHash } from "../../../tests/runner-e2e/plan-task-cases.js";
import type { RunnerApi } from "../../../tests/runner-e2e/api.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Planning fixture API calibration skipped: ${support.reason}`);
(support.supported ? describe : describe.skip)("planning fixture public API calibration (no providers)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  const savedHome = process.env.PAPERCLIP_HOME, savedInstance = process.env.PAPERCLIP_INSTANCE_ID;
  let api: Pick<RunnerApi, "get" | "post">;
  let app: express.Express;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-fixture-");
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-plan-fixture-home-"));
    process.env.PAPERCLIP_HOME = root;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "board", source: "local_implicit", isInstanceAdmin: true, userId: "local-board" }; next(); });
    app.use("/api", companySkillRoutes(db));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    api = {
      async get<T>(url: string): Promise<T> {
        const response = await request(app).get(url);
        if (response.status !== 200) throw new Error(`GET ${url}: ${response.status} ${JSON.stringify(response.body)}`);
        return response.body;
      },
      async post<T>(url: string, body?: unknown): Promise<T> {
        const response = await request(app).post(url).send(body as object);
        if (response.status < 200 || response.status >= 300) throw new Error(`POST ${url}: ${response.status} ${JSON.stringify(response.body)}`);
        return response.body;
      },
    };
  });
  afterAll(async () => {
    if (savedHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = savedHome;
    if (savedInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = savedInstance;
    await tempDb?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it.each(PLAN_VARIANTS)("admits %s through real creation, readback and selection APIs", async variant => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Planning calibration", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture Lead", role: "general", adapterType: "paperclip_runner", adapterConfig: {} });
    const before = await api.get<any[]>(`/api/companies/${companyId}/skills`);
    const bundled = before.find(s => s.key === PLAN_SKILLS[0].key);
    expect(bundled).toBeDefined();
    const sources = await preparePlanSkills(api, companyId, variant);
    expect(sources).toHaveLength(2);
    expect(sources.every(s => s.key.startsWith(`company/${companyId}/eval-`))).toBe(true);
    const selected = await selectPlanSkills(api, companyId, agentId, sources);
    const invocations = planInvocations(sources, selected);
    const contextSkills = [];
    for (const source of sources.filter(s => s.selected)) {
      const entry = (selected as any).entries.find((e: any) => e.key === source.key && e.desired);
      const bytes = await readFile(path.join(entry.sourcePath, "SKILL.md"));
      expect(planHash(bytes)).toBe(source.sha256);
      const mode = (await stat(path.join(entry.sourcePath, "SKILL.md"))).mode & 0o555;
      expect(mode).toBe(0o444);
      const digest = planHash(JSON.stringify([{ path: "SKILL.md", sha256: planHash(bytes), mode, size: bytes.length }]));
      expect(invocations.find(i => i.name === entry.runtimeName)?.assetDigest).toBe(digest);
      contextSkills.push({ key: source.key, runtimeName: entry.runtimeName, versionId: entry.currentVersionId,
        bundle: { rootPath: path.join(root, "runtime-context-assets/bundles", digest) } });
    }
    const context = { skills: contextSkills } as NativeRuntimeContextSnapshot;
    const inputs = nativeTaskSkillInputs(planInvocationPrompt("Business task", invocations), context);
    expect(inputs).toHaveLength(variant === "disabled" ? 0 : 2);
    expect(inputs.map(i => i.name)).toEqual(invocations.map(i => i.name));
    const providerHome = path.join(root, "isolated-codex-home");
    expect(resolveRunnerdCodexSkillInputs(inputs, context, providerHome)).toEqual(inputs.map(i => ({
      ...i, path: path.join(providerHome, "skills", i.name, "SKILL.md"),
    })));
    await verifyPlanSelection(api, companyId, agentId, sources);
    await verifyPlanSkills(api, companyId, sources);
    const after = await api.get<any[]>(`/api/companies/${companyId}/skills`);
    expect(after.find(s => s.key === bundled.key)?.id).toBe(bundled.id);
    expect(after.find(s => s.key === bundled.key)?.markdown).toBe(bundled.markdown);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    // Fail closed if a later actor changes either selection or source bytes.
    const swapped = sources.map(s => ({ ...s, selected: !s.selected }));
    await expect(verifyPlanSelection(api, companyId, agentId, swapped)).rejects.toThrow("selection differs");
    await expect(verifyPlanSkills(api, companyId, [{ ...sources[0]!, sha256: "wrong" }])).rejects.toThrow("guidance changed");
  }, 30_000);
});
