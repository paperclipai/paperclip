/**
 * Sync obra/superpowers (or SUPER_GITHUB_REPO) into the Superpowers plugin `plugin_state`
 * and assign every synced skill to every active agent.
 *
 * There is no board UI for “assign all skills to all agents”; use this script after the
 * plugin is installed and `ready`.
 *
 * Production (copy into container, run from /app/server for module resolution):
 *
 *   docker cp scripts/superpowers-bulk-assign-all.mjs paperclip-server-1:/tmp/superpowers-bulk-assign-all.mjs
 *   docker exec -u node -w /app/server -e DATABASE_URL \
 *     -e PAPERCLIP_SUPERPLUGIN_ID='<plugins.id for superpowers>' \
 *     paperclip-server-1 \
 *     node --import ./node_modules/tsx/dist/loader.mjs /tmp/superpowers-bulk-assign-all.mjs
 *
 * Optional:
 *   -e PAPERCLIP_COMPANY_ID='<uuid>'   # only agents in this company (default: all companies)
 *   -e SUPER_GITHUB_REPO='obra/superpowers'   # default
 */
import { createDb, pluginState, agents } from "@paperclipai/db";
import { and, eq, notInArray } from "drizzle-orm";

const SKILL_CATEGORIES = {
  process: ["brainstorming", "writing-plans", "executing-plans", "dispatching-parallel-agents"],
  implementation: ["test-driven-development", "subagent-driven-development", "using-git-worktrees"],
  review: [
    "requesting-code-review",
    "receiving-code-review",
    "verification-before-completion",
    "finishing-a-development-branch",
  ],
  debugging: ["systematic-debugging"],
  meta: ["using-superpowers", "writing-skills"],
};

function categoryForSkill(skillId) {
  for (const [cat, ids] of Object.entries(SKILL_CATEGORIES)) {
    if (ids.includes(skillId)) return cat;
  }
  return "other";
}

function parseSimpleYaml(text) {
  const result = {};
  for (const line of text.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

function parseSkillFile(raw, skillId) {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const frontmatter = fmMatch[1];
  const body = fmMatch[2].trim();
  const fm = parseSimpleYaml(frontmatter);
  if (!fm.name) return null;
  return {
    id: skillId,
    name: fm.name,
    description: fm.description ?? "",
    category: categoryForSkill(skillId),
    content: body,
    companionFiles: {},
    updatedAt: new Date().toISOString(),
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

async function syncSkillsFromGitHub(repo) {
  const data = await fetchJson(`https://api.github.com/repos/${repo}/git/trees/main?recursive=1`);
  const tree = data.tree ?? [];
  const skillDirs = new Map();
  for (const item of tree) {
    if (item.type !== "blob") continue;
    const parts = item.path.split("/");
    if (parts[0] !== "skills" || parts.length < 3) continue;
    const skillName = parts[1];
    if (!skillDirs.has(skillName)) skillDirs.set(skillName, []);
    skillDirs.get(skillName).push(item);
  }

  const newIndex = [];
  const skills = [];
  for (const [skillName, files] of skillDirs) {
    const skillFile = files.find((f) => f.path.endsWith("/SKILL.md"));
    if (!skillFile) continue;
    const raw = await fetchText(`https://raw.githubusercontent.com/${repo}/main/${skillFile.path}`);
    const skill = parseSkillFile(raw, skillName);
    if (!skill) continue;

    const companions = {};
    const companionFiles = files.filter(
      (f) =>
        f.path !== skillFile.path &&
        f.path.endsWith(".md") &&
        f.path.split("/").length === 3,
    );
    for (const cf of companionFiles) {
      try {
        const content = await fetchText(`https://raw.githubusercontent.com/${repo}/main/${cf.path}`);
        const filename = cf.path.split("/").pop();
        companions[filename] = content;
      } catch {
        /* skip */
      }
    }
    skill.companionFiles = companions;
    skills.push(skill);
    newIndex.push(skill.id);
  }

  return { skills, newIndex };
}

async function upsertPluginState(db, row) {
  await db
    .insert(pluginState)
    .values({
      pluginId: row.pluginId,
      scopeKind: row.scopeKind,
      scopeId: row.scopeId,
      namespace: row.namespace ?? "default",
      stateKey: row.stateKey,
      valueJson: row.valueJson,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        pluginState.pluginId,
        pluginState.scopeKind,
        pluginState.scopeId,
        pluginState.namespace,
        pluginState.stateKey,
      ],
      set: {
        valueJson: row.valueJson,
        updatedAt: new Date(),
      },
    });
}

const pluginId = process.env.PAPERCLIP_SUPERPLUGIN_ID?.trim();
const companyIdFilter = process.env.PAPERCLIP_COMPANY_ID?.trim();
const repo = process.env.SUPER_GITHUB_REPO?.trim() || "obra/superpowers";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
if (!pluginId) {
  console.error("PAPERCLIP_SUPERPLUGIN_ID is required (plugins.id for key superpowers)");
  process.exit(1);
}

const db = createDb(process.env.DATABASE_URL);

console.log(`Syncing skills from ${repo} …`);
const { skills, newIndex } = await syncSkillsFromGitHub(repo);
if (skills.length === 0) {
  console.error("No skills parsed from GitHub; aborting.");
  process.exit(1);
}

for (const skill of skills) {
  await upsertPluginState(db, {
    pluginId,
    scopeKind: "instance",
    scopeId: null,
    stateKey: `skill:${skill.id}`,
    valueJson: skill,
  });
}

await upsertPluginState(db, {
  pluginId,
  scopeKind: "instance",
  scopeId: null,
  stateKey: "skill-index",
  valueJson: newIndex,
});

console.log(`Upserted ${skills.length} skills and skill-index (${newIndex.length} ids).`);

const agentConditions = [
  notInArray(agents.status, ["terminated", "pending_approval"]),
];
if (companyIdFilter) {
  agentConditions.push(eq(agents.companyId, companyIdFilter));
}

const agentRows = await db
  .select({ id: agents.id })
  .from(agents)
  .where(and(...agentConditions));

const assignedAt = new Date().toISOString();
let n = 0;
for (const { id: agentId } of agentRows) {
  await upsertPluginState(db, {
    pluginId,
    scopeKind: "agent",
    scopeId: agentId,
    stateKey: "skill-assignments",
    valueJson: {
      agentId,
      skillIds: [...newIndex],
      assignedAt,
    },
  });
  n += 1;
}

console.log(JSON.stringify({ ok: true, skills: skills.length, agentsAssigned: n, companyFilter: companyIdFilter || null }));
process.exit(0);
