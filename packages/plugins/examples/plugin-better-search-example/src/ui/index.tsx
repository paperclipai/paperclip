import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import type { Preset, SearchResult } from "../worker.js";

// Cross-slot bridge: toolbar buttons write a pending preset here; the sidebar
// panel reads it on mount and auto-applies it, then clears the key.
const PENDING_PRESET_KEY = "bse-pending-preset";

type SearchData = {
  results: SearchResult[];
  query: string;
  error?: string;
};

type PresetsData = {
  presets: Preset[];
};

type AuthorFilter = "all" | "human" | "agent";

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  padding: "8px",
  fontSize: "13px",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  borderRadius: "6px",
  border: "1px solid var(--border)",
  background: "var(--background)",
  color: "var(--foreground)",
  fontSize: "13px",
  boxSizing: "border-box",
  outline: "none",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  gap: "4px",
  flexWrap: "wrap",
};

function chipStyle(active: boolean): CSSProperties {
  return {
    padding: "2px 8px",
    borderRadius: "12px",
    border: `1px solid ${active ? "var(--primary, #6366f1)" : "var(--border)"}`,
    background: active ? "var(--primary, #6366f1)" : "transparent",
    color: active ? "var(--primary-foreground, #fff)" : "var(--foreground)",
    cursor: "pointer",
    fontSize: "11px",
    fontWeight: active ? 600 : 400,
  };
}

const resultListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  maxHeight: "420px",
  overflowY: "auto",
};

function resultItemStyle(hovered: boolean): CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "6px 8px",
    borderRadius: "6px",
    background: hovered
      ? "color-mix(in srgb, var(--accent, #6366f1) 15%, transparent)"
      : "transparent",
    cursor: "pointer",
    textDecoration: "none",
    color: "inherit",
    border: "1px solid transparent",
    transition: "background 0.1s",
  };
}

function authorBadgeStyle(type: SearchResult["latestAuthorType"]): CSSProperties {
  const colors: Record<SearchResult["latestAuthorType"], { bg: string; color: string }> = {
    human: { bg: "color-mix(in srgb, #22c55e 20%, transparent)", color: "#15803d" },
    agent: { bg: "color-mix(in srgb, #6366f1 20%, transparent)", color: "#4338ca" },
    unknown: { bg: "color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--muted-foreground)" },
  };
  const { bg, color } = colors[type];
  return {
    display: "inline-block",
    padding: "1px 5px",
    borderRadius: "4px",
    background: bg,
    color,
    fontSize: "10px",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
  };
}

const statusDotColors: Record<string, string> = {
  done: "#22c55e",
  cancelled: "#94a3b8",
  in_progress: "#6366f1",
  in_review: "#f59e0b",
  blocked: "#ef4444",
  todo: "#64748b",
  backlog: "#94a3b8",
};

function StatusDot({ status }: { status: string }) {
  const color = statusDotColors[status] ?? "#94a3b8";
  return (
    <span
      style={{
        display: "inline-block",
        width: "7px",
        height: "7px",
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        marginTop: "1px",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Result row
// ---------------------------------------------------------------------------

function ResultRow({
  result,
  issuesPath,
}: {
  result: SearchResult;
  issuesPath: (id: string) => string;
}) {
  const [hovered, setHovered] = useState(false);
  const authorLabel =
    result.latestAuthorType === "human"
      ? "Human"
      : result.latestAuthorType === "agent"
      ? "AI"
      : "?";

  return (
    <a
      href={issuesPath(result.identifier ?? result.id)}
      style={resultItemStyle(hovered)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: "6px" }}>
        <StatusDot status={result.status} />
        <span
          style={{
            flex: 1,
            fontWeight: 500,
            lineHeight: "1.3",
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical" as const,
          }}
        >
          {result.title}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "6px", paddingLeft: "13px" }}>
        {result.identifier && (
          <span style={{ color: "var(--muted-foreground)", fontSize: "11px" }}>
            {result.identifier}
          </span>
        )}
        <span style={authorBadgeStyle(result.latestAuthorType)}>{authorLabel}</span>
      </div>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Preset button with inline rename + ⋮ menu
// ---------------------------------------------------------------------------

function PresetButton({
  preset,
  onApply,
  onRename,
  onDelete,
}: {
  preset: Preset;
  onApply: (p: Preset) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(preset.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  // Close menu when clicking outside.
  useEffect(() => {
    if (!menuOpen) return;
    function handleOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirmDelete(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [menuOpen]);

  // Focus rename input when entering rename mode.
  useEffect(() => {
    if (renaming) {
      renameRef.current?.select();
    }
  }, [renaming]);

  function commitRename() {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== preset.name) {
      onRename(preset.id, trimmed);
    }
    setRenaming(false);
  }

  const btnBase: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "0",
    borderRadius: "12px",
    border: "1px solid var(--border)",
    background: "transparent",
    overflow: "hidden",
    flexShrink: 0,
  };

  const labelBtn: CSSProperties = {
    padding: "2px 8px",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: "11px",
    color: "var(--foreground)",
    whiteSpace: "nowrap",
    maxWidth: "100px",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };

  const menuBtn: CSSProperties = {
    padding: "2px 5px",
    background: "transparent",
    border: "none",
    borderLeft: "1px solid var(--border)",
    cursor: "pointer",
    fontSize: "11px",
    color: "var(--muted-foreground)",
    lineHeight: 1,
  };

  const menuStyle: CSSProperties = {
    position: "absolute",
    top: "calc(100% + 2px)",
    left: 0,
    zIndex: 100,
    background: "var(--background)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
    minWidth: "130px",
    overflow: "hidden",
  };

  const menuItemStyle: CSSProperties = {
    display: "block",
    width: "100%",
    padding: "6px 10px",
    background: "transparent",
    border: "none",
    textAlign: "left",
    cursor: "pointer",
    fontSize: "12px",
    color: "var(--foreground)",
  };

  const menuItemDangerStyle: CSSProperties = {
    ...menuItemStyle,
    color: "#ef4444",
  };

  if (renaming) {
    return (
      <input
        ref={renameRef}
        value={renameValue}
        onChange={(e) => setRenameValue(e.target.value)}
        onBlur={commitRename}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitRename();
          if (e.key === "Escape") { setRenaming(false); setRenameValue(preset.name); }
        }}
        style={{
          ...inputStyle,
          width: "auto",
          minWidth: "80px",
          maxWidth: "120px",
          padding: "2px 6px",
          fontSize: "11px",
          borderRadius: "12px",
        }}
      />
    );
  }

  return (
    <div style={{ position: "relative" }} ref={menuRef}>
      <div style={btnBase}>
        <button
          type="button"
          style={labelBtn}
          onClick={() => onApply(preset)}
          title={`Apply preset: ${preset.name}`}
        >
          {preset.name}
        </button>
        <button
          type="button"
          style={menuBtn}
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); setConfirmDelete(false); }}
          title="Preset options"
          aria-label="Preset options"
        >
          ⋮
        </button>
      </div>

      {menuOpen && (
        <div style={menuStyle}>
          <button
            type="button"
            style={menuItemStyle}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "color-mix(in srgb, var(--accent, #6366f1) 10%, transparent)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            onClick={() => { setMenuOpen(false); setRenaming(true); setRenameValue(preset.name); }}
          >
            Rename
          </button>
          {!confirmDelete ? (
            <button
              type="button"
              style={menuItemDangerStyle}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "color-mix(in srgb, #ef4444 10%, transparent)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              onClick={() => setConfirmDelete(true)}
            >
              Delete…
            </button>
          ) : (
            <button
              type="button"
              style={{ ...menuItemDangerStyle, fontWeight: 600 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "color-mix(in srgb, #ef4444 20%, transparent)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              onClick={() => { setMenuOpen(false); setConfirmDelete(false); onDelete(preset.id); }}
            >
              Confirm delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presets row (above results)
// ---------------------------------------------------------------------------

function PresetsRow({
  presets,
  onApply,
  onRename,
  onDelete,
}: {
  presets: Preset[];
  onApply: (p: Preset) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  if (presets.length === 0) {
    return (
      <div
        style={{
          color: "var(--muted-foreground)",
          fontSize: "11px",
          fontStyle: "italic",
          padding: "2px 0",
        }}
      >
        No presets yet — search for something and click "Save as preset".
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        gap: "4px",
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      {presets.map((p) => (
        <PresetButton
          key={p.id}
          preset={p}
          onApply={onApply}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Save-as-preset inline form
// ---------------------------------------------------------------------------

function SavePresetForm({
  defaultName,
  onSave,
  onCancel,
}: {
  defaultName: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.select(); }, []);

  return (
    <div
      style={{
        display: "flex",
        gap: "4px",
        alignItems: "center",
        padding: "4px 0",
      }}
    >
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) onSave(name.trim());
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Preset name…"
        style={{ ...inputStyle, flex: 1, padding: "3px 6px", fontSize: "12px" }}
        autoComplete="off"
      />
      <button
        type="button"
        disabled={!name.trim()}
        onClick={() => { if (name.trim()) onSave(name.trim()); }}
        style={{
          padding: "3px 8px",
          borderRadius: "6px",
          border: "none",
          background: "var(--primary, #6366f1)",
          color: "var(--primary-foreground, #fff)",
          fontSize: "11px",
          cursor: name.trim() ? "pointer" : "not-allowed",
          opacity: name.trim() ? 1 : 0.5,
          flexShrink: 0,
        }}
      >
        Save
      </button>
      <button
        type="button"
        onClick={onCancel}
        style={{
          padding: "3px 6px",
          borderRadius: "6px",
          border: "1px solid var(--border)",
          background: "transparent",
          color: "var(--muted-foreground)",
          fontSize: "11px",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        ✕
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function BetterSearchPanel() {
  const context = useHostContext();
  const [inputValue, setInputValue] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filter, setFilter] = useState<AuthorFilter>("all");

  // Apply any preset that was queued by the inbox toolbar button.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(PENDING_PRESET_KEY);
      if (!raw) return;
      sessionStorage.removeItem(PENDING_PRESET_KEY);
      const preset = JSON.parse(raw) as Preset;
      const q = preset.query ?? "";
      setInputValue(q);
      setDebouncedQuery(q.trim());
      setFilter((preset.filters.authorType as AuthorFilter) ?? "all");
    } catch {
      sessionStorage.removeItem(PENDING_PRESET_KEY);
    }
  }, []);

  // Preset state — loaded from worker on mount, kept in sync via refresh token.
  const [presetsRefresh, setPresetsRefresh] = useState(0);
  const [localPresets, setLocalPresets] = useState<Preset[] | null>(null);
  const [savingPreset, setSavingPreset] = useState(false);

  const savePreset = usePluginAction("savePreset");
  const deletePreset = usePluginAction("deletePreset");

  const companyId = context.companyId ?? "";
  const userId = context.userId ?? "";
  const hasUserContext = !!(companyId && userId);

  // Fetch persisted presets; refresh token forces re-fetch after mutations.
  const presetsData = usePluginData<PresetsData>(
    "getPresets",
    hasUserContext ? { companyId, userId, _r: presetsRefresh } : undefined
  );

  // Seed local state from remote once loaded; don't overwrite pending optimistic updates.
  useEffect(() => {
    if (!presetsData.loading && presetsData.data) {
      setLocalPresets(presetsData.data.presets);
    }
  }, [presetsData.data, presetsData.loading]);

  const presets = localPresets ?? [];

  // Debounce input → query
  useEffect(() => {
    if (!inputValue.trim()) {
      setDebouncedQuery("");
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(inputValue.trim()), 350);
    return () => clearTimeout(timer);
  }, [inputValue]);

  const searchData = usePluginData<SearchData>(
    "searchIssues",
    debouncedQuery && companyId
      ? { companyId, q: debouncedQuery }
      : undefined
  );

  const allResults = searchData.data?.results ?? [];
  const filtered =
    filter === "all"
      ? allResults
      : allResults.filter((r) => r.latestAuthorType === filter);

  function issuesPath(identifier: string): string {
    return context.companyPrefix
      ? `/${context.companyPrefix}/issues/${identifier}`
      : `/issues/${identifier}`;
  }

  const isSearching = searchData.loading && debouncedQuery.length > 0;
  const hasError = !!searchData.error;
  const hasQuery = debouncedQuery.length > 0;
  const canSavePreset = hasUserContext && (hasQuery || filter !== "all");

  // Apply a preset atomically: set both query and filter, then trigger search.
  function applyPreset(p: Preset) {
    const q = p.query;
    const f = (p.filters.authorType as AuthorFilter) ?? "all";
    setInputValue(q);
    setDebouncedQuery(q.trim());
    setFilter(f);
    setSavingPreset(false);
  }

  async function handleSavePreset(name: string) {
    if (!hasUserContext) return;
    const preset: Preset = {
      id: crypto.randomUUID(),
      name,
      query: debouncedQuery,
      filters: { authorType: filter },
    };
    // Optimistic update.
    setLocalPresets((prev) => [...(prev ?? []), preset]);
    setSavingPreset(false);
    try {
      await savePreset({ companyId, userId, preset });
    } catch {
      // On failure, roll back and re-sync from server.
      setPresetsRefresh((n) => n + 1);
    }
  }

  async function handleRenamePreset(id: string, name: string) {
    if (!hasUserContext) return;
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    const updated = { ...preset, name };
    // Optimistic update (preserve position).
    setLocalPresets((prev) =>
      (prev ?? []).map((p) => (p.id === id ? updated : p))
    );
    try {
      await savePreset({ companyId, userId, preset: updated });
    } catch {
      setPresetsRefresh((n) => n + 1);
    }
  }

  async function handleDeletePreset(id: string) {
    if (!hasUserContext) return;
    // Optimistic update.
    setLocalPresets((prev) => (prev ?? []).filter((p) => p.id !== id));
    try {
      await deletePreset({ companyId, userId, presetId: id });
    } catch {
      setPresetsRefresh((n) => n + 1);
    }
  }

  return (
    <div style={panelStyle}>
      <input
        type="search"
        placeholder="Search issues…"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        style={inputStyle}
        autoComplete="off"
        spellCheck={false}
      />

      {hasQuery && (
        <div style={chipRowStyle}>
          {(["all", "human", "agent"] as AuthorFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              style={chipStyle(filter === f)}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : f === "human" ? "Human" : "AI Agent"}
            </button>
          ))}
          {canSavePreset && !savingPreset && (
            <button
              type="button"
              style={{
                ...chipStyle(false),
                borderStyle: "dashed",
                color: "var(--primary, #6366f1)",
                borderColor: "var(--primary, #6366f1)",
              }}
              onClick={() => setSavingPreset(true)}
              title="Save current query + filters as a preset"
            >
              + Save as preset
            </button>
          )}
        </div>
      )}

      {savingPreset && (
        <SavePresetForm
          defaultName={debouncedQuery}
          onSave={handleSavePreset}
          onCancel={() => setSavingPreset(false)}
        />
      )}

      {/* Preset row — always visible when context is available */}
      {hasUserContext && (
        <PresetsRow
          presets={presets}
          onApply={applyPreset}
          onRename={handleRenamePreset}
          onDelete={handleDeletePreset}
        />
      )}

      {isSearching && (
        <div style={{ color: "var(--muted-foreground)", fontSize: "12px", padding: "4px 0" }}>
          Searching…
        </div>
      )}

      {hasError && (
        <div style={{ color: "#ef4444", fontSize: "12px", padding: "4px 0" }}>
          Search error. Try again.
        </div>
      )}

      {!isSearching && hasQuery && !hasError && (
        <>
          {filtered.length === 0 ? (
            <div style={{ color: "var(--muted-foreground)", fontSize: "12px", padding: "4px 0" }}>
              No results
              {filter !== "all" ? ` for ${filter === "human" ? "Human" : "AI Agent"} filter` : ""}
            </div>
          ) : (
            <div style={resultListStyle}>
              {filtered.map((result) => (
                <ResultRow key={result.id} result={result} issuesPath={issuesPath} />
              ))}
            </div>
          )}
          <div
            style={{
              color: "var(--muted-foreground)",
              fontSize: "11px",
              borderTop: "1px solid var(--border)",
              paddingTop: "6px",
            }}
          >
            {filtered.length} result{filtered.length !== 1 ? "s" : ""}
            {allResults.length !== filtered.length
              ? ` of ${allResults.length} total`
              : ""}
          </div>
        </>
      )}

      {!hasQuery && (
        <div style={{ color: "var(--muted-foreground)", fontSize: "12px", padding: "4px 0" }}>
          Deep search across titles, descriptions, and comments.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inbox toolbar preset buttons
// ---------------------------------------------------------------------------

/**
 * Renders saved presets as compact outline buttons in the inbox toolbar.
 * Clicking a button stores the preset in sessionStorage and navigates to the
 * company home page so the sidebar search panel can auto-apply it on mount.
 */
export function InboxToolbarPresets() {
  const context = useHostContext();
  const companyId = context.companyId ?? "";
  const userId = context.userId ?? "";
  const companyPrefix = context.companyPrefix;

  const presetsData = usePluginData<PresetsData>(
    "getPresets",
    companyId && userId ? { companyId, userId } : undefined
  );

  const presets = presetsData.data?.presets ?? [];

  if (presets.length === 0) return null;

  function handleClick(preset: Preset) {
    try {
      sessionStorage.setItem(PENDING_PRESET_KEY, JSON.stringify(preset));
    } catch {
      // sessionStorage unavailable — no-op; user can still open search manually.
    }
    window.location.href = companyPrefix ? `/${companyPrefix}` : "/";
  }

  const btnStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    height: "32px",
    padding: "0 10px",
    borderRadius: "6px",
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--foreground)",
    fontSize: "12px",
    fontWeight: 500,
    cursor: "pointer",
    whiteSpace: "nowrap",
    maxWidth: "120px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flexShrink: 0,
    transition: "background 0.1s, border-color 0.1s",
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
      {presets.map((p) => (
        <button
          key={p.id}
          type="button"
          style={btnStyle}
          title={`Open saved search: ${p.name}`}
          onClick={() => handleClick(p)}
          onMouseEnter={(e) => {
            const el = e.currentTarget as HTMLButtonElement;
            el.style.background = "color-mix(in srgb, var(--accent, #6366f1) 12%, transparent)";
            el.style.borderColor = "var(--primary, #6366f1)";
          }}
          onMouseLeave={(e) => {
            const el = e.currentTarget as HTMLButtonElement;
            el.style.background = "transparent";
            el.style.borderColor = "var(--border)";
          }}
        >
          {p.name}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar nav entry
// ---------------------------------------------------------------------------

export function BetterSearchSidebar({ context }: PluginSidebarProps) {
  const companyPrefix = context.companyPrefix;
  const href = companyPrefix ? `/${companyPrefix}` : "/";

  return (
    <a
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "6px 8px",
        borderRadius: "6px",
        textDecoration: "none",
        color: "var(--foreground)",
        fontSize: "13px",
        fontWeight: 500,
      }}
      title="Better Search"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="6.5" cy="6.5" r="4.5" />
        <line x1="10.5" y1="10.5" x2="14" y2="14" />
      </svg>
      <span>Search</span>
    </a>
  );
}
