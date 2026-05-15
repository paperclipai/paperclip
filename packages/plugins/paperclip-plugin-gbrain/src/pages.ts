import { issueSlug, agentSlug, PAGE_TYPES } from "./identity.js";

export interface GbrainCallable {
  call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T>;
}

export async function ensureIssuePage(
  client: GbrainCallable,
  input: {
    identifier: string | null | undefined;
    title: string | null | undefined;
    description: string | null | undefined;
  },
): Promise<void> {
  const slug = issueSlug(input.identifier);
  if (!slug) {
    throw new Error("ensureIssuePage: identifier is required");
  }
  const existing = await client.call("get_page", { slug });
  if (existing) return;
  await client.call("put_page", {
    slug,
    type: PAGE_TYPES.ISSUE,
    title: input.title ?? input.identifier ?? slug,
    content: input.description ?? "",
  });
}

export async function ensureAgentPage(
  client: GbrainCallable,
  input: { agentId: string; agentName: string | null | undefined },
): Promise<void> {
  const slug = agentSlug(input.agentName);
  if (!slug) {
    throw new Error("ensureAgentPage: agent name produced empty slug");
  }
  const existing = await client.call("get_page", { slug });
  if (existing) return;
  await client.call("put_page", {
    slug,
    type: PAGE_TYPES.AGENT,
    title: input.agentName ?? slug,
    content: `Agent ${input.agentName ?? "(unnamed)"} (id ${input.agentId})`,
  });
}

export async function addWorkedOnLink(
  client: GbrainCallable,
  input: { agentSlug: string; issueSlug: string },
): Promise<void> {
  await client.call("add_link", {
    from_slug: input.agentSlug,
    to_slug: input.issueSlug,
    link_type: "worked_on",
  });
}

export async function addRunTimelineEntry(
  client: GbrainCallable,
  input: {
    issueSlug: string;
    body: string;
    agentId: string;
    runId: string;
    companyId: string;
    outcome: string;
    finishedAt: string;
  },
): Promise<void> {
  await client.call("add_timeline_entry", {
    slug: input.issueSlug,
    body: input.body,
    occurred_at: input.finishedAt,
    metadata: {
      agentId: input.agentId,
      runId: input.runId,
      companyId: input.companyId,
      outcome: input.outcome,
      source: "paperclip-plugin-gbrain",
    },
  });
}
