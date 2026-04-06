import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyVault } from "@paperclipai/db";
import { notFound } from "../errors.js";

// ---------------------------------------------------------------------------
// Secret detection patterns
// ---------------------------------------------------------------------------

interface SecretPattern {
  label: string;
  category: "api_key" | "password" | "llm_key" | "token" | "other";
  /** Regex to match the secret value */
  regex: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // OpenAI API keys
  { label: "OpenAI API Key", category: "llm_key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  // Anthropic API keys
  { label: "Anthropic API Key", category: "llm_key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  // Google AI / Gemini keys
  { label: "Google API Key", category: "llm_key", regex: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  // GitHub tokens
  { label: "GitHub Token", category: "token", regex: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/g },
  // AWS access keys
  { label: "AWS Access Key", category: "api_key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  // AWS secret keys (40 chars base64)
  { label: "AWS Secret Key", category: "api_key", regex: /\b[A-Za-z0-9/+=]{40}\b/g },
  // Generic Bearer tokens
  { label: "Bearer Token", category: "token", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g },
  // Slack tokens
  { label: "Slack Token", category: "token", regex: /\bxox[bpors]-[A-Za-z0-9-]{10,}\b/g },
  // Stripe keys
  { label: "Stripe Key", category: "api_key", regex: /\b(sk|pk|rk)_(test|live)_[A-Za-z0-9]{20,}\b/g },
  // SendGrid keys
  { label: "SendGrid API Key", category: "api_key", regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  // Twilio
  { label: "Twilio Token", category: "api_key", regex: /\bSK[0-9a-fA-F]{32}\b/g },
  // Generic passwords in key=value patterns
  { label: "Password", category: "password", regex: /(?:password|passwd|pwd|secret|api_key|apikey|api_secret|access_token|auth_token)\s*[=:]\s*["']?([^\s"']{8,})["']?/gi },
  // Generic long hex strings (likely tokens)
  { label: "Hex Token", category: "token", regex: /\b[0-9a-f]{40,}\b/gi },
];

interface DetectedSecret {
  label: string;
  category: string;
  secretValue: string;
  maskedPreview: string;
  startIndex: number;
  endIndex: number;
}

/**
 * Mask a secret value for display, showing only first and last few characters.
 */
function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  const prefix = value.slice(0, 4);
  const suffix = value.slice(-4);
  return `${prefix}...${suffix}`;
}

/**
 * Scan text for secrets and return detected matches.
 */
export function detectSecrets(text: string): DetectedSecret[] {
  const detected: DetectedSecret[] = [];
  const seenValues = new Set<string>();

  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      // For patterns with capture groups (like password=value), use the group
      const secretValue = match[1] ?? match[0];
      if (seenValues.has(secretValue)) continue;
      seenValues.add(secretValue);

      detected.push({
        label: pattern.label,
        category: pattern.category,
        secretValue,
        maskedPreview: maskSecret(secretValue),
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
    }
  }

  return detected;
}

/**
 * Replace detected secrets in text with masked versions.
 */
export function redactSecrets(text: string, secrets: DetectedSecret[]): string {
  if (secrets.length === 0) return text;
  let redacted = text;
  // Sort by startIndex descending so replacements don't shift indices
  const sorted = [...secrets].sort((a, b) => b.startIndex - a.startIndex);
  for (const secret of sorted) {
    const before = redacted.slice(0, secret.startIndex);
    const after = redacted.slice(secret.endIndex);
    redacted = before + `\`[REDACTED: ${secret.maskedPreview}]\`` + after;
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function companyVaultService(db: Db) {
  return {
    /** List all vault entries for a company */
    list: async (companyId: string) => {
      return db
        .select()
        .from(companyVault)
        .where(eq(companyVault.companyId, companyId))
        .orderBy(desc(companyVault.createdAt));
    },

    /** Get a single vault entry (secret value excluded by default) */
    getById: async (companyId: string, id: string) => {
      const [entry] = await db
        .select()
        .from(companyVault)
        .where(and(eq(companyVault.id, id), eq(companyVault.companyId, companyId)));
      if (!entry) throw notFound("Vault entry not found");
      return entry;
    },

    /** Add a secret to the vault manually */
    addManual: async (companyId: string, data: {
      label: string;
      category: string;
      secretValue: string;
      addedBy?: string;
    }) => {
      const [entry] = await db
        .insert(companyVault)
        .values({
          companyId,
          label: data.label,
          category: data.category,
          secretValue: data.secretValue,
          maskedPreview: maskSecret(data.secretValue),
          source: "manual",
          addedBy: data.addedBy,
        })
        .returning();
      return entry;
    },

    /** Store secrets detected from a comment, returning the redacted comment body */
    processComment: async (
      companyId: string,
      commentId: string,
      issueId: string,
      body: string,
      authorId?: string,
    ): Promise<{ redactedBody: string; secretsFound: number }> => {
      const secrets = detectSecrets(body);
      if (secrets.length === 0) {
        return { redactedBody: body, secretsFound: 0 };
      }

      // Store each detected secret in the vault
      for (const secret of secrets) {
        await db.insert(companyVault).values({
          companyId,
          label: secret.label,
          category: secret.category,
          secretValue: secret.secretValue,
          maskedPreview: secret.maskedPreview,
          source: "comment",
          sourceCommentId: commentId,
          sourceIssueId: issueId,
          addedBy: authorId,
        });
      }

      const redactedBody = redactSecrets(body, secrets);
      return { redactedBody, secretsFound: secrets.length };
    },

    /** Find vault entries by label or category (for agent auto-lookup) */
    findByLabelOrCategory: async (companyId: string, query: { label?: string; category?: string }) => {
      const conditions = [eq(companyVault.companyId, companyId)];
      if (query.label) {
        conditions.push(sql`LOWER(${companyVault.label}) LIKE LOWER(${'%' + query.label + '%'})`);
      }
      if (query.category) {
        conditions.push(eq(companyVault.category, query.category));
      }
      return db
        .select()
        .from(companyVault)
        .where(and(...conditions))
        .orderBy(desc(companyVault.createdAt));
    },

    /** Delete a vault entry */
    remove: async (companyId: string, id: string) => {
      const [deleted] = await db
        .delete(companyVault)
        .where(and(eq(companyVault.id, id), eq(companyVault.companyId, companyId)))
        .returning();
      if (!deleted) throw notFound("Vault entry not found");
      return deleted;
    },
  };
}
