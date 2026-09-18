import { parseFrontmatterMarkdown, skillFrontmatterSchema } from "@paperclipai/shared";
import { z } from "zod";

/** A complete single-file skill. Identity and permissions come from the run. */
export const createSkillToolInput = z.object({
  name: z.string().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  slug: z.string().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  description: z.string().trim().min(1).max(2000),
  markdown: z.string().min(1).max(200000),
  idempotencyKey: z.string().min(1).max(240),
}).strict().superRefine((input, context) => {
  const document = parseFrontmatterMarkdown(input.markdown);
  const metadata = skillFrontmatterSchema.safeParse(document.frontmatter);
  if (!document.hasFrontmatter || !metadata.success || !document.body.trim()
    || metadata.data.name !== input.name || metadata.data.description !== input.description
    || (input.slug !== undefined && input.slug !== input.name)) {
    context.addIssue({ code: "custom", path: ["markdown"], message: "Provide a complete SKILL.md with name and description matching the tool inputs, a nonempty body, and slug equal to name when supplied." });
  }
});

/** Use the same API and company skill policy as Skill Studio. */
export async function callCreateSkillTool(input: {
  arguments: Record<string, unknown>; apiUrl: string; token: string; companyId: string;
}, fetcher: typeof fetch = fetch) {
  const body = createSkillToolInput.parse(input.arguments);
  const response = await fetcher(`${input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api/companies/${encodeURIComponent(input.companyId)}/skills`, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Skill creation failed (${response.status})`);
  return { id: result.id, name: result.name, slug: result.slug, description: result.description,
    versionId: result.currentVersionId, studioPath: `/skills/studio/${encodeURIComponent(result.id)}` };
}
