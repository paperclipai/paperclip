import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, companySkillSources, companySkills, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, projectAccessMembers, projects, projectSkillSources } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { PAPERCLIP_FEEDBACK_SKILL_KEYS, PAPERCLIP_OPERATIONAL_SKILL_KEY, readPaperclipRuntimeSkillEntries, writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { buildSkillLibraryManifestMarkdown } from "@paperclipai/adapter-utils/skill-library-manifest";
import { applyConnectorSkills } from "../services/connector-runtime.js";
import { readAssignedSkill } from "../services/native-runtime/runner-bridge-tools.js";
import { companySkillService } from "../services/company-skills.js";
import { authorizationService, type AuthorizationActor } from "../services/authorization.js";
import { skillAccessService, withSkillActor } from "../services/skill-access.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("selected runtime skill reconciliation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousPrivacy = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  const companyId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("runtime-skill-selection-");
    db = createDb(database.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-skill-selection-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    await db.insert(companies).values({ id: companyId, name: "Runtime selection", issuePrefix: `RS${companyId.slice(0, 6)}` });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (previousPrivacy === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousPrivacy;
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  it("delivers the real legacy operational selection on cold and repeated reads", async () => {
    for (const phase of ["cold", "warm", "repeated"] as const) {
      const select = vi.spyOn(db, "select");
      const insert = vi.spyOn(db, "insert");
      const update = vi.spyOn(db, "update");
      const cpu = process.cpuUsage();
      const started = performance.now();
      try {
        const entries = await companySkillService(db).listRuntimeSkillEntries(companyId, {
          selectionConfig: { paperclipSkillSync: { desiredSkills: [] } },
          includeLegacy: true,
          snapshotLatest: true,
        });
        console.info(JSON.stringify({ phase, elapsedMs: performance.now() - started,
          cpuMicros: process.cpuUsage(cpu), selectBuilderCalls: select.mock.calls.length,
          insertBuilderCalls: insert.mock.calls.length, updateBuilderCalls: update.mock.calls.length,
          delivered: entries.map(entry => entry.key) }));
        expect(entries.map(entry => entry.key).sort()).toEqual([PAPERCLIP_OPERATIONAL_SKILL_KEY, ...PAPERCLIP_FEEDBACK_SKILL_KEYS].sort());
        expect(entries.every(entry => entry.sourceStatus === "available" && entry.versionId)).toBe(true);
      } finally {
        select.mockRestore();
        insert.mockRestore();
        update.mockRestore();
      }
    }
  }, 30_000);

  it("reuses installed explicit selections without importing the company inventory again", async () => {
    const service = companySkillService(db);
    const initial = await service.listRuntimeSkillEntries(companyId, { includeLegacy:true, snapshotLatest:true });
    expect(initial.length).toBeGreaterThan(0);
    const insert = vi.spyOn(db, "insert"), update = vi.spyOn(db, "update");
    try {
      const selected = await service.listRuntimeSkillEntries(companyId, {
        onlyKeys:new Set([initial[0]!.key]), snapshotLatest:true,
      });
      expect(selected.map(entry => entry.key)).toEqual([initial[0]!.key]);
      expect(selected[0]!.versionId).toBe(initial[0]!.versionId);
      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    } finally { insert.mockRestore(); update.mockRestore(); }
  });

  it("uses the committed bundled version even when a legacy installation path contains different bytes", async () => {
    const service=companySkillService(db);
    const initial=await service.listRuntimeSkillEntries(companyId,{includeLegacy:true,snapshotLatest:true});
    const selected=initial[0]!;
    const old=path.join(home,"previous-installation","skill");
    await fs.mkdir(old,{recursive:true});
    await fs.writeFile(path.join(old,"SKILL.md"),"Old installation content");
    await db.update(companySkills).set({sourceLocator:old}).where(and(eq(companySkills.companyId,companyId),eq(companySkills.key,selected.key)));
    const current=await service.listRuntimeSkillEntries(companyId,{onlyKeys:new Set([selected.key]),snapshotLatest:true});
    expect(await fs.readFile(path.join(current[0]!.source,"SKILL.md"),"utf8")).toBe(await fs.readFile(path.join(selected.source,"SKILL.md"),"utf8"));
    const [row]=await db.select().from(companySkills).where(and(eq(companySkills.companyId,companyId),eq(companySkills.key,selected.key)));
    expect(row!.currentVersionId).toBe(selected.versionId);
    expect(await fs.readFile(path.join(old,"SKILL.md"),"utf8")).toBe("Old installation content");
  });

  it("does not re-authorize each delivered skill version after the selected rows were read", async () => {
    const [agent] = await db.insert(agents).values({ companyId, name: "Versioned runtime reader", adapterType: "codex_local" }).returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, membershipRole: "member" });
    const actor: AuthorizationActor = { type: "agent", agentId: agent!.id, companyId, source: "agent_jwt" };
    const installed = await withSkillActor(actor, () => companySkillService(db).listRuntimeSkillEntries(companyId, {
      selectionConfig: { paperclipSkillSync: { desiredSkills: [] } }, includeLegacy: true, snapshotLatest: true,
    }));
    const read = () => withSkillActor(actor, () => companySkillService(db).listRuntimeSkillEntries(companyId, {
      onlyKeys: new Set(installed.map(entry => entry.key)), snapshotLatest: true,
    }));
    const sourceReads: unknown[] = [];
    const select = db.select.bind(db);
    const spy = vi.spyOn(db, "select").mockImplementation(((...args: Parameters<typeof db.select>) => {
      const builder = select(...args);
      const from = builder.from.bind(builder);
      builder.from = ((table: unknown) => {
        if (table === companySkillSources) sourceReads.push(table);
        return from(table as never);
      }) as typeof builder.from;
      return builder;
    }) as typeof db.select);
    try {
      const entries = await read();
      expect(entries.length).toBeGreaterThan(2);
      expect(entries.every(entry => entry.sourceStatus === "available" && entry.versionId)).toBe(true);
      expect(sourceReads).toHaveLength(0);
    } finally { spy.mockRestore(); }
  }, 30_000);

  it("bounds project-source authorization work without caching changed permissions", async () => {
    const [agent] = await db.insert(agents).values({ companyId, name: "Selected runtime reader", adapterType: "codex_local" }).returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, membershipRole: "member" });
    const actor: AuthorizationActor = { type: "agent", agentId: agent!.id, companyId, source: "agent_jwt" };
    const counts: number[] = [];
    let revoked: { sourceId: string; projectId: string } | undefined;
    for (const count of [5, 75]) {
      const rows = await db.insert(projects).values(Array.from({ length: count }, (_, index) => ({
        id: randomUUID(), companyId, name: `Runtime source ${count}/${index}`, visibility: "private",
      }))).returning();
      const sources = await db.insert(companySkillSources).values(rows.map(row => ({
        id: randomUUID(), companyId, repositoryUrl: `https://github.com/fixture/${row.id}`, fullName: `fixture/${row.id}`,
        trackingRef: "main", accessScope: "projects" as const,
      }))).returning();
      await db.insert(projectSkillSources).values(rows.map((row, index) => ({
        companyId, projectId: row.id, sourceId: sources[index]!.id, repositoryUrl: sources[index]!.repositoryUrl,
        trackingRef: "main", status: "ready" as const,
      })));
      await db.insert(projectAccessMembers).values(rows.filter((_, index) => index % 2 === 0).map(row => ({
        companyId, projectId: row.id, subjectType: "agent", subjectId: agent!.id,
      })));
      revoked = { sourceId: sources[0]!.id, projectId: rows[0]!.id };
      const bindings = await db.select().from(projectSkillSources).where(eq(projectSkillSources.companyId, companyId));
      const expected = new Set<string>();
      for (const binding of bindings) {
        const decision = await authorizationService(db).decide({ actor, action: "project:read",
          resource: { type: "project", companyId, projectId: binding.projectId } });
        if (decision.allowed) expected.add(binding.sourceId!);
      }
      const select = vi.spyOn(db, "select");
      const started = performance.now();
      try {
        const visible = await skillAccessService(db, actor).visibleSourceIds(companyId);
        counts.push(select.mock.calls.length);
        console.info(JSON.stringify({ phase: "actor-source-authorization", projects: bindings.length,
          elapsedMs: performance.now() - started, selectBuilderCalls: select.mock.calls.length }));
        expect(new Set(visible)).toEqual(expected);
      } finally { select.mockRestore(); }
    }
    await db.delete(projectAccessMembers).where(and(eq(projectAccessMembers.projectId, revoked!.projectId),
      eq(projectAccessMembers.subjectId, agent!.id)));
    expect(await skillAccessService(db, actor).visibleSourceIds(companyId)).not.toContain(revoked!.sourceId);
    const select = vi.spyOn(db, "select");
    const runtimeStarted = performance.now();
    try {
      const entries = await withSkillActor(actor, () => companySkillService(db).listRuntimeSkillEntries(companyId, {
        selectionConfig: { paperclipSkillSync: { desiredSkills: [] } }, includeLegacy: true, snapshotLatest: true,
      }));
      console.info(JSON.stringify({ phase: "actor-runtime", projects: 80, elapsedMs: performance.now() - runtimeStarted,
        selectBuilderCalls: select.mock.calls.length }));
      expect(entries.map(entry => entry.key).sort()).toEqual([PAPERCLIP_OPERATIONAL_SKILL_KEY, ...PAPERCLIP_FEEDBACK_SKILL_KEYS].sort());
    } finally { select.mockRestore(); }
    expect(counts[1]).toBeLessThanOrEqual(counts[0]! + 2);
  }, 30_000);
  it("enforces recipient isolation through catalogs, known IDs, pinned content and runtime delivery", async () => {
    const names = ["marketing-loops", "product-marketing", "aso", "paywalls", "signup"];
    const ownerId = "ba890097-36dd-47a1-8b92-c431145099fa";
    const fixtureAgents = await db.insert(agents).values([
      { id: ownerId, companyId, name: "Publishing owner", adapterType: "claude_local" },
      ...["claude_local", "codex_local", "paperclip_runner"].map(adapterType => ({
        companyId, name: `Other ${adapterType}`, adapterType,
      })),
    ]).returning();
    const actorFor = (agentId: string): AuthorizationActor => ({ type: "agent", agentId, companyId, source: "agent_jwt" });
    const serviceFor = (agentId: string) => companySkillService(db, { actor: actorFor(agentId) });
    const runtime = async (agent: typeof fixtureAgents[number], keys: string[] = []) => {
      const config = writePaperclipSkillSyncPreference({}, keys);
      return withSkillActor(actorFor(agent.id), () => serviceFor(agent.id).withRuntimeSkillEntries(companyId, {
        selectionConfig: config, includeLegacy: agent.adapterType !== "paperclip_runner", snapshotLatest: true,
      }, async entries => {
        const delivered = await applyConnectorSkills(config, entries, []);
        const inventory = await readPaperclipRuntimeSkillEntries(delivered, home);
        return { keys: inventory.map(entry => entry.key),
          instructions: buildSkillLibraryManifestMarkdown({ entries: inventory, desiredSkillKeys: new Set(inventory.map(entry => entry.key)) }),
          files: await Promise.all(inventory.map(entry => fs.readFile(path.join(entry.source, "SKILL.md"), "utf8"))),
        };
      }));
    };
    const peers = (await db.select().from(agents).where(eq(agents.companyId, companyId))).filter(agent => agent.id !== ownerId);
    const before = await Promise.all(peers.map(async agent => ({
      catalog: await serviceFor(agent.id).list(companyId), runtime: await runtime(agent), permissions: agent.permissions,
    })));
    const board = companySkillService(db, { actor: { type: "board", source: "local_implicit" } });
    const fixtures = [];
    for (const name of names) {
      const skill = await board.createLocalSkill(companyId, { name, slug: name,
        markdown: `---\nname: ${name}\n---\nSafe fixture content for ${name}.\n`,
      });
      await db.update(companySkills).set({ recipientAgentId: ownerId }).where(eq(companySkills.id, skill.id));
      fixtures.push(skill);
    }
    const keys = fixtures.map(skill => skill.key);
    expect((await serviceFor(ownerId).list(companyId)).filter(skill => keys.includes(skill.key))).toHaveLength(5);
    for (const skill of fixtures) {
      expect((await serviceFor(ownerId).getById(companyId, skill.id))?.id).toBe(skill.id);
      expect((await serviceFor(ownerId).readFile(companyId, skill.id, "SKILL.md"))?.content).toContain("Safe fixture content");
    }
    expect((await runtime(fixtureAgents[0]!, keys)).keys.filter(key => keys.includes(key))).toHaveLength(5);
    expect((await runtime(fixtureAgents[0]!)).keys.some(key => keys.includes(key))).toBe(false);
    for (const [index, peer] of peers.entries()) {
      expect(await serviceFor(peer.id).list(companyId)).toEqual(before[index]!.catalog);
      expect(await runtime(peer)).toEqual(before[index]!.runtime);
      expect(await runtime(peer, keys)).toEqual(before[index]!.runtime);
      for (const skill of fixtures) {
        expect(await serviceFor(peer.id).getById(companyId, skill.id)).toBeNull();
        expect(await serviceFor(peer.id).getByKey(companyId, skill.key)).toBeNull();
        expect(await serviceFor(peer.id).readFile(companyId, skill.id, "SKILL.md")).toBeNull();
        await expect(readAssignedSkill({ skills: [] } as never, { skill: skill.key, path: "SKILL.md", offset: 0 }))
          .rejects.toThrow("runner_skill_not_assigned");
      }
      const [current] = await db.select({ permissions: agents.permissions }).from(agents).where(eq(agents.id, peer.id));
      expect(current!.permissions).toEqual(before[index]!.permissions);
    }
    const changed = fixtures[0]!;
    await db.update(companySkills).set({ recipientAgentId: peers[0]!.id }).where(eq(companySkills.id, changed.id));
    const stale = await serviceFor(ownerId).listRuntimeSkillEntries(companyId, {
      onlyKeys: new Set([changed.key]), versionSelections: new Map([[changed.key, changed.currentVersionId]]),
    });
    expect(stale).toEqual([]);
    expect(await serviceFor(ownerId).readFile(companyId, changed.id, "SKILL.md")).toBeNull();
    await db.update(companySkills).set({ recipientAgentId: ownerId }).where(eq(companySkills.id, changed.id));
    await expect(db.delete(agents).where(eq(agents.id, ownerId))).rejects.toThrow();
    const foreignCompany = randomUUID();
    await db.insert(companies).values({ id: foreignCompany, name: "Foreign fixture", issuePrefix: `RF${foreignCompany.slice(0, 6)}` });
    const [foreign] = await db.insert(agents).values({ companyId: foreignCompany, name: "Foreign recipient" }).returning();
    await expect(db.update(companySkills).set({ recipientAgentId: foreign!.id }).where(eq(companySkills.id, changed.id))).rejects.toThrow();
    expect(await companySkillService(db, { actor: { type: "agent", agentId: foreign!.id, companyId: foreignCompany } })
      .getById(companyId, changed.id)).toBeNull();
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, ownerId));
    expect(await serviceFor(ownerId).getById(companyId, changed.id)).toBeNull();
    const [retained] = await db.select({ recipient: companySkills.recipientAgentId }).from(companySkills).where(eq(companySkills.id, changed.id));
    expect(retained!.recipient).toBe(ownerId);
    console.info(JSON.stringify({ rehearsal: "recipient-boundary", targetSkills: 5, unchangedPeers: peers.length,
      paths: ["catalog", "known-id", "file", "runtime-content", "native-reader", "stale-pin", "deletion", "cross-company"],
      liveWrites: false }));
  }, 60_000);

  it("creates restricted skills atomically and preserves the recipient on forks", async () => {
    const [recipient] = await db.insert(agents).values({ companyId, name: "Recipient authoring fixture" }).returning();
    const board = companySkillService(db, { actor: { type: "board", source: "local_implicit" } });
    const skill = await board.createLocalSkill(companyId, { name: "marketing-loops", slug: "marketing-loops-authoring",
      markdown: "---\nname: marketing-loops\n---\nSafe authoring fixture.\n", recipientAgentId: recipient!.id });
    expect(skill.recipientAgentId).toBe(recipient!.id);
    const recipientService = companySkillService(db, { actor: { type: "agent", companyId, agentId: recipient!.id } });
    const fork = await recipientService.forkSkill(companyId, skill.id);
    expect(fork.skill.recipientAgentId).toBe(recipient!.id);
    expect(await companySkillService(db).getById(companyId, skill.id)).toBeNull();
    await expect(recipientService.updateSkill(companyId, skill.id, { recipientAgentId: null })).rejects.toThrow("Only board");
    await expect(recipientService.createLocalSkill(companyId, { name: "signup", recipientAgentId: recipient!.id }))
      .rejects.toThrow("Only board");
    await expect(board.updateSkill(companyId, skill.id, { recipientAgentId: randomUUID() }))
      .rejects.toThrow("Recipient must be an active agent in this company");
    await expect(recipientService.forkSkill(companyId, skill.id, { sharingScope: "public_link" })).rejects.toThrow("Recipient-restricted skills");
    await expect(board.createLocalSkill(companyId, { name: "signup", recipientAgentId: recipient!.id, sharingScope: "public_link" }))
      .rejects.toThrow("Recipient-restricted skills");
    await expect(board.createLocalSkill(companyId, { name: "signup", forkedFromSkillId: skill.id, recipientAgentId: null }))
      .rejects.toThrow("A fork must retain");
    const old = await board.createLocalSkill(companyId, { name: "Unscoped fixture" });
    expect((await recipientService.getById(companyId, old.id))?.id).toBe(old.id);
    const restrictedCopy = await board.createLocalSkill(companyId, { name: "signup", slug: "signup-restricted-copy",
      forkedFromSkillId: old.id, recipientAgentId: recipient!.id });
    expect(restrictedCopy.recipientAgentId).toBe(recipient!.id);
    expect(await companySkillService(db).getById(companyId, restrictedCopy.id)).toBeNull();
    expect(await companySkillService(db).hasRecipientRestrictions(companyId)).toBe(true);
  });

  it("hides a restricted fork from original detail and fork-precheck responses", async () => {
    const [recipient, peer] = await db.insert(agents).values([
      { companyId, name: "Fork summary recipient" }, { companyId, name: "Fork summary peer" },
    ]).returning();
    const board = companySkillService(db, { actor: { type: "board", source: "local_implicit" } });
    const original = await board.createLocalSkill(companyId, { name: "signup", slug: "signup-original" });
    const { skill: fork } = await board.forkSkill(companyId, original.id);
    await board.updateSkill(companyId, fork.id, { recipientAgentId: recipient!.id });
    const peerService = companySkillService(db, { actor: { type: "agent", companyId, agentId: peer!.id } });
    expect((await peerService.detail(companyId, original.id))!.existingForks).toEqual([]);
    expect((await peerService.forkPrecheck(companyId, original.id))!.existingForks).toEqual([]);
    expect((await board.forkPrecheck(companyId, original.id))!.existingForks.map(item => item.id)).toContain(fork.id);
  });

});
