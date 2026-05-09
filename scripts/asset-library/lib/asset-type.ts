export type AssetKind =
  | "video"
  | "image"
  | "markdown"
  | "text"
  | "pdf"
  | "html"
  | "unknown";

export type IssueDocument = {
  id: string;
  companyId: string;
  issueId: string;
  key: string;
  title: string | null;
  format: string | null;
  body: string;
  latestRevisionId?: string;
  latestRevisionNumber?: number;
  createdAt: string;
  updatedAt: string;
};

const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg|avif)$/i;
const PDF_EXT = /\.pdf$/i;
const HTML_EXT = /\.html?$/i;
const MD_EXT = /\.(md|markdown)$/i;
const TXT_EXT = /\.(txt|log)$/i;

export function detectKind(doc: Pick<IssueDocument, "key" | "format" | "body">): AssetKind {
  const k = doc.key ?? "";
  if (VIDEO_EXT.test(k)) return "video";
  if (IMAGE_EXT.test(k)) return "image";
  if (PDF_EXT.test(k)) return "pdf";
  if (HTML_EXT.test(k)) return "html";
  if (MD_EXT.test(k)) return "markdown";
  if (TXT_EXT.test(k)) return "text";

  const f = (doc.format ?? "").toLowerCase();
  if (f === "video" || f === "mp4" || f === "webm") return "video";
  if (f === "image" || f === "png" || f === "jpeg" || f === "webp") return "image";
  if (f === "pdf") return "pdf";
  if (f === "html") return "html";
  if (f === "markdown" || f === "md") return "markdown";
  if (f === "text" || f === "txt") return "text";

  // Body heuristics — data URL or raw URL pointing at a known type.
  const b = (doc.body ?? "").trim();
  if (b.startsWith("data:video/")) return "video";
  if (b.startsWith("data:image/")) return "image";
  if (b.startsWith("data:application/pdf")) return "pdf";
  if (b.startsWith("data:text/html")) return "html";
  const firstLine = b.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (/^https?:\/\/\S+$/i.test(firstLine)) {
    if (VIDEO_EXT.test(firstLine)) return "video";
    if (IMAGE_EXT.test(firstLine)) return "image";
    if (PDF_EXT.test(firstLine)) return "pdf";
  }
  return "markdown";
}

const DATA_URL_RE = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i;
const ABS_URL_RE = /^https?:\/\/\S+$/i;
const REL_PATH_RE = /^\/[A-Za-z0-9._\-/]+\.[A-Za-z0-9]+$/;

export function resolveAssetSrc(body: string): string | null {
  if (!body) return null;
  const trimmed = body.trim();
  if (DATA_URL_RE.test(trimmed)) return trimmed;
  if (ABS_URL_RE.test(trimmed)) return trimmed;
  if (REL_PATH_RE.test(trimmed)) return trimmed;
  // First non-empty line might be a URL surrounded by markdown noise.
  const firstUrl = trimmed.match(/(https?:\/\/\S+)/);
  if (firstUrl) return firstUrl[1];
  return null;
}

export type ProvenanceKind =
  | "local-ai"
  | "founder-original"
  | "cloud-ai-exception"
  | "missing"
  | "unknown";

export type Provenance = {
  kind: ProvenanceKind;
  tool: string | null;
  model: string | null;
  prompt: string | null;
  config: string | null;
  seed: string | null;
  workflowRef: string | null;
  raw: Record<string, string>;
};

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/;
const KV_RE = /^([A-Za-z][A-Za-z0-9_\-]*)\s*[:=]\s*(.*)$/;

function parseFrontmatter(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body) return out;
  const m = body.match(FRONTMATTER_RE);
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(KV_RE);
    if (!kv) continue;
    const key = kv[1].toLowerCase().replace(/-/g, "_");
    let val = kv[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function parseInlineProvenance(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body) return out;
  // Look for "**Provenance:**" / "Provenance:" block style metadata.
  const lines = body.split(/\r?\n/);
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.replace(/^[-*]\s+/, "").replace(/\*\*/g, "");
    if (/^provenance\s*[:]/i.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line.trim() === "") {
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;
    const kv = line.match(KV_RE);
    if (!kv) {
      inBlock = false;
      continue;
    }
    const key = kv[1].toLowerCase().replace(/-/g, "_");
    out[key] = kv[2].trim();
  }
  return out;
}

export function parseProvenance(
  doc: Pick<IssueDocument, "body"> & { metadata?: unknown },
): Provenance {
  const fromMeta =
    doc.metadata && typeof doc.metadata === "object"
      ? (doc.metadata as Record<string, unknown>)
      : {};
  const fm = parseFrontmatter(doc.body ?? "");
  const inline = parseInlineProvenance(doc.body ?? "");

  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(fromMeta)) {
    if (typeof v === "string") flat[k.toLowerCase().replace(/-/g, "_")] = v;
  }
  // Also drill into metadata.provenance if it's an object.
  const provNested = (fromMeta as Record<string, unknown>)["provenance"];
  if (provNested && typeof provNested === "object") {
    for (const [k, v] of Object.entries(provNested as Record<string, unknown>)) {
      if (typeof v === "string") {
        const key = k.toLowerCase().replace(/-/g, "_");
        flat[key] = flat[key] ?? v;
      }
    }
  }
  for (const [k, v] of Object.entries(fm)) flat[k] = flat[k] ?? v;
  for (const [k, v] of Object.entries(inline)) flat[k] = flat[k] ?? v;

  const kindRaw = (flat["provenance_kind"] ?? "").toLowerCase();
  let kind: ProvenanceKind = "missing";
  if (kindRaw === "local-ai" || kindRaw === "local_ai" || kindRaw === "local") {
    kind = "local-ai";
  } else if (kindRaw === "founder-original" || kindRaw === "founder_original") {
    kind = "founder-original";
  } else if (
    kindRaw === "cloud-ai-exception" ||
    kindRaw === "cloud_ai_exception" ||
    kindRaw === "cloud-exception"
  ) {
    kind = "cloud-ai-exception";
  } else if (kindRaw) {
    kind = "unknown";
  }

  return {
    kind,
    tool: flat["tool"] ?? null,
    model: flat["model"] ?? null,
    prompt: flat["prompt"] ?? null,
    config: flat["config"] ?? null,
    seed: flat["seed"] ?? null,
    workflowRef: flat["workflow_ref"] ?? flat["workflow"] ?? null,
    raw: flat,
  };
}

// Cloud-API tools forbidden by founder hard policy. Case-insensitive partial match.
export const CLOUD_TOOL_PATTERNS: readonly string[] = [
  "runway",
  "pika",
  "sora",
  "heygen",
  "synthesia",
  "midjourney",
  "dall-e",
  "dall e",
  "dalle",
  "elevenlabs",
  "eleven labs",
  "suno",
  "udio",
];

// Stock-library filename patterns — mirrored from lib/forbidden-source-scan
// for client/server reuse without pulling exifr into the bundle.
export const STOCK_FILENAME_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: "shutterstock_<digits>", regex: /shutterstock_\d+\.(jpe?g|png|mp4|mov|webp)$/i },
  { label: "GettyImages-<digits>", regex: /GettyImages-\d+/i },
  { label: "AdobeStock_<digits>", regex: /AdobeStock_\d+/i },
];

export function detectCloudTool(toolValue: string | null): string | null {
  if (!toolValue) return null;
  const t = toolValue.toLowerCase();
  for (const pat of CLOUD_TOOL_PATTERNS) {
    if (t.includes(pat)) return pat;
  }
  return null;
}

export function detectStockFilename(filename: string): { label: string } | null {
  const base = filename.split("/").pop() ?? filename;
  for (const rule of STOCK_FILENAME_PATTERNS) {
    if (rule.regex.test(base)) return { label: rule.label };
  }
  return null;
}

export type ApprovalGateStatus =
  | "ok"
  | "missing"
  | "cloud"
  | "cloud-with-exception"
  | "stock"
  | "exception-pending"
  | "exception-invalid";

export type ExceptionRef = {
  identifier: string;
  status: string | null;
  title: string | null;
  valid: boolean;
  reason?: string;
};

export type ApprovalGate = {
  allowed: boolean;
  status: ApprovalGateStatus;
  banner: string | null;
  bannerTone: "ok" | "warn" | "block";
  exceptionRequired: string | null;
  cloudPattern: string | null;
  stockPattern: string | null;
};

export function evaluateApprovalGate(
  prov: Provenance,
  docKey: string,
  exception: ExceptionRef | null,
): ApprovalGate {
  // Hard block 3 — stock library (no override).
  const stock = detectStockFilename(docKey);
  if (stock) {
    return {
      allowed: false,
      status: "stock",
      banner: "Stock-library asset detected — forbidden",
      bannerTone: "block",
      exceptionRequired: null,
      cloudPattern: null,
      stockPattern: stock.label,
    };
  }

  // Hard block 1 — missing provenance.
  if (prov.kind === "missing" || prov.kind === "unknown") {
    return {
      allowed: false,
      status: "missing",
      banner: "Cannot approve — missing provenance metadata",
      bannerTone: "block",
      exceptionRequired: null,
      cloudPattern: null,
      stockPattern: null,
    };
  }

  // Hard block 2 — cloud-API tool.
  const cloudHit = detectCloudTool(prov.tool);
  const exceptionId = prov.raw["exception_issue_id"] ?? prov.raw["exception"] ?? null;
  if (cloudHit) {
    if (!exceptionId) {
      return {
        allowed: false,
        status: "cloud",
        banner: "Cloud-generated assets are forbidden — re-run on the local stack",
        bannerTone: "block",
        exceptionRequired: null,
        cloudPattern: cloudHit,
        stockPattern: null,
      };
    }
    if (!exception) {
      return {
        allowed: false,
        status: "exception-pending",
        banner: `Cloud waiver lookup pending — verifying ${exceptionId}`,
        bannerTone: "warn",
        exceptionRequired: exceptionId,
        cloudPattern: cloudHit,
        stockPattern: null,
      };
    }
    if (!exception.valid) {
      return {
        allowed: false,
        status: "exception-invalid",
        banner: `Cloud waiver ${exception.identifier} is invalid — needs status:done + [tool-exception] in title (current: ${exception.status ?? "unknown"})`,
        bannerTone: "block",
        exceptionRequired: exceptionId,
        cloudPattern: cloudHit,
        stockPattern: null,
      };
    }
    return {
      allowed: true,
      status: "cloud-with-exception",
      banner: `Cloud exception — waiver ${exception.identifier} granted. Approve?`,
      bannerTone: "warn",
      exceptionRequired: exceptionId,
      cloudPattern: cloudHit,
      stockPattern: null,
    };
  }

  return {
    allowed: true,
    status: "ok",
    banner: null,
    bannerTone: "ok",
    exceptionRequired: null,
    cloudPattern: null,
    stockPattern: null,
  };
}
