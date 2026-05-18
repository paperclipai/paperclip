const ULID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function deriveCompanySlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "company";
}

export function deriveNamespaceName(prefix: string, slug: string): string {
  return `${prefix}${slug}`;
}

export function newRunUlidDns(now: () => number = Date.now): string {
  const timestamp = now();
  let out = "";
  let t = timestamp;
  for (let i = 0; i < 10; i++) {
    out = ULID_ALPHABET[t & 0x1f] + out;
    t = Math.floor(t / 32);
  }
  for (let i = 0; i < 16; i++) {
    out += ULID_ALPHABET[Math.floor(Math.random() * 32)];
  }
  return out;
}

export interface LabelsInput {
  runId: string;
  agentId: string;
  companyId: string;
  adapterType: string;
}

export function paperclipLabels(input: LabelsInput): Record<string, string> {
  return {
    "paperclip.io/run-id": input.runId,
    "paperclip.io/agent-id": input.agentId,
    "paperclip.io/company-id": input.companyId,
    "paperclip.io/adapter": input.adapterType,
    "paperclip.io/managed-by": "paperclip-k8s-plugin",
  };
}
