import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  pluginManagedResources,
} from "@paperclipai/db";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import type {
  CompanySkill,
  PaperclipPluginManifestV1,
  PluginManagedSkillDeclaration,
  PluginManagedSkillResolution,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { companySkillService } from "./company-skills.js";

const MANAGED_SKILL_RESOURCE_KIND = "skill";

interface PluginManagedSkillServiceOptions {
  pluginId: string;
  pluginKey: string;
  manifest?: PaperclipPluginManifestV1 | null;
}

function pluginKeySlug(pluginKey: string) {
  return normalizeAgentUrlKey(pluginKey) ?? "plugin";
}

function canonicalSkillKey(pluginKey: string, skillKey: string) {
  return `plugin/${pluginKeySlug(pluginKey)}/${skillKey}`;
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function buildDefaultMarkdown(
  pluginKey: string,
  declaration: PluginManagedSkillDeclaration,
) {
  const description = declaration.description?.trim() || `${declaration.displayName} plugin skill.`;
  return [
    "---",
    `name: ${yamlString(declaration.displayName)}`,
    `description: ${yamlString(description)}`,
    `key: ${yamlString(canonicalSkillKey(pluginKey, declaration.skillKey))}`,
    "---",
    "",
    `# ${declaration.displayName}`,
    "",
    description,
    "",
  ].join("\n");
}

function withManagedSkillKey(markdown: string, canonicalKey: string) {
  const keyLine = `key: ${yamlString(canonicalKey)}`;
  const normalized = markdown.replace(/\r\n/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---(\n?)/.exec(normalized);
  if (!frontmatter) {
    return [
      "---",
      keyLine,
      "---",
      "",
      normalized,
    ].join("\n");
  }

  const currentBody = frontmatter[1] ?? "";
  const nextBody = /^key\s*:/m.test(currentBody)
    ? currentBody.replace(/^key\s*:.*$/m, keyLine)
    : [currentBody, keyLine].filter(Boolean).join("\n");
  return `---\n${nextBody}\n---${frontmatter[2] ?? ""}${normalized.slice(frontmatter[0].length)}`;
}

function buildPackageFiles(
  pluginKey: string,
  declaration: PluginManagedSkillDeclaration,
) {
  const root = declaration.skillKey;
  const canonicalKey = canonicalSkillKey(pluginKey, declaration.skillKey);
  const files: Record<string, string> = {
    [`${root}/SKILL.md`]: declaration.markdown?.trim()
      ? withManagedSkillKey(declaration.markdown, canonicalKey)
      : buildDefaultMarkdown(pluginKey, declaration),
  };
  for (const file of declaration.files ?? []) {
    files[`${root}/${file.path}`] = file.content;
  }
  return files;
}

function buildDeclaredSkillFiles(
  pluginKey: string,
  declaration: PluginManagedSkillDeclaration,
) {
  const packageFiles = buildPackageFiles(pluginKey, declaration);
  const root = declaration.skillKey;
  const prefix = `${root}/`;
  const files: Record<string, string> = {};
  for (const [filePath, content] of Object.entries(packageFiles)) {
    files[filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath] = content;
  }
  return files;
}

function buildSkillDefaults(
  pluginKey: string,
  declaration: PluginManagedSkillDeclaration,
) {
  return {
    skillKey: declaration.skillKey,
    displayName: declaration.displayName,
    slug: declaration.slug ?? declaration.skillKey,
    description: declaration.description ?? null,
    canonicalKey: canonicalSkillKey(pluginKey, declaration.skillKey),
    files: [
      "SKILL.md",
      ...(declaration.files ?? []).map((file) => file.path),
    ],
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function resolution(
  pluginKey: string,
  companyId: string,
  declaration: PluginManagedSkillDeclaration,
  skill: CompanySkill | null,
  status: PluginManagedSkillResolution["status"],
  defaultDrift: PluginManagedSkillResolution["defaultDrift"] = null,
): PluginManagedSkillResolution {
  return {
    pluginKey,
    resourceKind: "skill",
    resourceKey: declaration.skillKey,
    companyId,
    skillId: skill?.id ?? null,
    skill,
    status,
    defaultDrift,
  };
}

export function pluginManagedSkillService(
  db: Db,
  options: PluginManagedSkillServiceOptions,
) {
  const skills = companySkillService(db);

  function declarationFor(skillKey: string) {
    const declaration = options.manifest?.skills?.find((skill) => skill.skillKey === skillKey);
    if (!declaration) {
      throw notFound(`Managed skill declaration not found: ${skillKey}`);
    }
    return declaration;
  }

  async function getBinding(companyId: string, skillKey: string) {
    return db
      .select()
      .from(pluginManagedResources)
      .where(and(
        eq(pluginManagedResources.companyId, companyId),
        eq(pluginManagedResources.pluginId, options.pluginId),
        eq(pluginManagedResources.resourceKind, MANAGED_SKILL_RESOURCE_KIND),
        eq(pluginManagedResources.resourceKey, skillKey),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function upsertBinding(
    companyId: string,
    declaration: PluginManagedSkillDeclaration,
    skillId: string,
  ) {
    const defaultsJson = buildSkillDefaults(options.pluginKey, declaration);
    const existing = await getBinding(companyId, declaration.skillKey);
    if (existing) {
      if (
        existing.resourceId === skillId &&
        stableJson(existing.defaultsJson) === stableJson(defaultsJson)
      ) {
        return existing;
      }
      return db
        .update(pluginManagedResources)
        .set({
          resourceId: skillId,
          defaultsJson,
          updatedAt: new Date(),
        })
        .where(eq(pluginManagedResources.id, existing.id))
        .returning()
        .then((rows) => rows[0]);
    }
    return db
      .insert(pluginManagedResources)
      .values({
        companyId,
        pluginId: options.pluginId,
        pluginKey: options.pluginKey,
        resourceKind: MANAGED_SKILL_RESOURCE_KIND,
        resourceKey: declaration.skillKey,
        resourceId: skillId,
        defaultsJson,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function getSkill(companyId: string, skillId: string) {
    return skills.getById(companyId, skillId);
  }

  async function managedSkillDefaultDrift(
    companyId: string,
    skill: CompanySkill | null,
    declaration: PluginManagedSkillDeclaration,
  ): Promise<PluginManagedSkillResolution["defaultDrift"]> {
    if (!skill) return null;
    const declaredFiles = buildDeclaredSkillFiles(options.pluginKey, declaration);
    const currentFiles: Record<string, string | null> = {};
    const paths = new Set([
      ...Object.keys(declaredFiles),
      ...skill.fileInventory.map((entry) => entry.path),
    ]);

    for (const filePath of paths) {
      if (filePath === "SKILL.md") {
        currentFiles[filePath] = skill.markdown;
        continue;
      }
      try {
        currentFiles[filePath] = (await skills.readFile(companyId, skill.id, filePath))?.content ?? null;
      } catch {
        currentFiles[filePath] = null;
      }
    }

    const changedFiles = [...paths]
      .filter((filePath) => (currentFiles[filePath] ?? null) !== (declaredFiles[filePath] ?? null))
      .sort((left, right) => left.localeCompare(right));
    return changedFiles.length > 0 ? { changedFiles } : null;
  }

  async function resolvedSkill(
    companyId: string,
    declaration: PluginManagedSkillDeclaration,
    skill: CompanySkill | null,
    status: PluginManagedSkillResolution["status"],
  ) {
    return resolution(
      options.pluginKey,
      companyId,
      declaration,
      skill,
      status,
      await managedSkillDefaultDrift(companyId, skill, declaration),
    );
  }

  async function importDeclaredSkill(
    companyId: string,
    declaration: PluginManagedSkillDeclaration,
    mode: "reconcile" | "reset",
  ) {
    const beforeByKey = mode === "reconcile"
      ? await skills.getByKey(companyId, canonicalSkillKey(options.pluginKey, declaration.skillKey))
      : null;
    if (beforeByKey) {
      await upsertBinding(companyId, declaration, beforeByKey.id);
      return { skill: beforeByKey, status: "relinked" as const };
    }
    const results = await skills.importPackageFiles(
      companyId,
      buildPackageFiles(options.pluginKey, declaration),
      { onConflict: "replace" },
    );
    const imported = results.find((result) =>
      result.skill.key === canonicalSkillKey(options.pluginKey, declaration.skillKey)
      || result.originalSlug === (declaration.slug ?? declaration.skillKey)
      || result.originalSlug === declaration.skillKey
    )?.skill ?? results[0]?.skill ?? null;
    if (!imported) {
      throw notFound(`Managed skill was not imported: ${declaration.skillKey}`);
    }
    await upsertBinding(companyId, declaration, imported.id);
    const status: PluginManagedSkillResolution["status"] = mode === "reset" ? "reset" : "created";
    return { skill: imported, status };
  }

  async function get(skillKey: string, companyId: string) {
    const declaration = declarationFor(skillKey);
    const binding = await getBinding(companyId, skillKey);
    if (!binding) return resolvedSkill(companyId, declaration, null, "missing");
    const skill = await getSkill(companyId, binding.resourceId);
    return resolvedSkill(companyId, declaration, skill, skill ? "resolved" : "missing");
  }

  async function reconcile(skillKey: string, companyId: string) {
    const declaration = declarationFor(skillKey);
    const current = await get(skillKey, companyId);
    if (current.skill) {
      await upsertBinding(companyId, declaration, current.skill.id);
      return current;
    }
    const imported = await importDeclaredSkill(companyId, declaration, "reconcile");
    await logActivity(db, {
      companyId,
      actorType: "plugin",
      actorId: options.pluginId,
      action: "plugin.managed_skill.reconciled",
      entityType: "company_skill",
      entityId: imported.skill.id,
      details: {
        sourcePluginKey: options.pluginKey,
        managedResourceKey: declaration.skillKey,
        status: imported.status,
      },
    });
    return resolvedSkill(companyId, declaration, imported.skill, imported.status);
  }

  async function reset(skillKey: string, companyId: string) {
    const declaration = declarationFor(skillKey);
    const imported = await importDeclaredSkill(companyId, declaration, "reset");
    await logActivity(db, {
      companyId,
      actorType: "plugin",
      actorId: options.pluginId,
      action: "plugin.managed_skill.reset",
      entityType: "company_skill",
      entityId: imported.skill.id,
      details: {
        sourcePluginKey: options.pluginKey,
        managedResourceKey: declaration.skillKey,
      },
    });
    return resolvedSkill(companyId, declaration, imported.skill, "reset");
  }

  return {
    get,
    reconcile,
    reset,
  };
}
