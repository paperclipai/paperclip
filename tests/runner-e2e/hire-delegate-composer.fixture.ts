import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

export const composerResources = {
  companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", leadId: "33333333-3333-4333-8333-333333333333",
  agentId: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222",
  campaignId: "journey-1-deadbeef",
};

export async function startHireComposerFixture() {
  const root = fileURLToPath(new URL("../../", import.meta.url)), ui = path.join(root, "ui");
  const require = createRequire(path.join(ui, "package.json"));
  const { createServer } = await import(require.resolve("vite"));
  const { default: react } = await import(require.resolve("@vitejs/plugin-react"));
  const cacheDir = await mkdtemp(path.join(tmpdir(), "hire-composer-vite-"));
  const saved = new Map<string, Array<{ id: string; body: string }>>();
  const entry = `import React from "react";
import {createRoot} from "react-dom/client";
import {TaskChatComposer} from "/src/components/task-chat/TaskChatComposer.tsx";
import {TaskChatPresentationProvider} from "/src/components/task-chat/presentation-mode.tsx";
import {buildMarkdownMentionOptions} from "/src/lib/company-members.ts";
const r=${JSON.stringify(composerResources)}, q=new URLSearchParams(location.search);
const agents=[{id:q.get("variant")==="wrong-agent"?"44444444-4444-4444-8444-444444444444":r.agentId,name:"Morgan Reviewer "+r.campaignId,status:"idle",icon:"code"}];
if(q.get("variant")==="duplicate")agents.push({...agents[0],id:"55555555-5555-4555-8555-555555555555"});
const projects=q.get("variant")==="missing-project"?[]:[{id:r.projectId,name:"Journey QA hire-delegate-reuse "+r.campaignId,color:"#336699"}];
const mentions=buildMarkdownMentionOptions({agents,projects});
createRoot(document.getElementById("root")).render(React.createElement(TaskChatPresentationProvider,{mode:q.get("mode")||"production"},React.createElement(TaskChatComposer,{workMode:"standard",conversationMode:true,mentions,onAdd:async body=>{const response=await fetch("/__saved/"+encodeURIComponent(q.get("case")),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({body})});if(!response.ok)throw Error("fixture_save_failed");}})));`;
  const server = await createServer({
    configFile: false, root: ui, cacheDir, logLevel: "error",
    plugins: [react(), {
      name: "hire-production-composer-fixture",
      resolveId(id: string) { if (id === "/__hire-entry.tsx") return "\0hire-entry.tsx"; },
      load(id: string) { if (id === "\0hire-entry.tsx") return entry; },
      configureServer(instance: any) {
        instance.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          const pathname = new URL(req.url ?? "/", "http://fixture.local").pathname;
          if (pathname === "/__hire.html") {
            res.setHeader("Content-Type", "text/html");
            res.end(await instance.transformIndexHtml(pathname, '<div id="root"></div><script type="module" src="/__hire-entry.tsx"></script>'));
          } else if (pathname.startsWith("/__saved/")) {
            const key = decodeURIComponent(pathname.slice("/__saved/".length));
            const rows = saved.get(key) ?? [];
            if (req.method === "POST") {
              let body = ""; for await (const chunk of req) body += chunk;
              rows.push({ id: String(rows.length + 1), body: JSON.parse(body).body }); saved.set(key, rows);
            }
            res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(rows));
          } else next();
        });
      },
    }],
    resolve: { alias: [
      { find: "@", replacement: path.join(ui, "src") },
      { find: /^@paperclipai\/shared$/, replacement: path.join(root, "packages/shared/src/index.ts") },
      { find: /^@paperclipai\/shared\/(.+)$/, replacement: path.join(root, "packages/shared/src/$1") },
      { find: "lexical", replacement: path.join(ui, "node_modules/lexical/dist/Lexical.mjs") },
    ] },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
  });
  await server.listen();
  return { url: server.resolvedUrls.local[0] as string, async close() { await server.close(); await rm(cacheDir, { recursive: true, force: true }); } };
}
