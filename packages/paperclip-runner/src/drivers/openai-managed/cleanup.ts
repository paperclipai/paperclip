import { isOpenAiRemoteSessionId } from "./identity.js";
/** Qualification sessions have no coding deliverables. Refuse deletion if an
 * unexpected artifact needs preservation; callers record cleanup as unconfirmed. */
export async function deleteOpenAiQualificationSession(sessionId: string, apiKey: string): Promise<void> {
  if (!isOpenAiRemoteSessionId(sessionId) || !apiKey.trim()) throw new Error("OpenAI cleanup requires a verified session and credential");
  const endpoint = `https://api.openai.com/v1/agents/sessions/${sessionId}`;
  const request = async (url: string, method = "GET") => fetch(url, {
    method, redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${apiKey}`, "OpenAI-Beta": "agents=v1" },
  });
  const listed = await request(`${endpoint}/artifacts?limit=1`);
  if (listed.status === 404) return;
  if (!listed.ok) throw new Error(`OpenAI artifact inventory failed with HTTP ${listed.status}`);
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of listed.body ?? []) {
    size += chunk.length;
    if (size > 64_000) throw new Error("OpenAI cleanup inventory exceeds limit");
    chunks.push(chunk);
  }
  const inventory = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(inventory.data) || inventory.data.length > 0 || inventory.has_more !== false) throw new Error("OpenAI session retained: unexpected artifacts must be downloaded before deletion");
  for (let attempt = 0; attempt < 3; attempt++) {
    const deleted = await request(endpoint, "DELETE");
    if (deleted.ok || deleted.status === 404) return;
    if (deleted.status !== 409) throw new Error(`OpenAI session deletion failed with HTTP ${deleted.status}`);
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw new Error("OpenAI session deletion remains pending after three attempts");
}
