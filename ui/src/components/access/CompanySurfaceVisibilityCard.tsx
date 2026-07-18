import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { COMPANY_SETTINGS_SURFACES, type CompanySettingsSurface } from "@paperclipai/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

const SURFACE_LABELS: Record<CompanySettingsSurface, { label: string; hint: string }> = {
  "company.general": { label: "General", hint: "Company name, branding, defaults" },
  "company.members": { label: "Members", hint: "Membership, roles, join requests" },
  "company.invites": { label: "Invites", hint: "Creating and revoking invites" },
  "company.secrets": { label: "Secrets", hint: "Company secrets and providers" },
  "company.plugins": {
    label: "Plugins",
    hint: "Plugin catalog page only — enabled plugins' own pages always render",
  },
};

export function CompanySurfaceVisibilityCard() {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<CompanySettingsSurface>>(new Set());

  const visibilityQuery = useQuery({
    queryKey: queryKeys.instance.visibilitySettings,
    queryFn: () => instanceSettingsApi.getVisibility(),
  });

  useEffect(() => {
    if (visibilityQuery.data) {
      setSelected(new Set(visibilityQuery.data.companySurfaces));
    }
  }, [visibilityQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      instanceSettingsApi.updateVisibility({
        companySurfaces: COMPANY_SETTINGS_SURFACES.filter((surface) => selected.has(surface)),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.visibilitySettings });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
      pushToast({ title: "Company settings visibility updated", tone: "success" });
    },
  });

  return (
    <Card className="block space-y-4 p-5">
      <div>
        <h2 className="text-sm font-semibold">Company settings visibility</h2>
        <p className="text-sm text-muted-foreground">
          Choose which company settings surfaces non-admin company members can use on this
          instance. Instance admins always see everything. Instance-scoped settings are never
          visible to non-admins.
        </p>
      </div>
      {visibilityQuery.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading visibility policy…</div>
      ) : visibilityQuery.error ? (
        <div className="text-sm text-destructive">Failed to load the visibility policy.</div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            {COMPANY_SETTINGS_SURFACES.map((surface) => (
              <label
                key={surface}
                className="flex items-start gap-3 rounded-lg border border-border px-3 py-3"
              >
                <Checkbox
                  checked={selected.has(surface)}
                  onCheckedChange={(checked) => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(surface);
                      else next.delete(surface);
                      return next;
                    });
                  }}
                />
                <span className="space-y-1">
                  <span className="block text-sm font-medium">{SURFACE_LABELS[surface].label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {SURFACE_LABELS[surface].hint}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <div className="flex justify-end">
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Saving…" : "Save visibility"}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
