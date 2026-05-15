import { issueSlug, agentSlug, PAGE_TYPES } from "./identity.js";

export interface GbrainCallable {
  call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T>;
}

// gbrain `put_page` accepts { slug, content } where content is markdown
// with YAML frontmatter. Type / title / tags must be embedded in the
// frontmatter, not passed as separate parameters.
function frontmatterContent(
  type: string,
  title: string,
  body: string,
  extra: Record<string, string | string[]> = {},
): string {
  const lines = [`---`, `type: ${type}`, `title: ${JSON.stringify(title)}`];
  for (const [k, v] of Object.entries(extra)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push(`---`, body || "");
  return lines.join("\n") + "\n";
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
  const content = frontmatterContent(
    PAGE_TYPES.ISSUE,
    input.title ?? input.identifier ?? slug,
    input.description ?? "",
    { identifier: input.identifier ?? "" },
  );
  await client.call("put_page", { slug, content });
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
  const name = input.agentName ?? slug;
  const content = frontmatterContent(
    PAGE_TYPES.AGENT,
    name,
    `Agent ${name} (id ${input.agentId})`,
    { agent_id: input.agentId },
  );
  await client.call("put_page", { slug, content });
}

export async function addWorkedOnLink(
  client: GbrainCallable,
  input: { agentSlug: string; issueSlug: string },
): Promise<void> {
  await client.call("add_link", {
    from: input.agentSlug,
    to: input.issueSlug,
    link_type: "worked_on",
  });
}

/**
 * gbrain `add_timeline_entry.date` must be `YYYY-MM-DD` — passing a full
 * ISO timestamp (e.g. `2026-05-15T20:44:35.081Z`) returns
 * `internal_error: Invalid date format`. Truncate to the date component.
 */
function toYmdDate(iso: string): string {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : iso;
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
  const summary = `Run ${input.runId.slice(0, 8)} by ${input.agentId.slice(0, 8)} — ${input.outcome}`;
  await client.call("add_timeline_entry", {
    slug: input.issueSlug,
    date: toYmdDate(input.finishedAt),
    summary,
    detail: input.body,
    source: "paperclip-plugin-gbrain",
  });
}
