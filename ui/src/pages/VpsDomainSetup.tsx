import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { vpsApi } from "../api/vps";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { Globe, CheckCircle2, XCircle, Loader2 } from "lucide-react";

export function VpsDomainSetupPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [domain, setDomain] = useState("");
  const [error, setError] = useState<string | null>(null);

  const networkQuery = useQuery({
    queryKey: ["vps", "network-info"],
    queryFn: () => vpsApi.getNetworkInfo(),
    retry: false,
  });

  const ip = networkQuery.data?.ip ?? "...";

  const verifyMutation = useMutation({
    mutationFn: () => vpsApi.verifyDns(domain.trim()),
    onError: (err) => {
      setError(err instanceof Error ? err.message : "DNS verification failed");
    },
  });

  const configureMutation = useMutation({
    mutationFn: () => vpsApi.configureDomain(domain.trim()),
    onSuccess: async (data) => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      const delayMs = data.restartScheduled ? 4000 : 0;
      window.setTimeout(() => {
        window.location.href = data.nextUrl;
      }, delayMs);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Domain configuration failed");
    },
  });

  const skipMutation = useMutation({
    mutationFn: () => vpsApi.skipDomain(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      navigate("/setup/providers", { replace: true });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to skip domain setup");
    },
  });

  const dnsResult = verifyMutation.data;
  const canConfigure = dnsResult?.matches === true;
  const isWorking = verifyMutation.isPending || configureMutation.isPending || skipMutation.isPending;

  return (
    <div className="fixed inset-0 flex bg-background">
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-lg mx-auto my-auto px-8 py-12">
          <div className="flex items-center gap-2 mb-8">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Paperclip VPS Setup</span>
          </div>

          <h1 className="text-xl font-semibold">Configure your domain</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Set up a custom domain with automatic HTTPS, or skip to continue using the IP address.
          </p>

          {/* DNS Instructions */}
          <div className="mt-6 rounded-md border border-border bg-muted/30 p-4 text-sm space-y-3">
            <p className="font-medium">Point your domain to this server:</p>
            <div className="font-mono text-xs bg-background rounded px-3 py-2 border border-border">
              <p>Type: <span className="text-foreground font-semibold">A</span></p>
              <p>Name: <span className="text-foreground font-semibold">dashboard</span> (or your subdomain)</p>
              <p>Value: <span className="text-foreground font-semibold">{ip}</span></p>
              <p>Proxy: <span className="text-foreground font-semibold">OFF</span> (DNS only)</p>
            </div>
            <p className="text-muted-foreground text-xs">
              You can also point <code className="bg-background px-1 rounded">*.yourdomain.com</code> and{" "}
              <code className="bg-background px-1 rounded">yourdomain.com</code> to{" "}
              <code className="bg-background px-1 rounded">{ip}</code> if you want Paperclip to control the
              full domain and all subdomains.
            </p>
          </div>

          {/* Domain Input + Actions */}
          <div className="mt-6 space-y-4">
            <div>
              <label htmlFor="domain" className="text-xs text-muted-foreground mb-1 block">
                Domain
              </label>
              <input
                id="domain"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                placeholder="dashboard.yourdomain.com"
                value={domain}
                onChange={(e) => {
                  setDomain(e.target.value);
                  // Reset verification when domain changes
                  if (dnsResult) verifyMutation.reset();
                }}
              />
            </div>

            {/* DNS Verification Result */}
            {dnsResult && (
              <div
                className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
                  dnsResult.matches
                    ? "border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-400"
                    : "border-yellow-500/30 bg-yellow-500/5 text-yellow-700 dark:text-yellow-400"
                }`}
              >
                {dnsResult.matches ? (
                  <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                ) : (
                  <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
                )}
                <div>
                  {dnsResult.matches ? (
                    <p>DNS verified! <strong>{dnsResult.domain}</strong> resolves to <strong>{dnsResult.expectedIp}</strong>.</p>
                  ) : dnsResult.resolved ? (
                    <p>
                      <strong>{dnsResult.domain}</strong> resolves to{" "}
                      <strong>{dnsResult.resolvedIps.join(", ")}</strong> but this server's IP is{" "}
                      <strong>{dnsResult.expectedIp}</strong>. Update the A record and try again.
                    </p>
                  ) : (
                    <p>
                      <strong>{dnsResult.domain}</strong> does not resolve yet. DNS changes can take a few
                      minutes to propagate. Try again shortly.
                    </p>
                  )}
                </div>
              </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}
            {configureMutation.isPending && (
              <p className="text-xs text-muted-foreground">
                Applying HTTPS settings and preparing a restart...
              </p>
            )}

            <div className="flex gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={!domain.trim() || isWorking}
                onClick={() => {
                  setError(null);
                  verifyMutation.mutate();
                }}
              >
                {verifyMutation.isPending ? (
                  <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Checking...</>
                ) : (
                  "Verify DNS"
                )}
              </Button>
              <Button
                type="button"
                disabled={!canConfigure || isWorking}
                onClick={() => {
                  setError(null);
                  configureMutation.mutate();
                }}
              >
                {configureMutation.isPending ? (
                  <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Configuring...</>
                ) : (
                  "Configure HTTPS"
                )}
              </Button>
            </div>
          </div>

          {/* Skip */}
          <div className="mt-8 pt-6 border-t border-border">
            <button
              type="button"
              className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors"
              disabled={isWorking}
              onClick={() => skipMutation.mutate()}
            >
              {skipMutation.isPending ? "Skipping..." : "Skip — continue on IP address"}
            </button>
            <p className="mt-1 text-xs text-muted-foreground">
              You can configure a domain later from the instance settings.
            </p>
          </div>
        </div>
      </div>

      <div className="hidden md:block w-1/2 overflow-hidden">
        <AsciiArtAnimation />
      </div>
    </div>
  );
}
