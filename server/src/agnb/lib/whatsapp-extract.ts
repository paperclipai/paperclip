/**
 * WhatsApp work-item classifier — ported from agnb lib/agnb/whatsapp-extract.ts.
 * Gemini Flash, JSON-forced, thinkingBudget 0. The gemini-json helper is
 * inlined here (the agnb version lived in a separate `server-only` module).
 *
 * Requires GEMINI_API_KEY. Throws if missing — callers should catch.
 */

export interface WhatsAppExtraction {
  is_task: boolean;
  title: string | null;
  /** Free-text name or @mention the message points work at, if any. */
  assignee_hint: string | null;
  /** 1=urgent .. 5=low */
  priority: number;
  /** Free-text due hint ("Friday", "EOD", "next week") — not parsed to date. */
  due_hint: string | null;
}

export function geminiConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

async function geminiJson<T>(prompt: string, opts?: { temperature?: number; maxTokens?: number }): Promise<T> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: opts?.temperature ?? 0.7,
          maxOutputTokens: opts?.maxTokens ?? 2000,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) throw new Error(`gemini http ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("gemini returned empty text");
  return JSON.parse(text) as T;
}

/**
 * Classify a WhatsApp group message: is it a work assignment? If yes,
 * extract a crisp title + assignee hint + priority + due hint.
 * Conservative — most group chatter is NOT a task.
 */
export async function extractWhatsAppWork(input: {
  body: string;
  senderName?: string;
  groupName?: string;
  knownMembers?: string[];
}): Promise<WhatsAppExtraction> {
  const members = input.knownMembers?.length
    ? `\nKnown team members (resolve @mentions / names to these): ${input.knownMembers.join(", ")}`
    : "";
  const prompt = `You triage a sales/GTM team's WhatsApp group messages into work items.

Message from "${input.senderName ?? "unknown"}" in group "${input.groupName ?? "team"}":
"""
${input.body.slice(0, 1000)}
"""${members}

Decide: is this a concrete work assignment or action item someone must DO?
- YES: "Sara handle the Acme renewal call", "can someone draft the Q3 deck by Fri", "@Raj follow up with the Frinks lead"
- NO: greetings, status updates, jokes, questions without an action, "thanks", "ok", links with no task

Return JSON:
{
  "is_task": boolean,
  "title": "imperative task title (<=80 chars)" | null,
  "assignee_hint": "name or @mention the task is aimed at" | null,
  "priority": 1-5 (1=urgent, 3=normal, 5=low),
  "due_hint": "raw due phrase like 'Friday' / 'EOD' / 'next week'" | null
}

If is_task is false, set title/assignee_hint/due_hint to null and priority to 3.`;

  try {
    const out = await geminiJson<WhatsAppExtraction>(prompt, { temperature: 0.2, maxTokens: 400 });
    return {
      is_task: !!out.is_task,
      title: out.title ?? null,
      assignee_hint: out.assignee_hint ?? null,
      priority: Math.min(5, Math.max(1, Number(out.priority) || 3)),
      due_hint: out.due_hint ?? null,
    };
  } catch {
    // On Gemini failure, log message but don't create a task
    return { is_task: false, title: null, assignee_hint: null, priority: 3, due_hint: null };
  }
}
