import { useState } from "react";
import { useSearchParams, useNavigate } from "@/lib/router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Package, ArrowLeft, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToastActions } from "@/context/ToastContext";

const NPM_PKG_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const ALLOWED_SOURCES = new Set(["deep-link", "cliphub", "marketplace", "docs", "cli"]);

function parseProtocolUri(uri: string): { plugin: string; version?: string } | null {
  const match = uri.match(/^(?:web\+paperclip|paperclip):install\/(.+?)(?:\/([^/]+))?$/);
  if (!match || !NPM_PKG_RE.test(match[1])) return null;
  return { plugin: match[1], version: match[2] };
}

export function PluginInstallDeepLink() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [installedName, setInstalledName] = useState<string | null>(null);

  const uri = searchParams.get("uri");
  const directPlugin = searchParams.get("plugin");
  const directVersion = searchParams.get("version") ?? undefined;
  const rawSource = searchParams.get("source") ?? "deep-link";
  const source = ALLOWED_SOURCES.has(rawSource) ? rawSource : "deep-link";

  let plugin: string | null = null;
  let version: string | undefined;

  if (uri) {
    const parsed = parseProtocolUri(uri);
    if (parsed) {
      plugin = parsed.plugin;
      version = parsed.version;
    }
  } else if (directPlugin) {
    plugin = directPlugin;
    version = directVersion;
  }

  const installMutation = useMutation({
    mutationFn: (params: { packageName: string; version?: string }) =>
      pluginsApi.install(params),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.examples });
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.uiContributions });
      setInstalledName(variables.packageName);
      pushToast({ title: "Plugin installed successfully", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to install plugin", body: err.message, tone: "error" });
    },
  });

  if (!plugin) {
    return (
      <div className="mx-auto max-w-lg py-16 px-4">
        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertCircle className="h-6 w-6 text-destructive" />
            </div>
            <CardTitle>Invalid Install Link</CardTitle>
            <CardDescription>
              This link is missing a plugin name. A valid install link looks like:
              <code className="mt-2 block rounded bg-muted px-2 py-1 text-xs">
                /install?plugin=@paperclipai/plugin-example
              </code>
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button variant="outline" onClick={() => navigate("/instance/settings/plugins")}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Go to Plugin Manager
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (installedName) {
    return (
      <div className="mx-auto max-w-lg py-16 px-4">
        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
              <CheckCircle2 className="h-6 w-6 text-green-600" />
            </div>
            <CardTitle>Plugin Installed</CardTitle>
            <CardDescription>
              <span className="font-medium text-foreground">{installedName}</span> has been installed successfully.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center gap-3">
            <Button onClick={() => navigate("/instance/settings/plugins")}>
              Go to Plugin Manager
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg py-16 px-4">
      <Card>
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Package className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>Install Plugin</CardTitle>
          <CardDescription>
            You&apos;ve been linked to install a plugin on this Paperclip instance.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border bg-muted/30 px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{plugin}</p>
                {version && (
                  <p className="mt-0.5 text-xs text-muted-foreground">Version: {version}</p>
                )}
              </div>
              <Badge variant="outline">{source}</Badge>
            </div>
          </div>

          {installMutation.isError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="text-sm text-destructive">{installMutation.error.message}</p>
            </div>
          )}

          <div className="flex justify-center gap-3">
            <Button variant="outline" onClick={() => navigate("/instance/settings/plugins")}>
              Cancel
            </Button>
            <Button
              onClick={() => { if (plugin) installMutation.mutate({ packageName: plugin, version }); }}
              disabled={installMutation.isPending}
            >
              {installMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Installing...
                </>
              ) : (
                <>
                  <Download className="mr-2 h-4 w-4" />
                  Install Plugin
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
