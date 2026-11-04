/** Credential-free calibration of the measured selectors in a real browser.
 * Synthetic loopback HTML is deliberately not live Antigravity qualification. */
import { createServer } from "node:http";
import { captureAntigravityAgentDraft } from "./antigravity-journey-flow.js";
import { ANTIGRAVITY_JOURNEY_EXECUTION } from "./antigravity-journey-cases.js";
import type { AntigravityJourneyResources } from "./antigravity-journey-fixtures.js";
import { chromium, type Page } from "@playwright/test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertAntigravityCleanComposer, assertAntigravityFileActivity, assertAntigravityReady, assertAntigravityTaskDone, inspectAntigravityArtifact, openAntigravityAgentFromRoster, openAntigravityCreatedTask, selectAntigravityFromOrdinaryPicker } from "./antigravity-journey-ui.js";

const agent = "Antigravity QA synthetic", model = "gemini-3.8-flash-low";
const artifactId = "11111111-1111-4111-8111-111111111111", followupId = "22222222-2222-4222-8222-222222222222";
const artifactBytes = Buffer.from("A".repeat(60) + "\n");
const followupBytes = Buffer.concat([artifactBytes, Buffer.from("B".repeat(57) + "\n")]);
const fixtures: Record<string, string> = {
  "task-uuid": `<aside><a href="/ANT/issues/synthetic-issue-id">Created task</a><a hidden href="/ANT/issues/ANT-42">Hidden duplicate</a><a href="/ANT/issues/other-id">Other task</a></aside>`,
  "task-identifier": `<aside><a href="/ANT/issues/ANT-42">Created task</a><a href="/ANT/issues/ANT-41">Other task</a></aside>`,
  "task-duplicate": `<aside><a href="/ANT/issues/ANT-41">Other task first</a><a href="/ANT/issues/synthetic-issue-id">Created task</a><a href="/ANT/issues/ANT-42">Same task identifier</a></aside>`,
  "task-repeated": `<aside><a href="/ANT/issues/ANT-41">Other task first</a><a href="/ANT/issues/ANT-42">Recent task</a><a href="/ANT/issues/ANT-42">Project recent task</a></aside>`,
  "task-other-only": `<aside><a href="/ANT/issues/ANT-41">Other task</a></aside>`,
  "task-hidden": `<aside><a hidden href="/ANT/issues/ANT-42">Created task</a><a href="/ANT/issues/ANT-41">Other task</a></aside>`,
  "ANT/issues/synthetic-issue-id": `<main>Created task UUID</main>`,
  "ANT/issues/ANT-42": `<main>Created task identifier</main>`,
  dashboard: `<aside><a href="/roster">Agents</a><a href="/wrong-agent">An older agent</a></aside><nav aria-label="breadcrumb"><a href="/roster">Agents</a></nav><main>Ready confirmation after closing composer</main>`,
  roster: `<aside><a href="/roster">Agents</a><a href="/wrong-agent">${agent}</a></aside><main><div role="toolbar" aria-label="Agents controls"><input aria-label="Search agents"></div><a href="/wrong-agent"><span>${agent} older</span>Engineer idle</a><a href="/owned-agent"><span>${agent}</span>Engineer idle</a><a hidden href="/wrong-agent"><span>${agent}</span>Engineer idle</a></main>`,
  "owned-agent": `<main><h1>${agent}</h1></main>`,
  picker: `<div role="dialog" aria-labelledby="picker"><h2 id="picker">Choose an adapter</h2><label><input type="radio" name="adapter">Google Antigravity Candidate</label><details><summary>Advanced</summary><label><input type="radio" name="adapter">Other harness</label></details><button>Configure agent</button></div><div hidden><label><input type="radio">Google Antigravity Candidate</label></div>`,
  "advanced-only": `<div role="dialog" aria-labelledby="picker"><h2 id="picker">Choose an adapter</h2><details open><summary>Advanced</summary><label><input type="radio">Google Antigravity Candidate</label></details><button>Configure agent</button></div>`,
  ready: `<div hidden><h2>Finishing agent setup</h2><button disabled>Assign ${agent} a Task</button></div><h2>Your agent is ready</h2><button>Assign ${agent} a Task</button>`,
  "narrative-ready": `<p>The assistant says Your agent is ready.</p><h2>Finishing agent setup</h2><button disabled>Assign ${agent} a Task</button>`,
  done: `<div hidden data-testid="issue-detail-header"><button aria-label="Change status (current: Todo)">Todo</button></div><div data-testid="issue-detail-header"><button aria-label="Change status (current: Done)"><svg><title>Done</title></svg></button></div><div role="menu" hidden>Done</div><p>Earlier task: Todo</p>`,
  "done-scrolled": `<nav aria-label="breadcrumb"><span aria-current="page"><svg role="img" aria-label="Done"><title>Done</title></svg>Current task</span></nav><div id="thread" style="height:200px;overflow:auto"><div data-testid="issue-detail-header" style="height:1000px"><button aria-label="Change status (current: Done)">Done</button></div><div style="height:1000px">Restored latest messages and open file viewer</div></div><script>document.getElementById('thread').scrollTop=2000</script>`,
  "wrong-current-breadcrumb": `<nav aria-label="breadcrumb"><a><svg role="img" aria-label="Done"><title>Done</title></svg>Older task</a><span aria-current="page"><svg role="img" aria-label="Todo"><title>Todo</title></svg>Current task</span></nav><div data-testid="issue-detail-header"><button aria-label="Change status (current: Done)">Done</button></div>`,
  "hidden-breadcrumb-done": `<nav aria-label="breadcrumb"><span aria-current="page"><svg style="display:none" role="img" aria-label="Done"><title>Done</title></svg><svg role="img" aria-label="Todo"><title>Todo</title></svg>Current task</span></nav><div data-testid="issue-detail-header"><button aria-label="Change status (current: Done)">Done</button></div>`,
  "narrative-done": `<div data-testid="issue-detail-header"><button aria-label="Change status (current: Todo)"><svg><title>Done</title></svg></button></div><div hidden><button aria-label="Change status (current: Done)">Done</button></div><p>The task is Done</p>`,
  composer: `<div role="dialog" aria-labelledby="composer"><h2 id="composer">New task</h2><button aria-label="Select assignee">${agent}</button><button aria-label="Select model and effort"><span data-testid="task-chat-composer-model-label">${model}</span></button><div hidden data-testid="new-issue-paused-assignee-note">paused</div></div><div data-testid="new-issue-paused-assignee-note">unrelated paused agent</div>`,
  "paused-composer": `<div role="dialog" aria-labelledby="composer"><h2 id="composer">New task</h2><button aria-label="Select assignee">${agent}</button><button aria-label="Select model and effort"><span data-testid="task-chat-composer-model-label">${model}</span></button><div data-testid="new-issue-paused-assignee-note">paused</div></div>`,
  "wrong-model": `<div role="dialog" aria-labelledby="composer"><h2 id="composer">New task</h2><button aria-label="Select assignee">${agent}</button><button aria-label="Select model and effort"><span data-testid="task-chat-composer-model-label">gemini-3.8-flash-high</span></button><p>${model}</p></div>`,
};
export async function runAntigravityBrowserCalibration(page: Page) {
  // The activity calibration bundles the shipped adapter and React renderer.
  // No hand-authored activity markup can accidentally validate invented copy.
  const activityBundle = await build({ stdin: { loader: "tsx", resolveDir: path.resolve(import.meta.dirname, "../../ui"), contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { TaskChatRunnerActivityGroup } from './src/components/task-chat/TaskChatRunnerActivityGroup';
    import { buildTurnTimelineRows, transcriptToTaskChatItems } from './src/components/task-chat/transcript-adapter';
    const route = new URL(location.href).pathname.slice(1);
    const legacy = route.startsWith('legacy-'), scenario = route.replace(/^legacy-/, '');
    const target = scenario === 'wrong-target-activity' ? 'backup/antigravity-proof.txt' : 'antigravity-proof.txt';
    const event = (operation, status, executionId, name = 'client_' + operation + '_file') => ({
      kind: 'provider_activity', ts: '2026-10-29T00:00:00Z', family: 'tool_execution',
      eventType: status === 'running' ? 'tool.execution.started' : 'tool.execution.completed', status,
      title: 'Tool execution', summary: 'Native file operation',
      payload: { name, operation, target, status, executionId, transport: 'builtin' },
    });
    const entries = [event('edit', 'completed', 'edit'), event('read', 'completed', 'read'),
      event('execute', 'failed', 'finish', 'paperclip_paperclip_finish')];
    if (scenario === 'failed-read-activity') entries.unshift(event('read', 'failed', 'failed-read'));
    if (scenario === 'interrupted-edit-activity') entries.unshift(event('edit', 'interrupted', 'interrupted-edit'));
    if (scenario === 'running-read-activity') entries.unshift(event('read', 'running', 'running-read'));
    if (scenario === 'pending-read-activity') entries.unshift(event('read', 'pending', 'pending-read'));
    if (scenario === 'failed-renderer-activity') entries.unshift({ ...event('read', 'completed', 'failed-renderer'), status: 'failed' });
    if (scenario === 'interrupted-renderer-activity') entries.unshift({ ...event('edit', 'completed', 'interrupted-renderer'), status: 'interrupted' });
    if (scenario === 'write-activity') entries[0] = event('write', 'completed', 'write');
    const running = legacy && ['running-read-activity', 'pending-read-activity'].includes(scenario);
    const transcriptOf = values => legacy ? values.flatMap(entry => {
      const { operation, target, executionId } = entry.payload;
      const call = { kind: 'tool_call', ts: entry.ts, toolUseId: executionId,
        name: operation === 'read' ? 'Running client_view_file' : operation === 'edit' ? 'exec_command' : operation === 'write' ? 'write' : 'paperclip_paperclip_finish',
        input: { operation, target } };
      if (['interrupted', 'pending'].includes(entry.status)) return [call];
      return [call, { kind: 'tool_result', ts: entry.ts, toolUseId: executionId, isError: entry.status === 'failed',
        delta: entry.status === 'running', content: entry.status === 'failed' ? 'Operation rejected' : 'Synthetic actual tool result' }];
    }) : values;
    const phases = (values, runId, active = false) => buildTurnTimelineRows(
      transcriptToTaskChatItems(transcriptOf(values), { runId, agentName: 'Synthetic agent', running: active }), active,
    ).filter(item => item.kind === 'activity_phase');
    const runId = scenario === 'stale-first-only-activity' ? 'synthetic-run-old' : 'synthetic-run';
    const current = phases(entries, runId, running);
    const older = scenario === 'current-run-mixed-activity'
      ? phases([event('read', 'failed', 'old-read'), event('edit', 'failed', 'old-edit')], 'synthetic-run-old') : [];
    createRoot(document.getElementById('activity-root')).render(<>{[...older, ...current].map(item =>
      <TaskChatRunnerActivityGroup key={item.id} item={item} />)}</>);
  ` }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", tsconfig: path.resolve(import.meta.dirname, "../../ui/tsconfig.json"),
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" }, logLevel: "silent" });
  // The artifact controls and text viewer are the shipped components. Their
  // friendly work-product title deliberately differs from the actual filename.
  const artifactBundle = await build({ stdin: { loader: "tsx", resolveDir: path.resolve(import.meta.dirname, "../../ui"), contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { RichWorkProductCard } from './src/components/task-chat/RichWorkProductCard';
    import { ArtifactRow } from './src/components/artifacts/v1/ArtifactRow';
    import { TextAttachmentContext } from './src/context/TextAttachmentContext';
    import { TextAttachmentPreview } from './src/components/task-side-panel/TaskAttachmentPanel';
    const route = new URL(location.href).pathname.slice(1), currentId = ${JSON.stringify(artifactId)}, secondId = ${JSON.stringify(followupId)};
    const wrongId = '33333333-3333-4333-8333-333333333333';
    const first = ${JSON.stringify(artifactBytes.toString('utf8'))}, second = ${JSON.stringify(followupBytes.toString('utf8'))};
    const bytes = id => id === secondId ? second : first;
    const product = (id, size = bytes(id).length) => ({ id: 'product-' + id, companyId: 'synthetic-company', issueId: 'synthetic-issue',
      type: 'artifact', provider: 'paperclip', externalId: id, title: 'Prepared proof file', status: 'active', reviewState: 'none',
      healthStatus: 'unknown', createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z',
      metadata: { attachmentId: id, originalFilename: 'antigravity-proof.txt', contentType: 'text/plain', byteSize: size,
        contentPath: '/api/attachments/' + id + '/content', openPath: '/api/attachments/' + id + '/content', downloadPath: '/api/attachments/' + id + '/content?download=1' } });
    function ArtifactCalibration() {
      const [selected, setSelected] = useState(null);
      const open = (id, title) => setSelected({ id: route === 'artifact-wrong-viewer-id' ? wrongId : id, title });
      const render = (id, size) => <RichWorkProductCard workProduct={product(id, size)} href={'/api/attachments/' + id + '/content'} variant={route === 'artifact-compact' ? 'compact' : 'card'} />;
      const row = <ArtifactRow subject={{ kind: 'file', title: 'Prepared proof file', filename: 'antigravity-proof.txt', sizeLabel: '61 B' }}
        onClick={() => open(route === 'artifact-button-wrong-id' ? wrongId : currentId, 'antigravity-proof.txt')} />;
      return <main><TextAttachmentContext.Provider value={open}>
        {route.startsWith('artifact-button') ? <>{row}{route === 'artifact-button-duplicate' ? row : null}</> :
         route === 'artifact-hidden' ? <><div hidden>{render(currentId)}</div>{render(wrongId)}</> :
         route === 'artifact-followup' ? <>{render(currentId)}{render(secondId)}</> :
         <>{render(currentId, route === 'artifact-wrong-size' ? 119 : 61)}{route === 'artifact-duplicate' ? render(currentId) : null}</>}
        {selected ? <div hidden={route === 'artifact-hidden-viewer'}><TextAttachmentPreview title={selected.title}
          text={route === 'artifact-wrong-preview' ? 'Wrong file bytes' : bytes(selected.id)} markdown={false}
          downloadUrl={'/api/attachments/' + selected.id + '/content?download=1'} /></div> : null}
      </TextAttachmentContext.Provider></main>;
    }
    createRoot(document.getElementById('artifact-root')).render(<ArtifactCalibration />);
  ` }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", tsconfig: path.resolve(import.meta.dirname, "../../ui/tsconfig.json"),
    loader: { ".svg": "dataurl" }, define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" }, logLevel: "silent" });
  // Render the shipped wizard and actual agentsApi: only the selected-company
  // context is fixed. All draft creation crosses the real browser POST boundary.
  const creationCompanyId = "33333333-3333-4333-8333-333333333333", creatorUserId = "synthetic-user";
  const creationName = "Antigravity QA 0123456789ab";
  const creationBundle = await build({ stdin: { loader: "tsx", resolveDir: path.resolve(import.meta.dirname, "../../ui"), contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
    import { AgentBasicsDialog } from './src/components/new-agent/AgentBasicsDialog';
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    createRoot(document.getElementById('creation-root')).render(<QueryClientProvider client={cache}>
      <AgentBasicsDialog open onClose={() => {}} onContinue={() => {}} />
    </QueryClientProvider>);
  ` }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", tsconfig: path.resolve(import.meta.dirname, "../../ui/tsconfig.json"),
    loader: { ".svg": "dataurl" }, define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" }, logLevel: "silent",
    plugins: [{ name: "selected-company-calibration", setup(build) {
      build.onResolve({ filter: /CompanyContext$/ }, () => ({ path: "selected-company", namespace: "calibration" }));
      build.onLoad({ filter: /.*/, namespace: "calibration" }, () => ({ contents: `export const useCompany = () => ({ selectedCompanyId: '${creationCompanyId}' });`, loader: "js" }));
    } }] });
  let persistedCreation: Record<string, unknown> | undefined;
  let creationMode: "normal" | "lost-response" | "wrong-response-id" | "foreign-response-creator" | "malformed-response" = "normal";
  const receivedCreatePaths: string[] = [];
  const creationRequests: Array<{ body: Record<string, any>; raw: string; durableBeforeForward: boolean }> = [];
  const server = createServer(async (request, response) => {
    const name = new URL(request.url ?? "/", "http://localhost").pathname.slice(1);
    if (request.method === "POST" && /^api\/companies\/[^/]+\/agents$/u.test(name)) receivedCreatePaths.push(name);
    if (name === "creation-client.js") { response.writeHead(200, { "Content-Type": "text/javascript" }).end(creationBundle.outputFiles[0]!.text); return; }
    if (name === "creation") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end('<!doctype html><html><body><div id="creation-root"></div><script src="/creation-client.js"></script></body></html>'); return; }
    if (name === "api/instance/settings/experimental") { response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ enableNativeRunner: true })); return; }
    if (name === "api/adapters") { response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([{ type: "paperclip_runner", loaded: true, candidateHarnesses: [{ agent: "antigravity", model }] }])); return; }
    if (name === `api/companies/${creationCompanyId}/agents`) {
      if (request.method === "POST") {
        let raw = ""; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        const expected = { setupId: body.setupId, companyId: creationCompanyId, agentName: body.name, provider: "antigravity", creatorUserId, origin: `http://${request.headers.host}` };
        creationRequests.push({ body, raw, durableBeforeForward: persistedCreation != null && Object.keys(persistedCreation).length === 6 && Object.entries(expected).every(([key, value]) => persistedCreation![key] === value) });
        // Simulate a committed row whose response is lost, without re-sending
        // the POST or invoking any agent/provider work.
        if (creationMode === "lost-response") {
          response.writeHead(201, { "Content-Type": "application/json", "Content-Length": "1000" });
          response.flushHeaders(); response.write('{"id":');
          setTimeout(() => response.destroy(), 25); return;
        }
        if (creationMode === "malformed-response") { response.writeHead(201, { "Content-Type": "application/json" }).end("{"); return; }
        response.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ ...body, id: creationMode === "wrong-response-id" ? artifactId : body.setupId,
          companyId: creationCompanyId, createdByUserId: creationMode === "foreign-response-creator" ? "another-user" : creatorUserId, lifecycleState: "draft" })); return;
      }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([{ id: followupId, companyId: creationCompanyId, role: "ceo", status: "idle" }])); return;
    }
    if (/^api\/attachments\/[^/]+\/content$/u.test(name)) {
      const referer = String(request.headers.referer ?? "");
      const bytes = referer.includes("artifact-bad-download") ? Buffer.from("C".repeat(artifactBytes.length)) : name.includes(followupId) ? followupBytes : artifactBytes;
      response.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="antigravity-proof.txt"' }).end(bytes); return;
    }
    if (name === "artifact-client.js") { response.writeHead(200, { "Content-Type": "text/javascript" }).end(artifactBundle.outputFiles[0]!.text); return; }
    if (name.startsWith("artifact")) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end('<!doctype html><html><body><div id="artifact-root"></div><script src="/artifact-client.js"></script></body></html>'); return;
    }
    if (name === "activity-client.js") { response.writeHead(200, { "Content-Type": "text/javascript" }).end(activityBundle.outputFiles[0]!.text); return; }
    if (name.endsWith("activity")) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><style>svg{width:14px;height:14px}button{display:block}</style></head><body><button onclick="document.getElementById('activity-root').hidden=false;this.remove()">More messages</button><div id="activity-root" hidden></div><p>The file work succeeded; unrelated task failed.</p><script src="/activity-client.js"></script></body></html>`); return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body>${fixtures[name] ?? "missing fixture"}</body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let removeCreationObserver: (() => void) | undefined;
  try {
    const visit = async (fixture: string) => page.goto(`${origin}/${fixture}`);
    const creationResources = (): AntigravityJourneyResources => ({ version: 1, executionId: ANTIGRAVITY_JOURNEY_EXECUTION, origin, companyId: creationCompanyId,
      environmentId: artifactId, connectionId: followupId, agentName: creationName, runIds: [], processes: {}, retained: false, setupProbe: "not_started" });
    const beginCreation = async () => {
      await visit("creation");
      const dialog = page.getByRole("dialog", { name: "Meet your next agent", exact: true });
      await dialog.getByRole("textbox", { name: "Agent name", exact: true }).fill(creationName);
      return () => dialog.getByRole("button", { name: "Choose adapter", exact: true }).click();
    };
    const originalPostBodies: string[] = [];
    const observeCreation = (request: import("@playwright/test").Request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === `/api/companies/${creationCompanyId}/agents`) originalPostBodies.push(request.postData()!);
    };
    page.on("request", observeCreation); removeCreationObserver = () => page.off("request", observeCreation);
    const owned = creationResources(), submit = await beginCreation();
    let writes = 0;
    const draft = await captureAntigravityAgentDraft(page, owned, async () => { writes++; persistedCreation = structuredClone((owned as any).agentCreationRequest); }, submit, creatorUserId);
    assert.equal(writes, 1, "persist the safe creation identity once before network forwarding");
    assert.equal(creationRequests.length, 1);
    assert.equal(creationRequests[0]!.durableBeforeForward, true, "creation witness must be durable before the server receives the unchanged POST");
    assert.deepEqual((owned as any).agentCreationRequest, { setupId: draft.id, companyId: creationCompanyId, agentName: creationName, provider: "antigravity", creatorUserId, origin });
    assert.equal(creationRequests[0]!.raw, originalPostBodies[0], "forward the original UI POST body without mutation");
    assert.equal(creationRequests[0]!.body.setupId, draft.id);
    assert.equal(creationRequests[0]!.body.metadata.setupAdapterPending, true);
    assert.equal(creationRequests[0]!.body.runtimeConfig.heartbeat.enabled, false);
    assert.equal(JSON.stringify(persistedCreation).includes("runtimeConfig"), false);
    await page.getByRole("dialog", { name: "Choose an adapter", exact: true }).waitFor({ state: "visible" });
    await page.locator('input[type="radio"][value="antigravity_runtime"]').waitFor({ state: "attached" });
    // A storage barrier proves that request forwarding joins the durable write.
    const gateOwned = creationResources(), gateSubmit = await beginCreation(), beforeGate = creationRequests.length;
    let releaseWrite!: () => void, enteredWrite!: () => void;
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    const writeEntered = new Promise<void>(resolve => { enteredWrite = resolve; });
    const gated = captureAntigravityAgentDraft(page, gateOwned, async () => {
      enteredWrite(); await writeGate; persistedCreation = structuredClone((gateOwned as any).agentCreationRequest);
    }, gateSubmit, creatorUserId);
    try { await writeEntered; assert.equal(creationRequests.length, beforeGate, "do not forward while persistence is blocked"); }
    finally { releaseWrite(); }
    await gated;
    assert.equal(creationRequests.at(-1)!.durableBeforeForward, true);
    assert.equal(creationRequests.at(-1)!.raw, originalPostBodies.at(-1));
    const storageOwned = creationResources(), storageSubmit = await beginCreation(), beforeStorageFailure = creationRequests.length;
    const storageError = new Error("synthetic creation receipt storage unavailable");
    await assert.rejects(captureAntigravityAgentDraft(page, storageOwned, async () => { throw storageError; }, storageSubmit, creatorUserId), error => error === storageError);
    assert.equal(creationRequests.length, beforeStorageFailure, "failed persistence must abort before any server commit");
    for (const mode of ["wrong-response-id", "foreign-response-creator", "malformed-response"] as const) {
      creationMode = mode; persistedCreation = undefined;
      const wrong = creationResources(), wrongSubmit = await beginCreation();
      await assert.rejects(captureAntigravityAgentDraft(page, wrong, async () => { persistedCreation = structuredClone((wrong as any).agentCreationRequest); }, wrongSubmit, creatorUserId));
      assert.equal(creationRequests.at(-1)!.durableBeforeForward, true);
      assert.equal((wrong as any).agentCreationRequest.setupId, creationRequests.at(-1)!.body.setupId);
      assert.equal(wrong.agentId, undefined, "an untrusted response cannot replace the exact request identity");
    }
    creationMode = "lost-response"; persistedCreation = undefined;
    const lost = creationResources(), lostSubmit = await beginCreation(), beforeLost = creationRequests.length;
    page.setDefaultTimeout(1500);
    try {
      await assert.rejects(captureAntigravityAgentDraft(page, lost, async () => { persistedCreation = structuredClone((lost as any).agentCreationRequest); }, lostSubmit, creatorUserId));
      assert.equal(creationRequests.length, beforeLost + 1, "a lost response must not replay creation");
      assert.equal(creationRequests.at(-1)!.durableBeforeForward, true);
      assert.equal((lost as any).agentCreationRequest.setupId, creationRequests.at(-1)!.body.setupId);
      assert.equal(lost.agentId, undefined);
    } finally { page.setDefaultTimeout(10000); }
    creationMode = "normal";
    for (const patch of [{ setupId: "not-a-uuid" }, { name: "Existing user agent" }, { setupId: undefined }, { company: artifactId }]) {
      const malformed = creationResources(); const before: number = receivedCreatePaths.length;
      let malformedWrites = 0;
      await assert.rejects(captureAntigravityAgentDraft(page, malformed, async () => { malformedWrites++; }, async () => {
        await page.evaluate(({ route, body }) => { void fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {}); },
          { route: `/api/companies/${"company" in patch ? patch.company : creationCompanyId}/agents`, body: { setupId: artifactId, name: creationName, ...patch } });
      }, creatorUserId));
      assert.equal(malformedWrites, 0); assert.equal(receivedCreatePaths.length, before, "reject an invalid create identity before forwarding");
      assert.equal((malformed as any).agentCreationRequest, undefined);
    }
    // A durable subset must never absorb unrelated fields from an outgoing body.
    const privateBodyOwned = creationResources(); let privateWrite: string | undefined;
    await captureAntigravityAgentDraft(page, privateBodyOwned, async () => {
      persistedCreation = structuredClone((privateBodyOwned as any).agentCreationRequest); privateWrite = JSON.stringify(privateBodyOwned);
    }, async () => {
      await page.evaluate(({ route, body }) => { void fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {}); },
        { route: `/api/companies/${creationCompanyId}/agents`, body: { setupId: artifactId, name: creationName, runtimeConfig: { env: { SYNTHETIC_PRIVATE_VALUE: "must-never-be-persisted" } } } });
    }, creatorUserId);
    assert.equal(privateWrite!.includes("must-never-be-persisted"), false);
    assert.equal(creationRequests.at(-1)!.body.runtimeConfig.env.SYNTHETIC_PRIVATE_VALUE, "must-never-be-persisted", "the original request still forwards unchanged");
    const submitError = new Error("synthetic ordinary submit failure");
    await assert.rejects(captureAntigravityAgentDraft(page, creationResources(), async () => {}, async () => { throw submitError; }, creatorUserId), error => error === submitError);
    const abortedOwned = creationResources(), abortSubmit = await beginCreation(), beforeAbort = creationRequests.length;
    const abortError = new Error("synthetic route abort cleanup failure");
    const failingAbortPage = new Proxy(page, { get(target, key) {
      if (key === "route") return (url: any, handler: any) => target.route(url, (route, request) => handler(new Proxy(route, { get(owner, operation) {
        if (operation === "abort") return async (...args: any[]) => { await owner.abort(...args); throw abortError; };
        const value = Reflect.get(owner, operation); return typeof value === "function" ? value.bind(owner) : value;
      } }), request));
      if (key === "unroute") return (url: any) => target.unroute(url);
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    await assert.rejects(captureAntigravityAgentDraft(failingAbortPage, abortedOwned, async () => { throw storageError; }, abortSubmit, creatorUserId), error => error === storageError);
    assert.equal(creationRequests.length, beforeAbort, "an abort-cleanup error cannot forward an unjournaled create");
    const teardownError = new Error("synthetic route teardown failure");
    const failingTeardownPage = new Proxy(page, { get(target, key) {
      if (key === "unroute") return async () => { throw teardownError; };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    try {
      await assert.rejects(captureAntigravityAgentDraft(failingTeardownPage, creationResources(), async () => {}, async () => { throw submitError; }, creatorUserId), error => error === submitError);
    } finally { await page.unrouteAll({ behavior: "wait" }); }
    const teardownOwned = creationResources(), teardownSubmit = await beginCreation();
    try {
      await assert.rejects(captureAntigravityAgentDraft(failingTeardownPage, teardownOwned, async () => {
        persistedCreation = structuredClone((teardownOwned as any).agentCreationRequest);
      }, teardownSubmit, creatorUserId), error => error === teardownError);
      assert.equal(creationRequests.at(-1)!.durableBeforeForward, true);
      assert.equal((teardownOwned as any).agentCreationRequest.setupId, creationRequests.at(-1)!.body.setupId);
    } finally { await page.unrouteAll({ behavior: "wait" }); }
    // After every error, a new ordinary wizard request still passes exactly one
    // interceptor. This also detects a leaked route from the failed attempt.
    const afterFailure = creationResources(), afterSubmit = await beginCreation(); let afterWrites = 0;
    await captureAntigravityAgentDraft(page, afterFailure, async () => { afterWrites++; persistedCreation = structuredClone((afterFailure as any).agentCreationRequest); }, afterSubmit, creatorUserId);
    assert.equal(afterWrites, 1); assert.equal(creationRequests.at(-1)!.durableBeforeForward, true);
    removeCreationObserver(); removeCreationObserver = undefined;
    await visit("dashboard"); await openAntigravityAgentFromRoster(page, agent, 300);
    assert.equal(new URL(page.url()).pathname, "/owned-agent");
    for (const fixture of ["artifact", "artifact-compact", "artifact-button-row"]) {
      await visit(fixture); try { await inspectAntigravityArtifact(page, artifactId, artifactBytes, 1000); } catch (error) { throw new Error(`${fixture}: ${await page.locator("body").innerText()}`, { cause: error }); }
    }
    await visit("artifact-followup"); await inspectAntigravityArtifact(page, followupId, followupBytes, 1000);
    for (const fixture of ["artifact-hidden", "artifact-duplicate", "artifact-wrong-size", "artifact-wrong-viewer-id", "artifact-wrong-preview", "artifact-hidden-viewer", "artifact-button-wrong-id", "artifact-button-duplicate"]) {
      await visit(fixture); await assert.rejects(inspectAntigravityArtifact(page, artifactId, artifactBytes, 300), fixture);
    }
    await visit("artifact-bad-download");
    await assert.rejects(inspectAntigravityArtifact(page, artifactId, artifactBytes, 1000), /browser_download_bytes_mismatch/u);
    for (const [fixture, target] of [["task-uuid", "synthetic-issue-id"], ["task-identifier", "ANT-42"], ["task-duplicate", "synthetic-issue-id"], ["task-repeated", "ANT-42"]]) {
      await visit(fixture); await openAntigravityCreatedTask(page, { id: "synthetic-issue-id", identifier: "ANT-42" }, 300);
      assert.equal(new URL(page.url()).pathname, '/ANT/issues/' + target);
    }
    for (const fixture of ["task-hidden", "task-other-only"]) {
      await visit(fixture); await assert.rejects(openAntigravityCreatedTask(page, { id: "synthetic-issue-id", identifier: "ANT-42" }, 300), fixture);
    }
    await visit("picker"); await selectAntigravityFromOrdinaryPicker(page, 300);
    assert.equal(await page.getByRole("radio", { name: "Google Antigravity Candidate", exact: true }).isChecked(), true);
    await visit("advanced-only"); await assert.rejects(selectAntigravityFromOrdinaryPicker(page, 300));
    await visit("ready"); await assertAntigravityReady(page, agent, 300);
    await visit("narrative-ready"); await assert.rejects(assertAntigravityReady(page, agent, 300));
    await visit("done"); await assertAntigravityTaskDone(page, 300);
    await visit("done-scrolled");
    const restoredScroll = await page.locator("#thread").evaluate(node => node.scrollTop);
    assert.ok(restoredScroll > 0, "Done regression must start at a restored nonzero scroll position");
    await assertAntigravityTaskDone(page, 300);
    assert.equal(await page.locator("#thread").evaluate(node => node.scrollTop), restoredScroll);
    for (const fixture of ["narrative-done", "wrong-current-breadcrumb", "hidden-breadcrumb-done"]) {
      await visit(fixture); await assert.rejects(assertAntigravityTaskDone(page, 300), fixture);
    }
    await visit("composer"); await assertAntigravityCleanComposer(page, agent, model, 300);
    await visit("paused-composer"); await assert.rejects(assertAntigravityCleanComposer(page, agent, model, 300));
    await visit("wrong-model"); await assert.rejects(assertAntigravityCleanComposer(page, agent, model, 300));
    for (const fixture of ["stale-first-only-activity", "legacy-stale-first-only-activity"]) {
      await visit(fixture); await assert.rejects(assertAntigravityFileActivity(page, "synthetic-run", 1000), fixture);
    }
    await visit("activity"); await assertAntigravityFileActivity(page, "synthetic-run", 1000);
    await visit("write-activity"); await assertAntigravityFileActivity(page, "synthetic-run", 1000);
    for (const fixture of ["current-run-mixed-activity", "legacy-current-run-mixed-activity"]) {
      await visit(fixture); await assertAntigravityFileActivity(page, "synthetic-run", 1000);
    }
    for (const fixture of ["failed-read-activity", "interrupted-edit-activity", "running-read-activity", "failed-renderer-activity", "interrupted-renderer-activity", "wrong-target-activity"]) {
      await visit(fixture);
      let rejected = false;
      try { await assertAntigravityFileActivity(page, "synthetic-run", 300); } catch { rejected = true; }
      assert.ok(rejected, `${fixture}: ${await page.locator("body").innerText()}`);
    }
    for (const fixture of ["legacy-activity", "legacy-write-activity"]) {
      await visit(fixture); await assertAntigravityFileActivity(page, "synthetic-run", 1000);
      assert.equal(await page.locator('[data-activity-family="tool_execution"]').count(), 0);
    }
    for (const fixture of ["legacy-failed-read-activity", "legacy-interrupted-edit-activity", "legacy-running-read-activity", "legacy-pending-read-activity", "legacy-wrong-target-activity"]) {
      await visit(fixture);
      let rejected = false;
      try { await assertAntigravityFileActivity(page, "synthetic-run", 300); } catch { rejected = true; }
      assert.ok(rejected, `${fixture}: ${await page.locator("body").innerText()}`);
    }
    console.log("PASS Antigravity browser calibration: production AgentBasicsDialog/agentsApi safe creation witness durable before unchanged POST, persistence gate/failure, lost201-body recovery identity, malformed/foreign request and response rejection, no raw-body/env persistence, abort/unroute primary-error preservation; production rich/compact artifact cards and rows, exact attachment viewer/download identity+61/119B, hidden/duplicate/wrong-ID/size/bytes rejection, both task sidebar layouts; More messages plus production transcript adapter/activity renderer for canonical provider activity and native legacy tool calls/results; exact run-bound completed read/edit/write, stale-first-only rejection/current-run mixed-history acceptance, exact target, failed/interrupted/running/pending rejection and unrelated failed finish");
  } finally {
    removeCreationObserver?.();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

// Keep the documented standalone entry while the canonical support spec uses
// Playwright's existing page/browser lifecycle instead of launching a second runner.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const browser = await chromium.launch({ headless: true });
  try {
    await runAntigravityBrowserCalibration(await browser.newPage());
  } finally {
    await browser.close();
  }
}
