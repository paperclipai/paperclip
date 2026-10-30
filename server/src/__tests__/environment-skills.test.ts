import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { agents, companies, companySkills, createDb, environments, pluginCompanySettings, plugins, resourceLifecycleEvents, type Db } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { environmentSkillConfig } from "../services/environment-skills.js";
import { pluginAgentRuntimeState } from "../services/plugin-agent-runtime-state.js";
import { companySkillService } from "../services/company-skills.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { withSkillActor } from "../services/skill-access.js";
import { buildNativeRuntimeContext } from "../services/native-runtime/runtime-context.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
describeDatabase("environment managed skills", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;
  let companyId: string;
  let pluginId: string;
  let manifest: PaperclipPluginManifestV1;
  let environment: { driver: string; config: Record<string, unknown> };
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-environment-skills-"); db = createDb(database.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-environment-skills-"));
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); if (home) {
    const release = async (directory: string): Promise<void> => {
      await fs.chmod(directory, 0o700);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await release(path.join(directory, entry.name));
    };
    await release(home); await fs.rm(home, { recursive: true, force: true });
  } });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_HOME", home);
    companyId = randomUUID(); pluginId = randomUUID();
    manifest = { id: `fixture.${pluginId}`, apiVersion: 1, version: "1.0.0", displayName: "Desktop", description: "Fixture", author: "Tests", categories: ["automation"],
      capabilities: ["environment.drivers.register", "skills.managed", "agents.lifecycle.manage", "events.subscribe"],
      resourceLifecycle: ["agent_runtime"], entrypoints: { worker: "worker.js" },
      environmentDrivers: [{ driverKey: "desktop", displayName: "Desktop", skillKeys: ["computer-use"], configSchema: {} }],
      skills: [{ skillKey: "computer-use", displayName: "Computer use", slug: "computer-use",
        markdown: "---\nname: computer-use\ndescription: Use the installed desktop tools.\n---\n\nRead references/linux.md.",
        files: [{ path: "references/linux.md", content: "Use the installed cua-driver." }] }] };
    await db.insert(companies).values({ id: companyId, name: "Environment skills", issuePrefix: `E${companyId.slice(0, 6)}` });
    await db.insert(plugins).values({ id: pluginId, pluginKey: manifest.id, packageName: "fixture", version: "1.0.0", status: "ready", manifestJson: manifest });
    environment = { driver: "plugin", config: { pluginKey: manifest.id, driverKey: "desktop", driverConfig: {} } };
  });
  it("installs the company skill and delivers its versioned files through runtime sync and the native snapshot", async () => {
    const config = { paperclipSkillSync: { desiredSkills: [] } };
    const [selection, concurrent] = await Promise.all([environmentSkillConfig(db, companyId, environment, config), environmentSkillConfig(db, companyId, environment, config)]);
    expect(concurrent).toEqual(selection);
    const selected = selection.config;
    const [skill] = await db.select().from(companySkills).where(and(eq(companySkills.companyId, companyId), eq(companySkills.key, `plugin/fixture-${pluginId}/computer-use`)));
    expect(selected).toMatchObject({ paperclipSkillSync: { desiredSkills: [skill.key] } });
    expect(config.paperclipSkillSync.desiredSkills).toEqual([]);
    const [env] = await db.insert(environments).values({ name: "Desktop", ...environment }).returning();
    const [agent] = await db.insert(agents).values({ companyId, name: "Worker", adapterType: "paperclip_runner", defaultEnvironmentId: env.id,
      lifecycleRequiredPluginIds: [pluginId], adapterConfig: config }).returning();
    const state = await pluginAgentRuntimeState(db, pluginId, companyId, agent.id);
    expect(state!.skills).toEqual([expect.objectContaining({ key: skill.key, runtimeName: expect.stringMatching(/^plugin-.*-computer-use--/), versionId: expect.any(String) })]);
    await withSkillActor({ type: "agent", agentId: agent.id, companyId, source: "agent_key" }, async () => {
      await companySkillService(db).withRuntimeSkillEntries(companyId, { selectionConfig: selected, snapshotLatest: true }, async entries => {
        const context = await buildNativeRuntimeContext({ db, agent, runId: randomUUID(), runtimeConfig: selected, runtimeSkillEntries: entries });
        expect(context.skills).toEqual([expect.objectContaining({ key: skill.key, runtimeName: state!.skills[0].runtimeName, versionId: state!.skills[0].versionId })]);
        expect(await fs.readFile(path.join(context.skills[0].bundle.rootPath, "references/linux.md"), "utf8")).toContain("cua-driver");
      });
    });
    await db.update(agents).set({ defaultEnvironmentId: null }).where(eq(agents.id, agent.id));
    await instanceSettingsService(db).update({ defaultEnvironmentId: env.id });
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, agent.id))!.skills).toEqual(state!.skills);
    await instanceSettingsService(db).update({ defaultEnvironmentId: null });
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, agent.id))!.skills).toEqual([]);
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, agent.id, env.id))!.skills).toEqual(state!.skills);
    await expect(pluginAgentRuntimeState(db, pluginId, companyId, agent.id, randomUUID())).rejects.toMatchObject({ status: 422 });
    const invalidSkill = { skillKey: "new-invalid", displayName: "New invalid skill", markdown: "---\nname: new-invalid\nmetadata:\n  sources:\n    - kind: github-dir\n      repo: fixture/skills\n---\nUnpinned." };
    const changedManifest = { ...manifest, skills: [...manifest.skills!, invalidSkill], environmentDrivers: manifest.environmentDrivers!.map(driver => ({ ...driver, skillKeys: [...driver.skillKeys!, "new-invalid"] })) };
    await db.update(plugins).set({ manifestJson: changedManifest }).where(eq(plugins.id, pluginId));
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, agent.id, env.id))!.skills).toEqual(state!.skills);
    await expect(environmentSkillConfig(db, companyId, environment, config)).rejects.toThrow(/pinned Git commit/);
    await db.update(plugins).set({ manifestJson: manifest }).where(eq(plugins.id, pluginId));
    const pinned = { paperclipSkillSync: { desiredSkills: [{ key: skill.key, versionId: state!.skills[0].versionId }] } };
    expect((await environmentSkillConfig(db, companyId, environment, pinned)).config).toEqual(pinned);
    await db.update(companySkills).set({ markdown: "Agent customization" }).where(eq(companySkills.id, skill.id));
    await environmentSkillConfig(db, companyId, environment, config);
    expect((await db.select().from(companySkills).where(eq(companySkills.id, skill.id)))[0].markdown).toBe("Agent customization");
  });
  it("installs and refreshes environment skills through lifecycle reconciliation before any run", async () => {
    const [env] = await db.insert(environments).values({ name: randomUUID(), ...environment }).returning();
    const [agent] = await db.insert(agents).values({ companyId, name: "Background worker", adapterType: "paperclip_runner", defaultEnvironmentId: env.id,
      lifecycleRequiredPluginIds: [pluginId], adapterConfig: { paperclipSkillSync: { desiredSkills: [] } } }).returning();
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, agent.id))!.skills).toEqual([]);
    const states = await Promise.all([1, 2].map(() => pluginAgentRuntimeState(db, pluginId, companyId, agent.id, undefined, true)));
    expect(states[0]!.skills).toEqual(states[1]!.skills);
    const [skill] = await db.select().from(companySkills).where(and(eq(companySkills.companyId, companyId), eq(companySkills.key, `plugin/fixture-${pluginId}/computer-use`)));
    expect(skill.slug).toMatch(/^plugin-.*-computer-use$/);
    const runtime = states[0]!.skills[0];
    expect(await fs.readFile(path.join(runtime.source, "SKILL.md"), "utf8")).toContain(`name: "${skill.slug}"`);
    const events = () => db.select().from(resourceLifecycleEvents).where(and(eq(resourceLifecycleEvents.companyId, companyId), eq(resourceLifecycleEvents.resourceType, "agent_runtime")));
    const before = (await events()).length;
    const edited = skill.markdown + "\nCompany edit.";
    await fs.chmod(path.join(skill.sourceLocator!, "SKILL.md"), 0o600);
    await fs.writeFile(path.join(skill.sourceLocator!, "SKILL.md"), edited);
    await db.update(companySkills).set({ markdown: edited }).where(eq(companySkills.id, skill.id));
    expect((await events()).slice(before).map(event => event.resourceId)).toEqual([agent.id]);
    const refreshed = (await pluginAgentRuntimeState(db, pluginId, companyId, agent.id, undefined, true))!.skills[0];
    expect(refreshed.versionId).not.toBe(runtime.versionId);
    expect(await fs.readFile(path.join(refreshed.source, "SKILL.md"), "utf8")).toContain("Company edit.");
    const settled = (await events()).length;
    await pluginAgentRuntimeState(db, pluginId, companyId, agent.id, undefined, true);
    expect(await events()).toHaveLength(settled);
    const changedManifest = { ...manifest, skills: [...manifest.skills!, { skillKey: "extra", displayName: "Extra" }],
      environmentDrivers: manifest.environmentDrivers!.map(driver => ({ ...driver, skillKeys: [...driver.skillKeys!, "extra"] })) };
    await db.update(plugins).set({ manifestJson: changedManifest }).where(eq(plugins.id, pluginId));
    expect((await events()).slice(settled).map(event => event.resourceId)).toEqual([agent.id]);
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, agent.id, undefined, true))!.skills).toHaveLength(2);
    const saved = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(saved[0].adapterConfig).toEqual(agent.adapterConfig);
    await db.delete(companySkills).where(eq(companySkills.id, skill.id));
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, agent.id, undefined, true))!.skills).toHaveLength(2);
  });
  it("queues background delivery for inherited defaults and changed environment requirements", async () => {
    const [env] = await db.insert(environments).values({ name: randomUUID(), ...environment }).returning();
    const [agent] = await db.insert(agents).values({ companyId, name: "Inherited worker", adapterType: "paperclip_runner", lifecycleRequiredPluginIds: [pluginId] }).returning();
    const events = () => db.select().from(resourceLifecycleEvents).where(and(eq(resourceLifecycleEvents.companyId, companyId), eq(resourceLifecycleEvents.resourceType, "agent_runtime")));
    let before = (await events()).length;
    await instanceSettingsService(db).update({ defaultEnvironmentId: env.id });
    expect((await events()).slice(before).map(event => event.resourceId)).toEqual([agent.id]);
    await pluginAgentRuntimeState(db, pluginId, companyId, agent.id, undefined, true);
    before = (await events()).length;
    const [settings] = await db.insert(pluginCompanySettings).values({ companyId, pluginId, enabled: true }).returning();
    for (let change = 0; change < 3; change++) {
      await db.update(pluginCompanySettings).set({ settingsJson: { localFolders: { path: `fixture-${change}` } } }).where(eq(pluginCompanySettings.id, settings.id));
    }
    expect(await events()).toHaveLength(before);
    await db.update(pluginCompanySettings).set({ enabled: false }).where(eq(pluginCompanySettings.id, settings.id));
    expect((await events()).slice(before).map(event => event.resourceId)).toEqual([agent.id]);
    await db.update(pluginCompanySettings).set({ enabled: true }).where(eq(pluginCompanySettings.id, settings.id));
    expect((await events()).slice(before).map(event => event.resourceId)).toEqual([agent.id, agent.id]);
    before = (await events()).length;
    await db.delete(pluginCompanySettings).where(eq(pluginCompanySettings.id, settings.id));
    expect(await events()).toHaveLength(before);
    await expect(db.transaction(async tx => {
      await tx.update(environments).set({ config: { ...environment.config, driverKey: "unrelated" } }).where(eq(environments.id, env.id));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await events()).toHaveLength(before);
    await db.update(environments).set({ config: { ...environment.config, driverKey: "unrelated" } }).where(eq(environments.id, env.id));
    expect((await events()).slice(before).map(event => event.resourceId)).toEqual([agent.id]);
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, agent.id, undefined, true))!.skills).toEqual([]);
    before = (await events()).length;
    await instanceSettingsService(db).update({ defaultEnvironmentId: null });
    expect((await events()).slice(before).map(event => event.resourceId)).toEqual([agent.id]);
  });
  it("delivers the required plugin skill and reports a same-name company assignment as shadowed", async () => {
    const name = `plugin-${pluginId}-computer-use`;
    const original = await companySkillService(db).createLocalSkill(companyId, { name, markdown: `---\nname: ${name}\n---\nCompany instructions.\n` });
    const config = { paperclipSkillSync: { desiredSkills: [original.key] } };
    const [env] = await db.insert(environments).values({ name: randomUUID(), ...environment }).returning();
    const [agent] = await db.insert(agents).values({ companyId, name: "Conflicting worker", adapterType: "paperclip_runner", defaultEnvironmentId: env.id,
      lifecycleRequiredPluginIds: [pluginId], adapterConfig: config }).returning();
    const state = await pluginAgentRuntimeState(db, pluginId, companyId, agent.id, undefined, true);
    const key = `plugin/fixture-${pluginId}/computer-use`;
    expect(state!.skills.map(skill => skill.key)).toEqual([key]);
    expect(state!.shadowedSkills).toEqual([{ key: original.key, shadowedBy: key }]);
    for (const reference of [name, original.key.toUpperCase(), `${name}--${createHash("sha256").update(original.key).digest("hex").slice(0, 10)}`]) {
      const aliased = await environmentSkillConfig(db, companyId, environment, { paperclipSkillSync: { desiredSkills: [reference] } });
      expect(aliased.config).toMatchObject({ paperclipSkillSync: { desiredSkills: [key] } });
      expect(aliased.shadowedSkills).toEqual(state!.shadowedSkills);
    }
    expect((await db.select().from(companySkills).where(eq(companySkills.id, original.id)))[0]).toMatchObject({ markdown: original.markdown, slug: original.slug });
    expect((await db.select().from(agents).where(eq(agents.id, agent.id)))[0].adapterConfig).toEqual(config);
    await db.update(agents).set({ defaultEnvironmentId: null }).where(eq(agents.id, agent.id));
    const restored = await pluginAgentRuntimeState(db, pluginId, companyId, agent.id, undefined, true);
    expect(restored!.skills.map(skill => skill.key)).toEqual([original.key]);
    expect(restored!.shadowedSkills).toBeUndefined();
  });
  it("keeps installations company-scoped and rejects disabled providers", async () => {
    const peerId = randomUUID();
    await db.insert(companies).values({ id: peerId, name: "Peer", issuePrefix: `P${peerId.slice(0, 6)}` });
    await environmentSkillConfig(db, companyId, environment, {});
    await environmentSkillConfig(db, peerId, environment, {});
    const peerSkills = await db.select().from(companySkills).where(and(eq(companySkills.companyId, peerId), eq(companySkills.key, `plugin/fixture-${pluginId}/computer-use`)));
    expect(peerSkills).toHaveLength(1);
    const skills = await db.select().from(companySkills).where(and(eq(companySkills.companyId, companyId), eq(companySkills.key, `plugin/fixture-${pluginId}/computer-use`)));
    expect(peerSkills[0].id).not.toBe(skills[0].id);
    await db.insert(pluginCompanySettings).values({ companyId, pluginId, enabled: false });
    await expect(environmentSkillConfig(db, companyId, environment, {})).rejects.toMatchObject({ status: 422 });
    expect(await environmentSkillConfig(db, companyId, { driver: "local", config: null }, {})).toEqual({ config: {}, skillKeys: [] });
    expect(await environmentSkillConfig(db, companyId, { ...environment, config: { ...environment.config, driverKey: "unrelated" } }, {})).toEqual({ config: {}, skillKeys: [] });
  });
});
