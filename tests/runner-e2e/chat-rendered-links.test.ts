// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationLinkBindings, readConversationDomLinks, type ConversationLinkInput } from "./chat-rendered-links.js";

const card = '<div data-thread-item-kind="project_created" data-thread-anchor="project-created:project"><article aria-label="Project created: Launch"><div><p>Project created</p><a href="/RUN/projects/project">Launch</a></div></article></div>';
const thread = (content = card) => `<div data-testid="task-chat-thread"><div data-testid="task-chat-history-content"><div data-testid="task-chat-scroller"><div id="comment-human" data-thread-item-kind="human">Create a project called Launch for the new website.</div>${content}<div id="comment-reply" data-thread-item-kind="agent">Created the Launch project. No repositories are connected yet.</div></div></div></div>`;
function input(): ConversationLinkInput {
  return { origin: "https://fixture.test", companyId: "company", companyPrefix: "RUN", sourceId: "source", leadId: "ceo",
    comments: [{ id: "human", issueId: "source", companyId: "company" }, { id: "reply", issueId: "source", companyId: "company", authorAgentId: "ceo", createdByRunId: "run" }],
    runs: [{ id: "run", companyId: "company", agentId: "ceo", status: "succeeded", contextSnapshot: { issueId: "source" } }],
    projects: [{ id: "project", companyId: "company", name: "Launch" }],
    activity: [{ id: "created", companyId: "company", action: "project.created", entityType: "project", entityId: "project", actorType: "agent", actorId: "ceo", agentId: "ceo", runId: "run" }] };
}
const collect = (value = input()) => readConversationDomLinks(conversationLinkBindings(value));
beforeEach(() => { document.body.innerHTML = thread(); vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{ width: 20, height: 20 }] as unknown as DOMRectList); });
afterEach(() => vi.restoreAllMocks());
it("collects the real supported sibling project-card structure when reply-only collection has no link", () => {
  expect(document.querySelectorAll('#comment-reply a[href]')).toHaveLength(0);
  expect(collect()).toEqual([{ threadTestId: "task-chat-thread", href: "/RUN/projects/project", source: "project-created-card", conversationId: "source", anchorCommentId: "human", resourceId: "project", cardLabel: "Project created: Launch", createdByRunId: "run" }]);
});
it("keeps the original creation card usable on an idempotent retry without requiring another card", () => {
  const value = input(); value.comments.push({ id: "retry", issueId: "source", companyId: "company", authorAgentId: "ceo", createdByRunId: "retry-run" });
  value.runs.push({ id: "retry-run", companyId: "company", agentId: "ceo", status: "succeeded", contextSnapshot: { issueId: "source" } });
  document.querySelector('[data-testid="task-chat-scroller"]')!.insertAdjacentHTML('beforeend', '<div id="comment-retry">The project already exists.</div>');
  expect(collect(value).map(row => row.href)).toEqual(["/RUN/projects/project"]);
});
it("retains visible ordinary reply links including task, goal and artifact links", () => {
  document.querySelector('#comment-reply')!.innerHTML = '<a href="/RUN/issues/task">Task</a><a href="/RUN/goals/goal">Goal</a><a href="/api/attachments/file/content">Artifact</a><a href="https://github.com/owner/repository/issues/12">External issue</a>';
  expect(collect().filter(row => row.source === 'reply').map(row => row.href)).toEqual(['/RUN/issues/task','/RUN/goals/goal','/api/attachments/file/content','https://github.com/owner/repository/issues/12']);
});
it.each([
  ['wrong saved company', (v:ConversationLinkInput) => { v.projects[0]!.companyId='other'; }],
  ['wrong saved resource', (v:ConversationLinkInput) => { v.projects[0]!.id='other'; }],
  ['wrong saved name', (v:ConversationLinkInput) => { v.projects[0]!.name='Other'; }],
  ['missing creation audit', (v:ConversationLinkInput) => { v.activity=[]; }],
  ['wrong audit company', (v:ConversationLinkInput) => { v.activity[0]!.companyId='other'; }],
  ['wrong audit actor type', (v:ConversationLinkInput) => { v.activity[0]!.actorType='user'; }],
  ['wrong audit actor', (v:ConversationLinkInput) => { v.activity[0]!.actorId='other'; }],
  ['wrong audit agent', (v:ConversationLinkInput) => { v.activity[0]!.agentId='other'; }],
  ['wrong audit entity type', (v:ConversationLinkInput) => { v.activity[0]!.entityType='issue'; }],
  ['wrong audit resource', (v:ConversationLinkInput) => { v.activity[0]!.entityId='other'; }],
  ['unrelated historical run', (v:ConversationLinkInput) => { v.activity[0]!.runId='old'; }],
  ['run in another company', (v:ConversationLinkInput) => { v.runs[0]!.companyId='other'; }],
  ['run for another conversation', (v:ConversationLinkInput) => { v.runs[0]!.contextSnapshot={issueId:'other'}; }],
  ['wrong reply author', (v:ConversationLinkInput) => { v.comments[1]!.authorAgentId='other'; }],
  ['reply from another conversation', (v:ConversationLinkInput) => { v.comments[1]!.issueId='other'; }],
  ['comments from another company', (v:ConversationLinkInput) => { v.comments.forEach(row=>row.companyId='other'); }],
] as const)('rejects %s instead of treating any matching project link as evidence', (_label, mutate) => { const value=input(); mutate(value); expect(collect(value)).toEqual([]); });
it.each([
  ['sidebar only', () => { document.body.innerHTML=thread('')+`<aside>${card}</aside>`; }],
  ['unrelated conversation', () => { document.body.innerHTML=thread('')+thread().replaceAll('comment-human','comment-other-human').replaceAll('comment-reply','comment-other-reply'); }],
  ['hidden sibling', () => { document.querySelector('article')!.setAttribute('hidden',''); }],
  ['hidden ancestor', () => { document.querySelector('[data-testid="task-chat-history-content"]')!.setAttribute('style','visibility:hidden'); }],
  ['inert ancestor', () => { document.querySelector('[data-testid="task-chat-history-content"]')!.setAttribute('inert',''); }],
  ['aria-hidden ancestor', () => { document.querySelector('[data-testid="task-chat-history-content"]')!.setAttribute('aria-hidden','true'); }],
  ['display:none', () => { document.querySelector('article')!.setAttribute('style','display:none'); }],
  ['transparent card', () => { document.querySelector('article')!.setAttribute('style','opacity:0'); }],
  ['missing layout box', () => { vi.mocked(Element.prototype.getClientRects).mockReturnValue([] as unknown as DOMRectList); }],
  ['missing supported card wrapper', () => { document.querySelector('[data-thread-item-kind="project_created"]')!.removeAttribute('data-thread-item-kind'); }],
  ['wrong item resource', () => { document.querySelector('[data-thread-item-kind="project_created"]')!.setAttribute('data-thread-anchor','project-created:other'); }],
  ['wrong card kind', () => { document.querySelector('article')!.setAttribute('aria-label','Goal created: Launch'); }],
  ['wrong card resource', () => { document.querySelector('article a')!.setAttribute('href','/RUN/projects/other'); }],
  ['wrong company route', () => { document.querySelector('article a')!.setAttribute('href','/OTHER/projects/project'); }],
  ['other origin', () => { document.querySelector('article a')!.setAttribute('href','https://other.test/RUN/projects/project'); }],
  ['wrong resource kind', () => { document.querySelector('article a')!.setAttribute('href','/RUN/goals/project'); }],
  ['extra destination path', () => { document.querySelector('article a')!.setAttribute('href','/RUN/projects/project/other'); }],
  ['duplicate visible source conversation', () => { document.body.insertAdjacentHTML('beforeend',thread()); }],
] as const)('rejects %s in actual DOM scope', (_label, mutate) => { mutate(); expect(collect()).toEqual([]); });
it("excludes hidden, wrong-company and unrelated inline anchors while keeping the current reply", () => {
  document.querySelector('#comment-reply')!.innerHTML='<a href="/RUN/issues/task">Task</a><a hidden href="/RUN/issues/hidden">Hidden</a><a href="/OTHER/issues/task">Other company</a>';
  document.body.insertAdjacentHTML('beforeend','<aside><a href="/RUN/issues/sidebar">Sidebar</a></aside>');
  expect(collect().filter(row=>row.source==='reply').map(row=>row.href)).toEqual(['/RUN/issues/task']);
});

it("treats a link inside an authenticated reply as an ordinary inline link, not a sibling creation receipt", () => {
  document.querySelector('#comment-reply')!.append(document.querySelector('article')!);
  expect(collect().map(row=>row.source)).toEqual(['reply']);
});

it("recognizes the minimized authentic retained DOM and server identities without changing the original measurement", () => {
  const fixture = JSON.parse(readFileSync(`${import.meta.dirname}/chat-rendered-links.retained-project.json`, "utf8"));
  document.body.innerHTML = fixture.html;
  const reply = fixture.input.comments.find((row: { authorAgentId?: string }) => row.authorAgentId);
  expect(document.getElementById(`comment-${reply.id}`)!.querySelectorAll("a[href]")).toHaveLength(0);
  expect(collect(fixture.input).map(row => row.href)).toEqual([fixture.expectedHref]);
});

it("retains ordinary inline links in the supported classic issue-chat root", () => {
  document.body.innerHTML=thread('').replace('task-chat-thread','thread-root');
  document.querySelector('#comment-reply')!.innerHTML='<a href="/RUN/issues/task">Task</a>';
  expect(collect().map(row=>[row.threadTestId,row.source,row.href])).toEqual([['thread-root','reply','/RUN/issues/task']]);
});
