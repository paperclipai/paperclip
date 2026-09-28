// Reads the Meta API key out of a Muse `auth.json` written with
// TBH_CREDENTIAL_BACKEND=file. Only the key is ever returned; the file's OAuth
// access token and identity fields are ignored.

const MUSE_API_KEY_RE = /^LLM\|[A-Za-z0-9_\-|]{20,200}$/;

export function parseMuseAuthApiKey(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const providers = (parsed as Record<string, unknown>).providers;
  if (typeof providers !== "object" || providers === null) return null;
  const meta = (providers as Record<string, unknown>).meta;
  if (typeof meta !== "object" || meta === null) return null;
  const key = (meta as Record<string, unknown>).api_key;
  return typeof key === "string" && MUSE_API_KEY_RE.test(key) ? key : null;
}
