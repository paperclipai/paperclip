import {
  usePluginAction,
  usePluginData,
  type PluginPageProps,
  type PluginSettingsPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { useMemo, useState, type CSSProperties, type FormEvent } from "react";

interface BookmarkRecord {
  id: string;
  companyId: string;
  slug: string;
  url: string;
  title: string;
  notes: string;
  tags: string[];
  filePath: string;
  createdAt: string;
  updatedAt: string;
}

interface BookmarkListResult {
  databaseNamespace: string;
  bookmarks: BookmarkRecord[];
}

const containerStyle: CSSProperties = {
  display: "grid",
  gap: 16,
  font: "13px system-ui, sans-serif",
  color: "#111827",
  padding: 16,
  maxWidth: 760,
};

const cardStyle: CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 12,
  background: "#fff",
};

const inputStyle: CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: 6,
  padding: "6px 8px",
  font: "inherit",
  width: "100%",
};

const buttonStyle: CSSProperties = {
  border: "1px solid #1f2937",
  background: "#111827",
  color: "#fff",
  borderRadius: 6,
  padding: "6px 10px",
  font: "inherit",
  cursor: "pointer",
};

const subtleButtonStyle: CSSProperties = {
  border: "1px solid #d1d5db",
  background: "#fff",
  color: "#111827",
  borderRadius: 6,
  padding: "4px 8px",
  font: "inherit",
  cursor: "pointer",
};

const tagStyle: CSSProperties = {
  display: "inline-block",
  border: "1px solid #cbd5f5",
  background: "#eef2ff",
  color: "#3730a3",
  borderRadius: 999,
  padding: "1px 8px",
  marginRight: 4,
  fontSize: 11,
};

function parseTagInput(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function BookmarksList({
  result,
  onDelete,
  loading,
}: {
  result: BookmarkListResult | null;
  onDelete: (slug: string) => Promise<void>;
  loading: boolean;
}) {
  if (loading) return <div>Loading bookmarks…</div>;
  if (!result) return null;
  if (result.bookmarks.length === 0) {
    return <div style={{ color: "#6b7280" }}>No bookmarks yet.</div>;
  }
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {result.bookmarks.map((bookmark) => (
        <div key={bookmark.id} style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <a
              href={bookmark.url}
              target="_blank"
              rel="noreferrer"
              style={{ color: "#1d4ed8", fontWeight: 600 }}
            >
              {bookmark.title}
            </a>
            <button
              type="button"
              style={subtleButtonStyle}
              onClick={() => {
                void onDelete(bookmark.slug);
              }}
            >
              Delete
            </button>
          </div>
          <div style={{ color: "#6b7280", fontSize: 12, wordBreak: "break-all" }}>{bookmark.url}</div>
          {bookmark.tags.length > 0 ? (
            <div style={{ marginTop: 6 }}>
              {bookmark.tags.map((tag) => (
                <span key={tag} style={tagStyle}>
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
          {bookmark.notes ? (
            <div style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{bookmark.notes}</div>
          ) : null}
          <div style={{ marginTop: 6, color: "#9ca3af", fontSize: 11 }}>
            Added {formatDate(bookmark.createdAt)} · {bookmark.filePath}
          </div>
        </div>
      ))}
    </div>
  );
}

function BookmarksSurface({ companyId }: { companyId: string }) {
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [tagsRaw, setTagsRaw] = useState("");
  const [notes, setNotes] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const listParams = useMemo(
    () => ({ companyId, search: search.trim() || null, tag: tag.trim() || null }),
    [companyId, search, tag],
  );

  const { data, loading, error, refresh } = usePluginData<BookmarkListResult>("list", listParams);
  const create = usePluginAction("create");
  const remove = usePluginAction("delete");

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    try {
      await create({
        companyId,
        url,
        title: title || null,
        notes: notes || null,
        tags: parseTagInput(tagsRaw),
      });
      setUrl("");
      setTitle("");
      setNotes("");
      setTagsRaw("");
      refresh();
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : "Failed to add bookmark");
    }
  }

  async function handleDelete(slug: string) {
    setErrorMessage(null);
    try {
      await remove({ companyId, slug });
      refresh();
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : "Failed to delete bookmark");
    }
  }

  return (
    <div style={containerStyle}>
      <header style={{ display: "grid", gap: 4 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Bookmarks</h1>
        <div style={{ color: "#6b7280" }}>
          Company-scoped bookmark library backed by a plugin database namespace and a local markdown
          folder.
        </div>
      </header>

      <form onSubmit={handleCreate} style={{ ...cardStyle, display: "grid", gap: 8 }}>
        <strong>Add bookmark</strong>
        <input
          style={inputStyle}
          required
          type="url"
          placeholder="https://example.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <input
          style={inputStyle}
          placeholder="Title (defaults to URL)"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <input
          style={inputStyle}
          placeholder="Tags (comma or space separated)"
          value={tagsRaw}
          onChange={(event) => setTagsRaw(event.target.value)}
        />
        <textarea
          style={{ ...inputStyle, minHeight: 60, resize: "vertical" }}
          placeholder="Notes (optional)"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
        <div>
          <button type="submit" style={buttonStyle}>
            Save
          </button>
        </div>
        {errorMessage ? <div style={{ color: "#b91c1c" }}>{errorMessage}</div> : null}
      </form>

      <div style={{ ...cardStyle, display: "grid", gap: 8 }}>
        <strong>Search</strong>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={inputStyle}
            placeholder="Search title, url, or notes"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <input
            style={{ ...inputStyle, maxWidth: 180 }}
            placeholder="Filter by tag"
            value={tag}
            onChange={(event) => setTag(event.target.value)}
          />
        </div>
      </div>

      {error ? <div style={{ color: "#b91c1c" }}>{error.message}</div> : null}
      <BookmarksList result={data ?? null} onDelete={handleDelete} loading={loading} />
    </div>
  );
}

function MissingCompanyNotice({ surface }: { surface: string }) {
  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <strong>{surface}</strong>
        <div style={{ color: "#6b7280", marginTop: 4 }}>
          Open this plugin from a company workspace — bookmarks are scoped per company.
        </div>
      </div>
    </div>
  );
}

export function BookmarksPage({ context }: PluginPageProps) {
  if (!context.companyId) return <MissingCompanyNotice surface="Bookmarks" />;
  return <BookmarksSurface companyId={context.companyId} />;
}

export function BookmarksSettingsPage({ context }: PluginSettingsPageProps) {
  const companyId = context.companyId ?? "";
  const { data, loading, error } = usePluginData<BookmarkListResult>(
    "list",
    companyId ? { companyId, limit: 1 } : undefined,
  );
  if (!companyId) return <MissingCompanyNotice surface="Bookmarks settings" />;
  return (
    <div style={containerStyle}>
      <h1 style={{ fontSize: 18, margin: 0 }}>Bookmarks settings</h1>
      <div style={cardStyle}>
        <div style={{ display: "grid", gap: 4 }}>
          <div>
            <strong>Database namespace:</strong>{" "}
            <code>{loading ? "…" : (data?.databaseNamespace ?? "not configured")}</code>
          </div>
          <div>
            Configure the <code>bookmarks-root</code> local folder under the plugin Folders settings
            so new bookmarks can be persisted to disk in addition to the database namespace.
          </div>
          {error ? <div style={{ color: "#b91c1c" }}>{error.message}</div> : null}
        </div>
      </div>
    </div>
  );
}

export function BookmarksDashboardWidget({ context }: PluginWidgetProps) {
  const companyId = context.companyId;
  const { data, loading, error } = usePluginData<BookmarkListResult>(
    "list",
    companyId ? { companyId, limit: 5 } : undefined,
  );

  if (!companyId) return null;
  if (loading) return <div style={{ font: "12px system-ui, sans-serif" }}>Loading bookmarks…</div>;
  if (error) return <div style={{ color: "#b91c1c" }}>Bookmarks error: {error.message}</div>;
  const bookmarks = data?.bookmarks ?? [];

  return (
    <div style={{ display: "grid", gap: 6, font: "13px system-ui, sans-serif" }}>
      <strong>Recent bookmarks</strong>
      {bookmarks.length === 0 ? (
        <div style={{ color: "#6b7280" }}>No bookmarks yet.</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {bookmarks.map((bookmark) => (
            <li key={bookmark.id}>
              <a
                href={bookmark.url}
                target="_blank"
                rel="noreferrer"
                style={{ color: "#1d4ed8" }}
              >
                {bookmark.title}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BookmarksSidebarLink(_props: PluginSidebarProps) {
  return <span>Bookmarks</span>;
}
