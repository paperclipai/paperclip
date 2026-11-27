import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AssistantTool, AssistantTurn } from "./public-mcp-model.js";
import type { RunnerApi } from "./api.js";
import { isReadOnlyMcpCall } from "./public-mcp-grading.js";
import { origin } from "./public-mcp-client.js";

/** Independent public-API/file oracles; the model never grades its own changes. */
export async function runExpandedMcpScenario(input: {
  id: string; api: RunnerApi; companyId: string; taskId: string; title: string; marker: string; nonce: string;
  secrets: string[];
  converse: (prompt: string, host?: { tools: AssistantTool[]; call(name: string, args: Record<string, unknown>): Promise<unknown> }) => Promise<AssistantTurn>;
  check(id: string, passed: boolean, detail: string): void;
}) {
  const { api, check, converse, nonce, taskId, companyId, title, marker } = input;
  const taskPath = `/api/issues/${taskId}`;
  const match = (id: string, passed: boolean) => check(id, passed, "Independent persisted API state or downloaded byte digest.");
  if (input.id === "expanded-task-edit") {
    const previous = new Set((await api.get<any[]>(taskPath + "/activity?limit=100")).map(row => row.id));
    await converse(`Update the existing task "${title}": description must be exactly "Edited ${nonce}" and priority high. Then block it with the board owning the action "Supply source ${nonce}". Finally mark it done. Do not add comments, change its title, or create tasks.`);
    const task = await api.get<any>(taskPath);
    const history = await api.get<any[]>(taskPath + "/activity?limit=100");
    match("edited-task", task.description === `Edited ${nonce}` && task.priority === "high" && task.status === "done");
    match("blocked-before-finished", hasRequestedTaskEditSequence(history.filter(row => !previous.has(row.id)), nonce));
  } else if (input.id === "expanded-documents") {
    await converse(`Read the report document on "${title}" and append a new paragraph containing exactly "DOCUMENT${nonce}". Preserve all original content and use its current revision to update it. Do not change task status or add comments.`);
    const document = await api.get<any>(taskPath + "/documents/report");
    match("document-written", document.body.includes(`DOCUMENT${nonce}`) && document.body.includes(marker));
    const later = await converse(`This is a later conversation. Retrieve the report for "${title}" and quote both its original garden reference and its DOCUMENT reference. Do not write anything.`);
    match("later-document-retrieval", hasReadLaterDocument(later, companyId, taskId, marker, `DOCUMENT${nonce}`));
    const revisions = await api.get<any[]>(taskPath + "/documents/report/revisions");
    match("document-history", revisions.length >= 2);
  } else if (input.id === "expanded-files") {
    const directory = await mkdtemp(join(tmpdir(), "public-mcp-transfer-eval-"));
    const path = join(directory, "demo.mp4");
    // Small binary fixture exercises transport byte fidelity, not video decoding.
    const bytes = Buffer.concat([Buffer.from([0, 255, 1, 128]), Buffer.from(`BINARY${nonce}`)]);
    await writeFile(path, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    let downloadDigest = "";
    const tool: AssistantTool = { name: "host_transfer_file", description: "Transfer the local fixture demo.mp4 using a Paperclip upload or download URL. upload sends the existing local bytes; download saves the response locally and returns its SHA-256. URLs must come from the authorized Paperclip transfer tools.", inputSchema: { type: "object", additionalProperties: false, properties: { direction: { type: "string", enum: ["upload", "download"] }, url: { type: "string" } }, required: ["direction", "url"] } };
    try {
      await converse(`Attach the local file demo.mp4 to "${title}", then download that attachment to verify it. Its content type is video/mp4, byte size ${bytes.length}, and SHA-256 ${digest}. Use host_transfer_file for the actual byte transfers. Do not put URLs or temporary credentials in your final answer. Do not create another task.`, {
        tools: [tool],
        call: async (name, args) => {
          if (name !== tool.name || !["upload", "download"].includes(String(args.direction))) throw new Error("Unknown host transfer operation");
          const url = new URL(String(args.url));
          if (url.origin !== origin || url.pathname !== `/mcp/files/${args.direction}` || !url.searchParams.get("ticket")) throw new Error("Transfer destination is outside the bound Paperclip resource");
          input.secrets.push(url.searchParams.get("ticket")!, url.toString());
          const response = await fetch(url, args.direction === "upload" ? { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: await readFile(path), redirect: "error" } : { redirect: "error" });
          if (!response.ok) return { error: "Transfer failed", status: response.status };
          if (args.direction === "upload") return response.json();
          const saved = Buffer.from(await response.arrayBuffer());
          await writeFile(join(directory, "download.mp4"), saved);
          downloadDigest = createHash("sha256").update(await readFile(join(directory, "download.mp4"))).digest("hex");
          return { saved: "download.mp4", byteSize: saved.length, sha256: downloadDigest };
        },
      });
      const attachments = await api.get<any[]>(taskPath + "/attachments");
      match("one-uploaded-attachment", attachments.filter(v => v.originalFilename === "demo.mp4" && v.byteSize === bytes.length).length === 1);
      match("binary-download-fidelity", downloadDigest === digest);
    } finally { await rm(directory, { recursive: true, force: true }); }
  } else if (["expanded-agent-config", "expanded-permissions"].includes(input.id)) {
    const agent = await api.post<any>(`/api/companies/${companyId}/agents`, { name: `Settings agent ${nonce}`, adapterType: "codex_local", runtimeConfig: { heartbeat: { enabled: false } }, instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": "Original operating instructions." } } });
    if (input.id === "expanded-permissions") {
      const answer = await converse(`Set the title of agent "${agent.name}" to "Forbidden ${nonce}". If the connection lacks configuration permission, explain how I can grant it; do not work around the permission or change other work.`);
      const saved = await api.get<any>(`/api/agents/${agent.id}`);
      match("configuration-denied", saved.title !== `Forbidden ${nonce}` && /permission|consent|configur|reconnect/i.test(answer.final));
    } else {
      await converse(`For agent "${agent.name}", set title to "Editor ${nonce}" and monthly budget to 1200 cents. Read its AGENTS.md instructions, then append "INSTRUCTIONS${nonce}" preserving the original text and using the current revision. Do not start, pause, hire or change credentials for any agent.`);
      const saved = await api.get<any>(`/api/agents/${agent.id}`);
      const instructions = await api.get<any>(`/api/agents/${agent.id}/instructions-bundle/file?path=AGENTS.md`);
      match("agent-configured", saved.title === `Editor ${nonce}` && saved.budgetMonthlyCents === 1200);
      match("instructions-persisted", instructions.content?.includes(`INSTRUCTIONS${nonce}`) && instructions.content?.includes("Original operating instructions."));
    }
  } else if (input.id === "expanded-projects") {
    await converse(`Create exactly one Paperclip project named "Project ${nonce}" with description "Initial project". Inspect repository choices; if none are available leave repositories empty. Then update this project's description to exactly "Updated project ${nonce}". Do not create remote repositories or tasks.`);
    const projects = await api.get<any[]>(`/api/companies/${companyId}/projects`);
    const matching = projects.filter(p => p.name === `Project ${nonce}`);
    match("project-created-updated-once", matching.length === 1 && matching[0].description === `Updated project ${nonce}`);
  } else if (input.id === "expanded-skills") {
    await converse(`Create exactly one organization skill named "Eval skill ${nonce}" with instructions to review source citations. Then read its current version and SKILL.md and append the exact line "SKILL${nonce}" using a version-checked file update. Update its metadata tagline to "Citations ${nonce}". Do not publish it publicly or install remote code.`);
    const skills = await api.get<any[]>(`/api/companies/${companyId}/skills`);
    const found = skills.filter(s => s.name === `Eval skill ${nonce}`);
    match("skill-created-once", found.length === 1);
    if (found.length === 1) {
      const file = await api.get<any>(`/api/companies/${companyId}/skills/${found[0].id}/files?path=SKILL.md`);
      match("skill-file-written", file.content.includes(`SKILL${nonce}`));
      match("skill-metadata-updated", found[0].tagline === `Citations ${nonce}` && found[0].sharingScope !== "public_link");
    }
  } else if (input.id === "expanded-api") {
    const answer = await converse(`Using paperclip_search_api and paperclip_call_api, find the existing task "${title}" and set its description to exactly "API${nonce}". Discover the operation schemas, keep the company explicit, and do not create tasks, alter status or use a non-Paperclip URL.`);
    const saved = await api.get<any>(taskPath);
    match("generic-api-durable-edit", saved.description === `API${nonce}`);
    match("generic-api-used", answer.calls.some(c => c.name === "paperclip_search_api") && answer.calls.some(c => c.name === "paperclip_call_api"));
  } else throw new Error("Unknown expanded MCP evaluation case");
}

/** Ignore older worker activity; require this user's ordered edit/block/finish trail. */
export function hasRequestedTaskEditSequence(history: any[], nonce: string): boolean {
  const changes = history.filter(row => row.action === "issue.updated" && row.actorType === "user")
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const statusChanges = changes.filter(row => row.details?.status !== undefined);
  if (statusChanges.length !== 2 || statusChanges[0].details.status !== "blocked" || statusChanges[1].details.status !== "done") return false;
  const blocked = statusChanges[0];
  if (blocked.details.unblockDescriptor?.owner !== "board" || blocked.details.unblockDescriptor?.action !== `Supply source ${nonce}`) return false;
  const edit = changes.find(row => row.details?.description === `Edited ${nonce}` && row.details?.priority === "high");
  return Boolean(edit && new Date(edit.createdAt).getTime() < new Date(blocked.createdAt).getTime()
    && new Date(blocked.createdAt).getTime() < new Date(statusChanges[1].createdAt).getTime());
}

/** Require successful retrieval in this conversation, not a remembered quotation. */
export function hasReadLaterDocument(turn: AssistantTurn, companyId: string, taskId: string, ...references: string[]): boolean {
  if (!references.every(value => value && turn.final.includes(value)) || !turn.calls.every(isReadOnlyMcpCall)) return false;
  return turn.calls.some(call => {
    const name = call.name === "paperclip_call_api" ? call.arguments.operationId : call.name;
    const args = call.name === "paperclip_call_api" ? call.arguments.arguments as Record<string, unknown> | undefined : call.arguments;
    if (!args || args.companyId !== companyId || args.taskId !== taskId
      || !["paperclip_read_document", "paperclip_list_deliverables"].includes(String(name))) return false;
    const result = call.result as { isError?: boolean; structuredContent?: Record<string, unknown> } | null;
    if (!result || result.isError || !result.structuredContent) return false;
    const documents = name === "paperclip_list_deliverables" ? result.structuredContent.documents : [result.structuredContent.document];
    return Array.isArray(documents) && documents.some(doc => doc && doc.key === "report"
      && typeof doc.body === "string" && references.every(value => doc.body.includes(value)));
  });
}
