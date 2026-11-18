import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runAdapterExecutionTargetShellCommand } from "@paperclipai/adapter-utils/execution-target";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";

const program = `
const fs = require('fs'), path = require('path');
const [operation, assets, cwd, encoded] = process.argv.slice(1);
const created = [];
const cleanup = entries => { for (const entry of [...entries].reverse()) {
  const file = path.resolve(cwd, entry.path);
  if (!file.startsWith(path.resolve(cwd) + path.sep) || !entry.path.startsWith('.claude')) throw Error('Invalid runtime asset path');
  try {
   for (const relative of ['.claude', '.claude/skills']) {
    const parent = path.join(cwd, relative);
    if (file.startsWith(parent + path.sep) && fs.lstatSync(parent).isSymbolicLink()) throw Error('Unsafe runtime asset parent');
   }
   if (entry.kind === 'skill') fs.rmSync(file, {recursive:true, force:true}); else fs.rmdirSync(file);
  }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
} };
if (operation === 'cleanup') { cleanup(JSON.parse(encoded)); process.exit(0); }
try {
 const source = path.join(assets, '.claude', 'skills');
 if (fs.existsSync(source)) {
  for (const relative of ['.claude', '.claude/skills']) {
   const target = path.join(cwd, relative);
   if (fs.existsSync(target)) { const st = fs.lstatSync(target); if (st.isSymbolicLink() || !st.isDirectory()) throw Error('Unsafe Grok skills directory'); }
   else { fs.mkdirSync(target); created.push({path:relative,kind:'directory'}); }
  }
  for (const name of fs.readdirSync(source)) {
   if (path.basename(name) !== name) throw Error('Invalid skill name');
   const relative = path.join('.claude', 'skills', name), target = path.join(cwd, relative);
   if (fs.existsSync(target)) continue;
   fs.mkdirSync(target);
   created.push({path:relative,kind:'skill'});
   fs.cpSync(path.join(source,name),target,{recursive:true,force:false,errorOnExist:true});
  }
 }
 const rules = fs.existsSync(path.join(assets,'Agents.md')) ? path.join(assets,'Agents.md')
  : !fs.existsSync(path.join(cwd,'Agents.md')) && fs.existsSync(path.join(cwd,'AGENTS.md')) ? path.join(cwd,'AGENTS.md') : null;
 console.log(JSON.stringify({created,rules}));
} catch (error) { cleanup(created); throw error; }
`;

export async function prepareGrokRemoteProjectAssets(input: {
  runId: string; target: AdapterExecutionTarget; cwd: string; assets: string;
}): Promise<{ rulesFilePath: string | null; cleanup: () => Promise<void> }> {
  const execute = async (operation: string, entries: unknown[]) => {
    const result = await runAdapterExecutionTargetShellCommand(input.runId, input.target,
      ["node", "-e", program, operation, input.assets, input.cwd, JSON.stringify(entries)].map(shellQuote).join(" "),
      { cwd: input.cwd, env: {}, timeoutSec: 15 });
    if (result.exitCode !== 0 || result.timedOut || result.signal) throw new Error("Could not prepare Grok SSH runtime assets");
    return result.stdout;
  };
  const result = JSON.parse(await execute("stage", [])) as { created: Array<{ path: string; kind: string }>; rules: string | null };
  if (!Array.isArray(result.created) || result.created.some(entry => !entry || typeof entry !== "object" || typeof entry.path !== "string" || (entry.kind === "directory" ? ![".claude", ".claude/skills"].includes(entry.path)
    : entry.kind !== "skill" || !/^\.claude\/skills\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.path)))) throw new Error("Invalid Grok SSH runtime asset receipt");
  const allowedRules = [input.assets + "/Agents.md", input.cwd + "/AGENTS.md"];
  if (result.rules !== null && !allowedRules.includes(result.rules)) throw new Error("Invalid Grok SSH instructions path");
  return { rulesFilePath: result.rules, cleanup: async () => { await execute("cleanup", result.created); } };
}
