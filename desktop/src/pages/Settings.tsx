import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "@/context/ThemeContext";
import { useSidebar } from "@/context/SidebarContext";
import { secretsApi } from "@/api/secrets";
import { tauriInvoke } from "@/api/tauri-client";
import { cn } from "@/lib/utils";

type Theme = "light" | "dark" | "system";

const KNOWN_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
] as const;

function persistSettings(settings: { theme?: string; sidebar_open?: boolean }) {
  tauriInvoke("update_settings", { settings }).catch(() => {
    // Fire-and-forget: backend persistence is best-effort
  });
}

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { sidebarOpen, setSidebarOpen } = useSidebar();

  const handleThemeChange = (t: Theme) => {
    setTheme(t);
    persistSettings({ theme: t, sidebar_open: sidebarOpen });
  };

  const handleSidebarChange = (v: string) => {
    const open = v === "Open";
    setSidebarOpen(open);
    persistSettings({ theme, sidebar_open: open });
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold" style={{ letterSpacing: "-0.01em" }}>Settings</h1>
      </div>

      <div className="max-w-[560px]">
        <h3 className="mb-2 text-sm font-semibold" style={{ color: "var(--fg-secondary)" }}>Appearance</h3>

        <SettingsRow
          label="Theme"
          description="Choose light, dark, or sync with macOS"
        >
          <SegmentedControl
            options={["light", "dark", "system"] as Theme[]}
            value={theme}
            onChange={handleThemeChange}
          />
        </SettingsRow>

        <SettingsRow
          label="Sidebar"
          description="Show sidebar on launch"
        >
          <SegmentedControl
            options={["Open", "Collapsed"]}
            value={sidebarOpen ? "Open" : "Collapsed"}
            onChange={handleSidebarChange}
          />
        </SettingsRow>

        <SecretsSection />

        <h3 className="mb-2 mt-8 text-sm font-semibold" style={{ color: "var(--fg-secondary)" }}>MCP Server</h3>
        <McpSection />

        <h3 className="mb-2 mt-8 text-sm font-semibold" style={{ color: "var(--fg-secondary)" }}>About</h3>
        <SettingsRow label="ArchonOS" description="Version 0.1.0 · Tauri v2 · SQLite" />
      </div>
    </div>
  );
}

function McpSection() {
  const [copied, setCopied] = useState(false);

  const { data: config, isLoading } = useQuery({
    queryKey: ["mcp-config"],
    queryFn: () => tauriInvoke<string>("get_mcp_config"),
  });

  const handleCopy = () => {
    if (!config) return;
    navigator.clipboard.writeText(config).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (isLoading) return <div className="py-3 text-xs" style={{ color: "var(--fg-muted)" }}>Loading...</div>;

  return (
    <div className="border-b py-4" style={{ borderColor: "var(--border-subtle)" }}>
      <pre
        className="overflow-x-auto rounded-md border p-3 text-xs"
        style={{
          background: "var(--bg-secondary)",
          borderColor: "var(--border)",
          color: "var(--fg)",
          fontFamily: "var(--font-mono)",
          lineHeight: "1.5",
        }}
      >
        {config}
      </pre>
      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={handleCopy}
          className="rounded-md border px-3 py-1.5 text-xs font-medium"
          style={{ borderColor: "var(--border)", color: "var(--fg-secondary)" }}
        >
          {copied ? "Copied!" : "Copy to Clipboard"}
        </button>
        <span className="text-xs" style={{ color: "var(--fg-muted)" }}>
          Add this to your Claude Desktop MCP config (~/.claude/claude_desktop_config.json)
        </span>
      </div>
    </div>
  );
}

function SecretsSection() {
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState<string>(KNOWN_KEYS[0]);
  const [secretValue, setSecretValue] = useState("");

  const { data: configuredKeys = [] } = useQuery({
    queryKey: ["secrets"],
    queryFn: () => secretsApi.list(),
  });

  const setMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      secretsApi.set(key, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["secrets"] });
      setSecretValue("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (key: string) => secretsApi.delete(key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["secrets"] });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!secretValue.trim()) return;
    setMutation.mutate({ key: selectedKey, value: secretValue });
  };

  return (
    <>
      <h3 className="mb-2 mt-8 text-sm font-semibold" style={{ color: "var(--fg-secondary)" }}>Authentication</h3>

      <div className="mb-4">
        <p className="mb-3 text-[12px]" style={{ color: "var(--fg-muted)" }}>
          Use your existing CLI login — no API keys needed. API keys are optional and override login sessions.
        </p>
        <AuthOverviewRow adapterType="ollama_local" label="Ollama (Free Local)" />
        <AuthOverviewRow adapterType="claude_local" label="Claude" />
        <AuthOverviewRow adapterType="codex_local" label="Codex (ChatGPT)" />
        <AuthOverviewRow adapterType="cursor_local" label="Cursor" />
        <AuthOverviewRow adapterType="gemini_local" label="Gemini" />
      </div>
      <h4 className="mb-2 text-[12px] font-medium" style={{ color: "var(--fg-muted)" }}>API Keys (Optional)</h4>

      {KNOWN_KEYS.map((key) => {
        const isConfigured = configuredKeys.includes(key);
        return (
          <div
            key={key}
            className="flex items-center justify-between border-b py-3"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <div>
              <div className="text-sm font-medium font-mono">{key}</div>
              <div
                className="text-xs"
                style={{ color: isConfigured ? "var(--status-green, #22c55e)" : "var(--fg-muted)" }}
              >
                {isConfigured ? "Configured" : "Not set"}
              </div>
            </div>
            {isConfigured && (
              <button
                onClick={() => deleteMutation.mutate(key)}
                className="rounded px-2 py-1 text-xs"
                style={{
                  color: "var(--fg-muted)",
                  border: "1px solid var(--border)",
                }}
              >
                Remove
              </button>
            )}
          </div>
        );
      })}

      <form onSubmit={handleSubmit} className="mt-4 flex items-end gap-2">
        <div className="flex-1">
          <label className="mb-1 block text-xs" style={{ color: "var(--fg-muted)" }}>Key</label>
          <select
            value={selectedKey}
            onChange={(e) => setSelectedKey(e.target.value)}
            className="w-full rounded-md border px-2 py-1.5 text-xs"
            style={{
              borderColor: "var(--border)",
              background: "var(--bg-secondary)",
              color: "var(--fg-primary)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {KNOWN_KEYS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
        <div className="flex-[2]">
          <label className="mb-1 block text-xs" style={{ color: "var(--fg-muted)" }}>Value</label>
          <input
            type="password"
            value={secretValue}
            onChange={(e) => setSecretValue(e.target.value)}
            placeholder="sk-..."
            className="w-full rounded-md border px-2 py-1.5 text-xs"
            style={{
              borderColor: "var(--border)",
              background: "var(--bg-secondary)",
              color: "var(--fg-primary)",
              fontFamily: "var(--font-mono)",
            }}
          />
        </div>
        <button
          type="submit"
          disabled={!secretValue.trim() || setMutation.isPending}
          className="rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          style={{
            background: "var(--accent)",
            color: "var(--accent-fg)",
          }}
        >
          Save
        </button>
      </form>
    </>
  );
}

function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center justify-between border-b py-4"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs" style={{ color: "var(--fg-muted)" }}>{description}</div>
      </div>
      {children}
    </div>
  );
}

function AuthOverviewRow({ adapterType, label }: { adapterType: string; label: string }) {
  const queryClient = useQueryClient();
  const { data: auth } = useQuery({
    queryKey: ["adapter-auth", adapterType],
    queryFn: () => tauriInvoke<{ cli_installed: boolean; logged_in: boolean; subscription_type: string | null }>("check_adapter_auth", { adapterType }),
  });

  const loginMutation = useMutation({
    mutationFn: () => tauriInvoke<{ success: boolean }>("adapter_login", { adapterType }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["adapter-auth"] }),
  });

  return (
    <div className="flex items-center justify-between border-b py-2" style={{ borderColor: "var(--border-subtle)" }}>
      <div className="text-sm font-medium">{label}</div>
      <div className="flex items-center gap-2">
        {!auth ? (
          <span className="text-[11px]" style={{ color: "var(--fg-muted)" }}>Checking...</span>
        ) : auth.logged_in ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--success)" }} />
            <span className="text-[12px]" style={{ color: "var(--success)" }}>
              {adapterType === "ollama_local" ? "Ready \u00B7 Free \u00B7 Local" : `Connected${auth.subscription_type ? ` (${auth.subscription_type})` : ""}`}
            </span>
          </>
        ) : auth.cli_installed ? (
          <button
            onClick={() => loginMutation.mutate()}
            disabled={loginMutation.isPending}
            className="rounded px-2 py-0.5 text-[11px] font-medium"
            style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
          >
            {adapterType === "ollama_local"
              ? (loginMutation.isPending ? "Downloading..." : "Setup")
              : (loginMutation.isPending ? "Logging in..." : "Login")}
          </button>
        ) : (
          <span className="text-[11px]" style={{ color: "var(--fg-muted)" }}>Not installed</span>
        )}
      </div>
    </div>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: T[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-md border" style={{ borderColor: "var(--border)" }}>
      {options.map((opt, i) => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={cn(
            "px-3 py-1 text-xs font-medium capitalize transition-colors",
            i < options.length - 1 && "border-r",
          )}
          style={{
            borderColor: "var(--border)",
            background: opt === value ? "var(--accent)" : "transparent",
            color: opt === value ? "var(--accent-fg)" : "var(--fg-muted)",
            fontFamily: "var(--font-body)",
          }}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
