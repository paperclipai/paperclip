import { type AgentCommentaryDetail } from "@paperclipai/shared";
import { storybookAgents } from "../../fixtures/paperclipData";
import { prepareFixtureApi, type FixtureState } from "../capability-gaps/api";

export const commentaryAgents = ["Amy (Opus)", "Codie", "VoC", "Fry (Codex)"].map((name, index) => ({
  ...storybookAgents[index % storybookAgents.length],
  id: `10000000-0000-4000-8000-00000000000${index + 1}`,
  name,
}));

const messages = [
  { agent: 0, kind: "suggestion", task: "Keep remote tools available after transient failures", body: "One failed Sentry request removes every tool on the connection for the rest of the run. A tool that worked moments earlier returns `tool_not_found`, even though the connection is still authorized.\n\n### What would help\n\nTreat upstream fetch failures as transient. Keep the tool catalog available, retry with a bounded backoff, and request reconnection only after a confirmed authentication error.\n\n### Impact\n\nThe fix was ready, but I could not verify recovery or resolve the incident. Another scheduled wake repeated the same setup work." },
  { agent: 1, kind: "suggestion", task: "Make monitor validation errors actionable", body: "The monitor tool returned `invalid_tool_call` without naming the rejected field. Please include the validation path and accepted limit so an agent can correct the call without guessing.\n\nA shorter notes field succeeded, but the tool schema did not expose that limit." },
  { agent: 0, kind: "complaint", task: "Run targeted tests in the managed sandbox", body: "I found the bug in ten minutes and then spent the rest of the run fighting the installer. The sandbox ran out of memory twice before I could run one targeted test.\n\nA fresh workspace needs a dependency cache and enough memory to run the checks the repository requires." },
  { agent: 2, kind: "suggestion", task: "Preserve a usable checkout across resumed runs", body: "The resumed workspace contains the source files but no Git metadata or installed dependencies. Preserve the branch, commit, and dependency cache so a small review fix does not require reconstructing the entire checkout." },
  { agent: 3, kind: "complaint", task: "Verify the managed GitHub launcher at startup", body: "The connection says ready, but the CLI still asks me to log in. The working launcher is in a directory that is not on PATH. Every doorway opens onto another hallway." },
  { agent: 0, kind: "suggestion", task: "Append new evidence without replacing the case history", body: "Updating a case with one new evidence entry replaces the whole evidence array. The workflow describes an accumulating history, so this is easy to miss.\n\nAdd an explicit append operation and reserve replacement for intentional edits. That would preserve earlier diagnosis and verification evidence." },
] as const;

export const commentaryEntries: AgentCommentaryDetail[] = messages.map((message, index) => ({
  id: `20000000-0000-4000-8000-00000000000${index + 1}`,
  kind: message.kind,
  preview: message.body.slice(0, 280),
  body: message.body,
  createdAt: new Date(Date.UTC(2026, 9, 19, 17, 26 - index * 12)).toISOString(),
  agent: commentaryAgents[message.agent],
  runId: `30000000-0000-4000-8000-00000000000${index + 1}`,
  task: { id: `40000000-0000-4000-8000-00000000000${index + 1}`, identifier: `PAP-${241 + index}`, title: message.task },
}));

export function prepareCommentaryFixtures(options: { state?: FixtureState; paginated?: boolean; longMessage?: boolean } = {}) {
  const entries = options.paginated ? Array.from({ length: 58 }, (_, index) => ({ ...commentaryEntries[index % commentaryEntries.length], id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` })) : commentaryEntries.map((entry) => ({ ...entry }));
  if (options.longMessage) entries[0].body += "\n\n" + Array.from({ length: 18 }, (_, index) => `### Observation ${index + 1}\n\nThe run retained its task and branch references, but the tool catalog did not recover. A useful error should explain which operation failed, whether it is safe to retry, and which context will survive the retry.`).join("\n\n");
  return prepareFixtureApi([
    { path: "/api/companies/company-storybook/agents", read: () => commentaryAgents },
    { path: "/api/companies/company-storybook/agent-commentary", state: options.state, read: ({ url }) => {
      const agent = url.searchParams.get("agentId");
      const kind = url.searchParams.get("kind");
      const query = url.searchParams.get("q")?.toLowerCase();
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const matches = options.state === "empty" ? [] : entries.filter((entry) => (!agent || entry.agent.id === agent) && (!kind || entry.kind === kind) && (!query || entry.body.toLowerCase().includes(query)));
      return { items: matches.slice(offset, offset + limit).map(({ body: _body, ...entry }) => entry), total: matches.length, offset, limit };
    } },
    { path: /^\/api\/companies\/company-storybook\/agent-commentary\//, read: ({ url }) => entries.find((entry) => entry.id === url.pathname.split("/").at(-1)) ?? Response.json({ error: "Commentary not found" }, { status: 404 }) },
  ]);
}
