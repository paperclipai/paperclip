#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { featureIndex } from "./feature-map.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), "..");
const fields = ["API", "Agent access", "Policy", "Evidence", "Verification", "Gaps"];
const values = {
  Review: ["baseline", "operation-reviewed"],
  API: ["present", "missing", "not-applicable", "unreviewed"],
  "Agent access": ["available", "partial", "missing", "restricted", "operator-only", "not-applicable", "unreviewed"],
  Evidence: ["source-only", "verified", "failed", "blocked", "not-run"],
  Verification: ["passed", "failed", "blocked", "not-run"],
};

function withoutExamples(text) {
  return text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
}

function sections(text, level) {
  const pattern = new RegExp("^" + "#".repeat(level) + " `([^`]+)`[^\\n]*$", "gm");
  const matches = [...text.matchAll(pattern)];
  return matches.map((match, index) => ({
    id: match[1],
    body: text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length),
  }));
}

export function checkMaps(repoRoot = defaultRoot) {
  const errors = [];
  const featureRoot = path.join(repoRoot, "maps/feature-map");
  const agentRoot = path.join(repoRoot, "maps/agent-access-map");
  const fail = (file, message) => errors.push(`${path.relative(repoRoot, file)}: ${message}`);
  function read(file) {
    if (!existsSync(file)) { fail(file, "missing file"); return ""; }
    return withoutExamples(readFileSync(file, "utf8"));
  }
  function files(dir) {
    if (!existsSync(dir)) { fail(dir, "missing map directory"); return []; }
    return readdirSync(dir).filter((name) => name.endsWith(".md") && name !== "README.md").sort();
  }
  function unique(ids, file, label) {
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) fail(file, `duplicate ${label}: ${id}`);
      seen.add(id);
    }
  }
  function links(file, text) {
    for (const match of text.matchAll(/\]\(([^)\n]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, "");
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) continue;
      if (target.startsWith("/")) { fail(file, `use a relative map reference: ${target}`); continue; }
      let local;
      try { local = decodeURIComponent(target.split(/[?#]/, 1)[0]); }
      catch { fail(file, `invalid local reference: ${target}`); continue; }
      if (!existsSync(path.resolve(path.dirname(file), local))) fail(file, `broken local reference: ${target}`);
    }
  }
  function field(file, body, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = body.match(new RegExp(`^${escaped}:[ \\t]*(\\S[^\\n]*)$`, "m"));
    if (!match) { fail(file, `missing ${name} field`); return null; }
    if (!values[name]) return null;
    const state = match[1].match(/^`([^`]+)`/);
    if (!state || !values[name].includes(state[1])) { fail(file, `invalid ${name} state`); return null; }
    if (["not-applicable", "restricted", "operator-only"].includes(state[1]) && !match[1].slice(state[0].length).replace(/[\s—–:.-]/g, "")) {
      fail(file, `${name} ${state[1]} needs a reason or path`);
    }
    return state[1];
  }
  function accessRecord(file, body) {
    const states = Object.fromEntries(fields.map((name) => [name, field(file, body, name)]));
    if (states.Evidence === "verified" && states.Verification !== "passed") {
      fail(file, "verified evidence requires a passed verification record");
    }
    const api = body.split(/^API:/m)[1]?.split(/^(?:Agent access|Policy|Evidence|Verification|Gaps):/m)[0] ?? "";
    if (states.API === "present" && !/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/[^\s`]+/.test(api)) {
      fail(file, "present API needs an exact method/path example");
    }
  }

  const productFiles = files(featureRoot);
  const agentFiles = files(agentRoot);
  try { featureIndex(repoRoot); }
  catch (error) { errors.push(error.message); }
  let capabilities = 0;
  for (const name of new Set([...productFiles, ...agentFiles])) {
    const productFile = path.join(featureRoot, name);
    const agentFile = path.join(agentRoot, name);
    const product = read(productFile);
    const agent = read(agentFile);
    const subfeatures = product.split(/^## Sub-features\s*$/m)[1]?.split(/^## /m)[0] ?? "";
    const ids = [...subfeatures.matchAll(/^- `([^`]+)`:/gm)].map((match) => match[1]);
    if (!ids.length) fail(productFile, "missing stable sub-feature IDs");
    unique(ids, productFile, "capability");
    const entries = sections(agent, 2);
    unique(entries.map((entry) => entry.id), agentFile, "capability");
    for (const id of ids) if (!entries.some((entry) => entry.id === id)) fail(agentFile, `missing capability: ${id}`);
    for (const entry of entries) {
      if (!ids.includes(entry.id)) fail(agentFile, `orphan capability: ${entry.id}`);
      const review = field(agentFile, entry.body, "Review");
      if (review === "operation-reviewed") {
        const operations = sections(entry.body, 3);
        if (!operations.length) fail(agentFile, `operation-reviewed capability ${entry.id} has no operations`);
        unique(operations.map((operation) => operation.id), agentFile, "operation");
        for (const operation of operations) accessRecord(agentFile, operation.body);
      } else accessRecord(agentFile, entry.body);
    }
    if (!agent.includes(`](../feature-map/${name})`)) fail(agentFile, "missing matching product link");
    if (!product.includes(`](../agent-access-map/${name})`)) fail(productFile, "missing matching companion link");
    links(productFile, product);
    links(agentFile, agent);
    capabilities += ids.length;
  }
  for (const file of [path.join(repoRoot, "maps/README.md"), path.join(featureRoot, "README.md"), path.join(agentRoot, "README.md")]) links(file, read(file));
  return { errors, areas: productFiles.length, capabilities };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const result = checkMaps();
  for (const error of result.errors) console.error(error);
  if (result.errors.length) process.exitCode = 1;
  else console.log(`Maps aligned: ${result.areas} areas, ${result.capabilities} capability IDs; references and contract fields valid. Structural checks only.`);
}
