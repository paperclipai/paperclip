import { Plus, Power, PowerOff, Trash2, Settings, Package, Loader2 } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { tauriInvoke } from "@/api/tauri-client";
import { queryKeys } from "@/lib/queryKeys";

interface Plugin {
  id: string;
  plugin_key: string;
  package_name: string;
  version: string;
  status: "active" | "disabled" | "error";
  last_error: string | null;
}

const STATUS_STYLES: Record<string, { bg: string; fg: string; label: string }> = {
  active: { bg: "var(--success-subtle)", fg: "var(--success)", label: "Active" },
  disabled: { bg: "var(--bg-muted)", fg: "var(--fg-muted)", label: "Disabled" },
  error: { bg: "var(--destructive-subtle)", fg: "var(--destructive)", label: "Error" },
};

export function PluginManager() {
  const queryClient = useQueryClient();

  const { data: plugins = [], isLoading } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => tauriInvoke<Plugin[]>("list_plugins"),
  });

  const enableMutation = useMutation({
    mutationFn: (id: string) => tauriInvoke("enable_plugin", { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all }),
  });

  const disableMutation = useMutation({
    mutationFn: (id: string) => tauriInvoke("disable_plugin", { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all }),
  });

  const uninstallMutation = useMutation({
    mutationFn: (id: string) => tauriInvoke("uninstall_plugin", { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={20} className="animate-spin" style={{ color: "var(--fg-muted)" }} />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold" style={{ letterSpacing: "-0.01em" }}>Plugins</h1>
        <button className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-medium" style={{ background: "var(--accent)", color: "var(--accent-fg)" }}>
          <Plus size={15} /> Install Plugin
        </button>
      </div>

      {plugins.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border py-16" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
          <Package size={32} className="mb-3 opacity-30" style={{ color: "var(--fg-muted)" }} />
          <p className="text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>No plugins installed</p>
          <p className="mt-1 text-[12px]" style={{ color: "var(--fg-muted)" }}>Install plugins to extend ArchonOS capabilities.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {plugins.map((plugin) => {
            const style = STATUS_STYLES[plugin.status] ?? STATUS_STYLES.disabled;
            return (
              <div
                key={plugin.id}
                className="rounded-lg border px-5 py-4"
                style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}
              >
                <div className="flex items-center gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: style.bg }}>
                    <Package size={18} style={{ color: style.fg }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{plugin.package_name}</span>
                      <span className="text-[11px]" style={{ fontFamily: "var(--font-mono)", color: "var(--fg-muted)" }}>v{plugin.version}</span>
                    </div>
                    <div className="text-[12px]" style={{ color: "var(--fg-muted)" }}>{plugin.plugin_key}</div>
                  </div>
                  <span className="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium" style={{ background: style.bg, color: style.fg }}>
                    {style.label}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    {plugin.status === "active" ? (
                      <button
                        className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-muted)]"
                        title="Disable"
                        style={{ color: "var(--fg-muted)" }}
                        onClick={() => disableMutation.mutate(plugin.id)}
                        disabled={disableMutation.isPending}
                      >
                        <PowerOff size={14} />
                      </button>
                    ) : plugin.status !== "error" ? (
                      <button
                        className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-muted)]"
                        title="Enable"
                        style={{ color: "var(--fg-muted)" }}
                        onClick={() => enableMutation.mutate(plugin.id)}
                        disabled={enableMutation.isPending}
                      >
                        <Power size={14} />
                      </button>
                    ) : null}
                    <button className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-muted)]" title="Settings" style={{ color: "var(--fg-muted)" }}>
                      <Settings size={14} />
                    </button>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-muted)]"
                      title="Uninstall"
                      style={{ color: "var(--destructive)" }}
                      onClick={() => uninstallMutation.mutate(plugin.id)}
                      disabled={uninstallMutation.isPending}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                {plugin.last_error && (
                  <div className="mt-2 rounded px-3 py-2 text-[12px]" style={{ background: "var(--destructive-subtle)", color: "var(--destructive)" }}>
                    {plugin.last_error}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
