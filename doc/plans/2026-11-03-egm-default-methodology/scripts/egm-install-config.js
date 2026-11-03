#!/usr/bin/env node
/**
 * Instala la maquinaria EGM en un host (o en un HOME limpio) siguiendo el runbook:
 *   1) bundle oficial (adapters/opencode/install.py)
 *   2) config del host: los 7 revisores + egm primary QUE GENERA EL INSTALADOR,
 *      con el modelo del oro en el lane barato y el alcance de lectura ampliado
 *      (artefactos + checkouts) — sin pisar el bloque de permisos del bundle.
 *   3) provider propio `pool` (el merge de providers de Paperclip es shallow)
 *   4) la regla global en AGENTS.md (auto-cargada por OpenCode)
 *
 *   node egm-install-config.js --home <HOME> [--gateway <baseURL>] [--rule <archivo>]
 *
 * Idempotente.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const HOME = opt("--home", process.env.HOME);
const GATEWAY = opt("--gateway", process.env.EGM_GATEWAY || "http://litellm.tail86782b.ts.net:4000/v1");
const RULE = opt("--rule", process.env.EGM_RULE || "");
const REPO = opt("--repo", "https://github.com/google/elephant-goldfish-model");
const BUNDLE = path.join(HOME, "egm-opencode-v1");
const SRC = path.join(HOME, "egm-src");
const CONF_DIR = path.join(HOME, ".config", "opencode");
const CONF = path.join(CONF_DIR, "opencode.json");
const ARTIFACTS = opt("--artifacts", "/home/paperclip/egm-artifacts");
const PROJECTS = opt("--projects", "/home/paperclip/.paperclip/instances/default/projects");
const say = (...a) => console.log(...a);

if (!fs.existsSync(SRC)) {
  say("1) clonando", REPO);
  execFileSync("git", ["clone", "--depth", "1", REPO, SRC], { stdio: "ignore" });
}
say("   commit:", execFileSync("git", ["-C", SRC, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
if (!fs.existsSync(BUNDLE)) {
  say("2) instalando el bundle");
  execFileSync("python3", [path.join(SRC, "adapters/opencode/install.py"), BUNDLE], { stdio: "ignore" });
}
const gen = JSON.parse(fs.readFileSync(path.join(BUNDLE, "opencode.json"), "utf8"));
fs.mkdirSync(CONF_DIR, { recursive: true });
let cur = {};
try { cur = JSON.parse(fs.readFileSync(CONF, "utf8")); } catch {}

const out = {
  ...cur,
  $schema: "https://opencode.ai/config.json",
  autoupdate: false,                                   // el bundle es V1: no actualices OpenCode solo
  skills: { paths: [path.join(BUNDLE, "skills")] },
  provider: {
    ...(cur.provider || {}),
    pool: {
      npm: "@ai-sdk/openai-compatible",
      name: "Pool (LiteLLM)",
      options: { baseURL: GATEWAY, apiKey: "{env:LITELLM_MASTER_KEY}" },
      models: { clusty: { name: "pool con thinking" }, "clusty-nothink": { name: "pool sin thinking" } },
    },
  },
  small_model: "pool/clusty-nothink",
  agent: { ...(gen.agent || {}), ...(cur.agent || {}) },
};
// el oro: lane barato, lectura ampliada, sin escritura
for (const [name, a] of Object.entries(out.agent)) {
  if (name === "egm") continue;
  a.mode = a.mode || "subagent";
  a.model = "pool/clusty-nothink";
  const p = a.permission || (a.permission = {});
  p.read = { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow", "mcp:*": "deny" };
  p.glob = "allow"; p.grep = "deny"; p.edit = "deny"; p.write = "deny"; p.bash = "deny";
  p.external_directory = { "*": "deny", [`${BUNDLE}/bundle/**`]: "allow", [`${ARTIFACTS}/**`]: "allow", [`${PROJECTS}/**`]: "allow" };
}
delete out.default_agent;                             // el agente egm primary no puede secuestrar los runs
fs.writeFileSync(CONF, JSON.stringify(out, null, 2) + "\n");
say("3) config escrito:", CONF, `(${Object.keys(out.agent).length} agentes, oro en pool/clusty-nothink)`);

if (RULE && fs.existsSync(RULE)) {
  fs.copyFileSync(RULE, path.join(CONF_DIR, "AGENTS.md"));
  say("4) regla copiada:", path.join(CONF_DIR, "AGENTS.md"), `(${fs.statSync(path.join(CONF_DIR, "AGENTS.md")).size} bytes)`);
}
try { fs.mkdirSync(ARTIFACTS, { recursive: true }); fs.chmodSync(ARTIFACTS, 0o755); } catch {}
say("   artefactos:", ARTIFACTS);
say("5) verificando con opencode debug config");
const resolved = JSON.parse(execFileSync("opencode", ["debug", "config"], { encoding: "utf8", cwd: HOME, env: { ...process.env, HOME } }));
const reviewers = Object.keys(resolved.agent || {}).filter((n) => n !== "egm");
say("   agentes:", Object.keys(resolved.agent || {}).join(", "));
say("   oro:", reviewers.length, "revisores | modelo:", reviewers[0] && resolved.agent[reviewers[0]].model);
say("   external_directory del oro:", JSON.stringify(resolved.agent[reviewers[0]].permission.external_directory));
say("   default_agent:", resolved.default_agent ?? "(ausente, correcto)");
say("OK");
