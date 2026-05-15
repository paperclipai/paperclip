const PAPERCLIP_API_URL = Deno.env.get("PAPERCLIP_API_URL") ?? "";
const CHASE_API_KEY = Deno.env.get("CHASE_PAPERCLIP_API_KEY") ?? "";
const COMPANY_ID = Deno.env.get("PAPERCLIP_COMPANY_ID") ?? "";

function paperclipHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${CHASE_API_KEY}`,
    "Content-Type": "application/json",
  };
}

export async function paperclipGet<T>(path: string): Promise<T> {
  const url = `${PAPERCLIP_API_URL}${path}`;
  const res = await fetch(url, { headers: paperclipHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Paperclip API ${res.status} for ${path}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function paperclipPost<T>(path: string, body: unknown): Promise<T> {
  const url = `${PAPERCLIP_API_URL}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: paperclipHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Paperclip API ${res.status} for POST ${path}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function paperclipPut<T>(path: string, body: unknown): Promise<T> {
  const url = `${PAPERCLIP_API_URL}${path}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: paperclipHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Paperclip API ${res.status} for PUT ${path}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function paperclipDelete(path: string): Promise<void> {
  const url = `${PAPERCLIP_API_URL}${path}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: paperclipHeaders(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Paperclip API ${res.status} for DELETE ${path}: ${text}`);
  }
}

export function isPaperclipConfigured(): boolean {
  return !!(PAPERCLIP_API_URL && CHASE_API_KEY && COMPANY_ID);
}

export { PAPERCLIP_API_URL, CHASE_API_KEY, COMPANY_ID };
