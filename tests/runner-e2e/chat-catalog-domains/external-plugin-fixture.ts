import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mirrorPreviewSdk } from "./external-plugin-sdk-mirror.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { PaperclipPluginManifestV1 } from "../../../packages/shared/src/types/plugin.js";

export function previewFixtureManifest(key: string): PaperclipPluginManifestV1 {
  return { id: key, apiVersion: 1, version: "0.1.0", displayName: "Website Preview Eval", description: "Disposable synthetic website preview fixture", author: "Paperclip evaluation fixture", categories: ["ui", "automation"],
    capabilities: ["api.routes.register", "agent.tools.register", "jobs.schedule", "secrets.read-ref"], entrypoints: { worker: "./dist/worker.js" },
    instanceConfigSchema: { type: "object", properties: { apiKey: { type: "string", title: "Preview credential", format: "secret-ref" } }, required: ["apiKey"], additionalProperties: false },
    jobs: [{ jobKey: "preview-refresh", displayName: "Preview refresh", description: "Synthetic annual refresh; no external service", schedule: "0 0 1 1 *" }],
    apiRoutes: [{ routeKey: "preview", method: "GET", path: "/preview", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } }],
    tools: [{ name: "preview", displayName: "Preview website", description: "Read the current synthetic website preview", parametersSchema: { type: "object", properties: {}, additionalProperties: false } }],
  };
}
/** CLI scaffolding and package admission run during the selected attempt.
 * The explicit offline calibration exercises scaffolding without admission. */
export async function createPreviewFixture(ctx: ChatCatalogContext) {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-preview-eval-")));
  const packageRoot = path.join(temporary, "website-preview");
  const cli = fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url));
  const loader = fileURLToPath(new URL("../../../cli/node_modules/tsx/dist/loader.mjs", import.meta.url));
  const sdkUrl = new URL("../../../packages/plugins/sdk/dist/index.js", import.meta.url).href;
  try {
    const mirror = await mirrorPreviewSdk(fileURLToPath(new URL("../../../packages/plugins/sdk/", import.meta.url)), temporary);
    await promisify(execFile)(process.execPath, ["--import", loader, cli, "plugin", "init", "@paperclip-eval/website-preview", "--output", temporary, "--display-name", "Website Preview Eval", "--sdk-path", mirror.sdkPath], { cwd: temporary, timeout: 30_000, maxBuffer: 256_000, env: { HOME: temporary, PATH: process.env.PATH ?? "", NODE_ENV: "test", DO_NOT_TRACK: "1", PAPERCLIP_TELEMETRY_DISABLED: "1" } });
    const key = `paperclip.eval-preview-${ctx.input.nonce.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
    const manifest = previewFixtureManifest(key);
    const marker = `Synthetic website preview ${ctx.input.nonce}`;
    const manifestSource = `export default ${JSON.stringify(manifest)};\n`;
    const workerSource = `import {definePlugin,runWorker} from ${JSON.stringify(sdkUrl)};
let configured=false;
const plugin=definePlugin({
 async setup(ctx){ctx.jobs.register('preview-refresh',async()=>{});ctx.tools.register('preview',{displayName:'Preview website',description:'Read the synthetic preview',parametersSchema:{type:'object',properties:{},additionalProperties:false}},async()=>({content:${JSON.stringify(marker)}}));},
 async onConfigChanged(config){configured=typeof config.apiKey==='string'&&config.apiKey.length>0;},
 async onValidateConfig(config){return {valid:typeof config.apiKey==='string'&&config.apiKey.length>0,message:'Choose the preview credential securely.'};},
 async onHealth(){return {status:configured?'ok':'degraded',message:configured?'Synthetic preview configured':'Preview credential is missing'};},
 async onApiRequest(input){return {body:{companyId:input.companyId,marker:${JSON.stringify(marker)},configured}};}
});export default plugin;runWorker(plugin,import.meta.url);\n`;
    await mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@paperclip-eval/website-preview", version: "0.1.0", type: "module", private: true, paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" } }));
    await writeFile(path.join(packageRoot, "dist/manifest.js"), manifestSource); await writeFile(path.join(packageRoot, "dist/worker.js"), workerSource);
    const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
    await ctx.input.evidence("chat-catalog-vetted-preview-package.json", { synthetic: true, cliMode: "supported-source-cli-tsx", cliLoaderSha256: digest(await readFile(loader)), pluginKey: key, sdkMirror: { files: mirror.files, archiveWrites: mirror.archiveWrites, packageBuilds: mirror.packageBuilds, packagePacks: mirror.packagePacks }, manifestSha256: digest(manifestSource), workerSha256: digest(workerSource), cliSha256: digest(await readFile(cli)), sdkEntrySha256: digest(await readFile(fileURLToPath(sdkUrl))) });
    return { key, packageRoot, marker, async close() { await rm(temporary, { recursive: true, force: true }); } };
  } catch { await rm(temporary, { recursive: true, force: true }); throw new Error("Disposable plugin scaffold failed; command output withheld"); }
}
