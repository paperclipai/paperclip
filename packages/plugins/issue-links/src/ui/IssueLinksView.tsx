import { useHostContext, usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { useRef, useState } from "react";

type IssueLinksData = {
  localPath: string | null;
  githubPrUrl: string | null;
};

type PluginConfig = {
  openWith?: "vscode" | "finder";
};

/**
 * Parses a GitHub PR URL into a short display label.
 * https://github.com/org/repo/pull/123 → "org/repo#123"
 * Returns null if parsing fails (caller should fall back to raw URL).
 */
function parseGithubPrUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;
    // pathname: /org/repo/pull/123
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 4 || parts[2] !== "pull") return null;
    const [org, repo, , number] = parts;
    return `${org}/${repo}#${number}`;
  } catch {
    return null;
  }
}

function buildOpenWithHref(path: string, openWith: "vscode" | "finder"): string {
  if (openWith === "vscode") {
    return `vscode://file${encodeURI(path)}`;
  }
  return `file://${encodeURI(path)}`;
}

type LinkRowProps = {
  label: string;
  value: string | null;
  placeholder: string;
  displayValue: (value: string) => string;
  href: (value: string) => string;
  openInNewTab: boolean;
  onSave: (value: string | null) => Promise<void>;
};

function LinkRow({ label, value, placeholder, displayValue, href, openInNewTab, onSave }: LinkRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  function startEdit() {
    cancelledRef.current = false;
    setDraft(value ?? "");
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function commitEdit() {
    if (saving || cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    setSaving(true);
    try {
      const trimmed = draft.trim();
      await onSave(trimmed === "" ? null : trimmed);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  function cancelEdit() {
    cancelledRef.current = true;
    setEditing(false);
  }

  return (
    <div className="flex items-start gap-3 py-1 min-h-[28px]">
      <span className="w-[120px] shrink-0 text-xs font-medium text-muted-foreground pt-0.5">{label}</span>
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            className="w-full rounded border border-input bg-background px-2 py-0.5 text-xs text-foreground outline-none focus:border-ring"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitEdit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void commitEdit(); }
              if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
            }}
            disabled={saving}
          />
        ) : value ? (
          <div className="flex items-center gap-1 min-w-0">
            <a
              href={href(value)}
              {...(openInNewTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              className="text-xs text-primary hover:underline truncate"
              title={value}
              onClick={openInNewTab ? undefined : (e) => { e.preventDefault(); window.location.href = href(value); }}
            >
              {displayValue(value)}
            </a>
            <button
              type="button"
              className="shrink-0 text-xs text-muted-foreground/40 hover:text-muted-foreground transition-colors"
              onClick={startEdit}
              title="Edit"
            >
              ✎
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            onClick={startEdit}
          >
            {placeholder}
          </button>
        )}
      </div>
    </div>
  );
}

export function IssueLinksView() {
  const { entityId: issueId, companyId } = useHostContext();

  const { data: links, loading: linksLoading } = usePluginData<IssueLinksData>("issue-links", {
    issueId,
    companyId,
  });

  const { data: config } = usePluginData<PluginConfig>("plugin-config", {});

  const setLocalPath = usePluginAction("set-local-path");
  const setGithubPrUrl = usePluginAction("set-github-pr-url");

  const openWith = config?.openWith ?? "vscode";

  if (!issueId) return null;

  if (linksLoading) {
    return (
      <div className="space-y-1 py-1">
        <div className="flex items-start gap-3 min-h-[28px]">
          <div className="w-[120px] h-3 rounded bg-muted animate-pulse mt-0.5" />
          <div className="flex-1 h-3 rounded bg-muted animate-pulse mt-0.5" />
        </div>
        <div className="flex items-start gap-3 min-h-[28px]">
          <div className="w-[120px] h-3 rounded bg-muted animate-pulse mt-0.5" />
          <div className="flex-1 h-3 rounded bg-muted animate-pulse mt-0.5" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      <LinkRow
        label="Local Path"
        value={links?.localPath ?? null}
        placeholder="Add path…"
        displayValue={(v) => v}
        href={(v) => buildOpenWithHref(v, openWith)}
        openInNewTab={false}
        onSave={async (value) => {
          await setLocalPath({ issueId, companyId, value });
        }}
      />
      <LinkRow
        label="GitHub PR"
        value={links?.githubPrUrl ?? null}
        placeholder="Add PR…"
        displayValue={(v) => parseGithubPrUrl(v) ?? v}
        href={(v) => v}
        openInNewTab={true}
        onSave={async (value) => {
          await setGithubPrUrl({ issueId, companyId, value });
        }}
      />
    </div>
  );
}
