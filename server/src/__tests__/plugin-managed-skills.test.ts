import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companySkills,
  createDb,
  pluginManagedResources,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
      };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

function manifest(): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.managed-skills-test",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Managed Skills Test",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["skills.managed"],
    entrypoints: { worker: "./dist/worker.js" },
    skills: [{
      skillKey: "wiki-maintainer",
      displayName: "Wiki Maintainer Skill",
      description: "Use LLM Wiki tools to maintain company knowledge.",
      files: [{
        path: "references/wiki-style.md",
        content: "# Wiki style\n\nKeep pages cited and terse.\n",
      }],
    }],
  };
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin-managed skill tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin-managed skills", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-managed-skills-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(pluginManagedResources);
    await db.delete(companySkills);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndPlugin(pluginManifest = manifest()) {
    const companyId = randomUUID();
    const pluginId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: pluginManifest.id,
      packageName: "@paperclipai/plugin-managed-skills-test",
      version: pluginManifest.version,
      apiVersion: pluginManifest.apiVersion,
      categories: pluginManifest.categories,
      manifestJson: pluginManifest,
      status: "ready",
      installOrder: 1,
    });
    const services = buildHostServices(db, pluginId, pluginManifest.id, createEventBusStub(), undefined, {
      manifest: pluginManifest,
    });
    return { companyId, pluginId, pluginManifest, services };
  }

  it("installs and resolves managed company skills by stable resource key", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();

    const created = await services.skills.managedReconcile({
      companyId,
      skillKey: "wiki-maintainer",
    });

    expect(created.status).toBe("created");
    expect(created.skill).toMatchObject({
      name: "Wiki Maintainer Skill",
      key: "plugin/paperclip-managed-skills-test/wiki-maintainer",
      sourceType: "catalog",
      fileInventory: expect.arrayContaining([
        expect.objectContaining({ path: "SKILL.md", kind: "skill" }),
        expect.objectContaining({ path: "references/wiki-style.md", kind: "reference" }),
      ]),
    });

    const resolved = await services.skills.managedGet({
      companyId,
      skillKey: "wiki-maintainer",
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.skillId).toBe(created.skillId);

    const [binding] = await db.select().from(pluginManagedResources);
    expect(binding).toMatchObject({
      companyId,
      resourceKind: "skill",
      resourceKey: "wiki-maintainer",
      resourceId: created.skillId,
    });
  });

  it("preserves operator edits during reconcile and restores manifest defaults on reset", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const created = await services.skills.managedReconcile({ companyId, skillKey: "wiki-maintainer" });
    expect(created.skillId).toBeTruthy();

    await db
      .update(companySkills)
      .set({
        name: "Custom Wiki Skill",
        markdown: "# Custom instructions\n",
        updatedAt: new Date(),
      })
      .where(eq(companySkills.id, created.skillId!));

    const reconciled = await services.skills.managedReconcile({ companyId, skillKey: "wiki-maintainer" });
    expect(reconciled.status).toBe("resolved");
    expect(reconciled.skill).toMatchObject({
      name: "Custom Wiki Skill",
      markdown: "# Custom instructions\n",
    });

    const reset = await services.skills.managedReset({ companyId, skillKey: "wiki-maintainer" });
    expect(reset.status).toBe("reset");
    expect(reset.skill).toMatchObject({
      name: "Wiki Maintainer Skill",
      description: "Use LLM Wiki tools to maintain company knowledge.",
    });
    expect(reset.skill?.markdown).toContain("key: \"plugin/paperclip-managed-skills-test/wiki-maintainer\"");
  });

  it("does not rewrite managed skill bindings when defaults are unchanged", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const created = await services.skills.managedReconcile({ companyId, skillKey: "wiki-maintainer" });
    expect(created.skillId).toBeTruthy();

    const [binding] = await db.select().from(pluginManagedResources);
    const oldUpdatedAt = new Date("2026-01-01T00:00:00.000Z");
    await db
      .update(pluginManagedResources)
      .set({ updatedAt: oldUpdatedAt })
      .where(eq(pluginManagedResources.id, binding.id));

    const reconciled = await services.skills.managedReconcile({ companyId, skillKey: "wiki-maintainer" });
    const [bindingAfter] = await db.select().from(pluginManagedResources);

    expect(reconciled.status).toBe("resolved");
    expect(bindingAfter.updatedAt.toISOString()).toBe(oldUpdatedAt.toISOString());
  });

  it("relinks an existing canonical skill without overwriting operator edits", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const created = await services.skills.managedReconcile({ companyId, skillKey: "wiki-maintainer" });
    expect(created.skillId).toBeTruthy();

    await db.delete(pluginManagedResources).where(eq(pluginManagedResources.resourceId, created.skillId!));
    await db
      .update(companySkills)
      .set({
        name: "Existing Customized Wiki Skill",
        markdown: "# Existing customized instructions\n",
        updatedAt: new Date(),
      })
      .where(eq(companySkills.id, created.skillId!));

    const relinked = await services.skills.managedReconcile({ companyId, skillKey: "wiki-maintainer" });

    expect(relinked.status).toBe("relinked");
    expect(relinked.skillId).toBe(created.skillId);
    expect(relinked.skill).toMatchObject({
      name: "Existing Customized Wiki Skill",
      markdown: "# Existing customized instructions\n",
    });
    expect(relinked.defaultDrift).toEqual({ changedFiles: ["SKILL.md"] });

    const [binding] = await db.select().from(pluginManagedResources);
    expect(binding).toMatchObject({
      companyId,
      resourceKind: "skill",
      resourceKey: "wiki-maintainer",
      resourceId: created.skillId,
    });
  });

  it("reports drift when installed skill files differ from plugin defaults", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const created = await services.skills.managedReconcile({ companyId, skillKey: "wiki-maintainer" });
    expect(created.defaultDrift).toBeNull();

    await db
      .update(companySkills)
      .set({
        markdown: "# Custom instructions\n",
        updatedAt: new Date(),
      })
      .where(eq(companySkills.id, created.skillId!));

    const drifted = await services.skills.managedReconcile({ companyId, skillKey: "wiki-maintainer" });
    expect(drifted.status).toBe("resolved");
    expect(drifted.defaultDrift).toEqual({ changedFiles: ["SKILL.md"] });

    const reset = await services.skills.managedReset({ companyId, skillKey: "wiki-maintainer" });
    expect(reset.defaultDrift).toBeNull();
  });

  it("adds the canonical managed key to manifest-provided markdown skills", async () => {
    const pluginManifest = manifest();
    pluginManifest.skills = [
      ...(pluginManifest.skills ?? []),
      {
        skillKey: "markdown-skill",
        displayName: "Markdown Skill",
        markdown: [
          "---",
          "name: markdown-skill",
          "description: Markdown source without a key.",
          "---",
          "",
          "# Markdown Skill",
          "",
          "Follow the managed markdown.",
        ].join("\n"),
      },
    ];
    const { companyId, services } = await seedCompanyAndPlugin(pluginManifest);

    const created = await services.skills.managedReconcile({ companyId, skillKey: "markdown-skill" });

    expect(created.status).toBe("created");
    expect(created.skill).toMatchObject({
      key: "plugin/paperclip-managed-skills-test/markdown-skill",
      name: "markdown-skill",
    });
    expect(created.skill?.markdown).toContain("key: \"plugin/paperclip-managed-skills-test/markdown-skill\"");
  });
});
