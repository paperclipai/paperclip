// Upload a skill folder from your local machine into a Paperclip company.
//
// Usage:
//   cd server && pnpm exec tsx scripts/upload-skill.mjs <skill-dir> <companyId> [--update]
//
// Env:
//   PAPERCLIP_URL    target instance (default http://localhost:3100)
//   PAPERCLIP_TOKEN  board API key for authenticated instances (Bearer)
//
// The folder must contain SKILL.md (frontmatter name/description). All other
// text files are uploaded alongside it. --update re-uploads files into an
// existing skill with the same slug instead of failing on conflict.
import fs from "node:fs/promises";
import path from "node:path";

const [dirArg, companyId] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const update = process.argv.includes("--update");
if (!dirArg || !companyId) {
  console.error("Usage: tsx scripts/upload-skill.mjs <skill-dir> <companyId> [--update]");
  process.exit(1);
}

const BASE = (process.env.PAPERCLIP_URL ?? "http://localhost:3100").replace(/\/$/, "");
const headers = { "content-type": "application/json" };
if (process.env.PAPERCLIP_TOKEN) headers.authorization = `Bearer ${process.env.PAPERCLIP_TOKEN}`;

const skillDir = path.resolve(dirArg);
const slug = path.basename(skillDir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
const skillMd = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8").catch(() => null);
if (!skillMd) {
  console.error(`No SKILL.md in ${skillDir}`);
  process.exit(1);
}
const name = skillMd.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? slug;

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv"]);
async function collectFiles(dir, prefix = "") {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(path.join(dir, entry.name), rel)));
    } else if (entry.isFile() && rel !== "SKILL.md") {
      const bytes = await fs.readFile(path.join(dir, entry.name));
      // ponytail: text files only; binary assets need a storage-backed upload path
      if (bytes.includes(0)) {
        console.log(`skip (binary): ${rel}`);
        continue;
      }
      if (bytes.length > 1_000_000) {
        console.log(`skip (>1MB): ${rel}`);
        continue;
      }
      out.push({ path: rel, content: bytes.toString("utf8") });
    }
  }
  return out;
}

async function api(method, url, body) {
  const res = await fetch(`${BASE}/api${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const files = await collectFiles(skillDir);

// Create, or find existing on --update.
let skillId;
const created = await api("POST", `/companies/${companyId}/skills`, { name, slug, markdown: skillMd });
if (created.status === 201) {
  skillId = created.json.id;
  console.log(`created skill "${name}" (${slug})`);
} else if (created.status === 409 && update) {
  const list = await api("GET", `/companies/${companyId}/skills`);
  const existing = (list.json.skills ?? list.json ?? []).find?.((s) => s.slug === slug);
  if (!existing) {
    console.error(`409 on create but no existing skill with slug "${slug}" found`);
    process.exit(1);
  }
  skillId = existing.id;
  const md = await api("PATCH", `/companies/${companyId}/skills/${skillId}/files`, { path: "SKILL.md", content: skillMd });
  if (md.status !== 200) {
    console.error(`failed to update SKILL.md: ${md.status} ${JSON.stringify(md.json)}`);
    process.exit(1);
  }
  console.log(`updating existing skill "${name}" (${slug})`);
} else {
  console.error(`create failed: ${created.status} ${JSON.stringify(created.json)}`);
  process.exit(1);
}

for (const file of files) {
  const res = await api("PATCH", `/companies/${companyId}/skills/${skillId}/files`, file);
  if (res.status !== 200) {
    console.error(`upload failed for ${file.path}: ${res.status} ${JSON.stringify(res.json)}`);
    process.exit(1);
  }
  console.log(`uploaded: ${file.path}`);
}

console.log(`done — ${1 + files.length} file(s) in skill ${skillId}`);
