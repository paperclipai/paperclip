import type { ScopeGuardManifest } from "./manifest.js";
import type { ScopeGuardRule } from "./taxonomy.js";

const TIER_LABEL: Record<string, string> = {
  hard: "Hard-enforced",
  "post-hoc": "Post-hoc detected",
  advisory: "Advisory",
};

function renderRule(rule: ScopeGuardRule): string {
  const tierLabel = TIER_LABEL[rule.tier] ?? rule.tier;
  const parts: string[] = [];

  switch (rule.class) {
    case "git.no_merge": {
      const branches = rule.protectedBranches?.length
        ? ` (protected: ${rule.protectedBranches.join(", ")})`
        : "";
      parts.push(`Do not merge${branches}`);
      break;
    }
    case "git.no_push": {
      const remotes = rule.remotes?.length ? ` to ${rule.remotes.join(", ")}` : "";
      parts.push(`Do not push${remotes}`);
      break;
    }
    case "git.no_force_push": {
      const remotes = rule.remotes?.length ? ` to ${rule.remotes.join(", ")}` : "";
      parts.push(`Do not force-push${remotes}`);
      break;
    }
    case "git.protected_branch":
      parts.push(`Do not commit directly to: ${rule.protectedBranches.join(", ")}`);
      break;
    case "git.no_remote_change":
      parts.push("Do not modify git remotes");
      break;
    case "fs.no_touch_path":
      parts.push(`Do not modify: ${rule.paths.join(", ")}`);
      break;
    case "fs.repo_isolation": {
      const allowed = rule.allowedPaths?.length
        ? ` (allowed: ${rule.allowedPaths.join(", ")})`
        : "";
      parts.push(`Repo isolation — do not modify files outside the worktree${allowed}`);
      break;
    }
    case "protocol.telegram_reply":
      parts.push("Replies must use the `[telegram:reply]` protocol");
      break;
    case "protocol.comment_format": {
      const tag = rule.requiredReviewerTag ? ` — must tag ${rule.requiredReviewerTag}` : "";
      parts.push(`Comment format required${tag}`);
      break;
    }
    case "interaction.no_blocking_tools": {
      const tools = rule.tools?.length ? ` (${rule.tools.join(", ")})` : "";
      parts.push(`Do not call blocking tools${tools}`);
      break;
    }
    case "interaction.no_cross_company_comment":
      parts.push("Do not comment on issues outside this company");
      break;
    case "secrets.no_credential_read": {
      const paths = rule.paths?.length ? ` (${rule.paths.join(", ")})` : "";
      parts.push(`Do not read credentials${paths}`);
      break;
    }
    case "time.budget_cap":
      parts.push(`Finish within ${rule.heartbeats} heartbeat${rule.heartbeats === 1 ? "" : "s"}`);
      break;
    default: {
      const _exhaustive: never = rule;
      parts.push(`Unknown rule: ${JSON.stringify(_exhaustive)}`);
    }
  }

  return `- **${tierLabel}** — ${parts.join("; ")}`;
}

export function renderHuman(manifest: ScopeGuardManifest): string {
  if (manifest.rules.length === 0) {
    return "## Scope guard\n\n_No scope guards active for this issue._\n";
  }

  const lines: string[] = ["## Scope guard", ""];

  const byTier: { hard: ScopeGuardRule[]; "post-hoc": ScopeGuardRule[]; advisory: ScopeGuardRule[] } = {
    hard: [],
    "post-hoc": [],
    advisory: [],
  };

  for (const rule of manifest.rules) {
    if (rule.tier in byTier) {
      byTier[rule.tier as keyof typeof byTier].push(rule);
    }
  }

  if (byTier.hard.length > 0) {
    lines.push("### Hard-enforced");
    lines.push("");
    for (const rule of byTier.hard) {
      lines.push(renderRule(rule));
    }
    lines.push("");
  }

  if (byTier["post-hoc"].length > 0) {
    lines.push("### Post-hoc detected");
    lines.push("");
    for (const rule of byTier["post-hoc"]) {
      lines.push(renderRule(rule));
    }
    lines.push("");
  }

  if (byTier.advisory.length > 0) {
    lines.push("### Advisory");
    lines.push("");
    for (const rule of byTier.advisory) {
      lines.push(renderRule(rule));
    }
    lines.push("");
  }

  lines.push(`_Manifest v${manifest.version} · generated ${manifest.generatedAt}_`);
  lines.push("");

  return lines.join("\n");
}
