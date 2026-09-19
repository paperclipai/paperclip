import { useAccountIdentity } from "@/api/companies-query";
import { useCompany } from "@/context/CompanyContext";
import { useDialogState } from "@/context/DialogContext";
import { PluginSlotMount, usePluginSlots, type PluginSlotContext } from "@/plugins/slots";

function AppShellEntries({ context }: { context: PluginSlotContext }) {
  const { slots, errorMessage } = usePluginSlots({
    slotTypes: ["appShellOverlay"],
    companyId: context.companyId,
  });
  // Optional extensions must not replace the application's normal error UI.
  if (errorMessage || slots.length === 0) return null;
  return (
    <aside className="plugin-app-shell-overlays" aria-label="Application extensions">
      {slots.map((slot) => (
        <PluginSlotMount
          key={`${slot.pluginId}:${slot.pluginVersion}:${slot.id}`}
          slot={slot}
          context={context}
          className="plugin-app-shell-overlay"
        />
      ))}
    </aside>
  );
}

/**
 * One persistent mount in each application shell. Navigation preserves the
 * plugin tree; changing account/company, signing out, or entering onboarding
 * disposes it. Plugins must cancel their requests/subscriptions on disposal.
 * Host context is display context, never proof of server authorization.
 */
export function PluginAppShellOverlays({ localTrusted = false }: { localTrusted?: boolean }) {
  const { userId, settled } = useAccountIdentity();
  const { selectedCompanyId, selectedCompany, loading } = useCompany();
  const { onboardingOpen } = useDialogState();
  const identity = localTrusted ? "local-board" : settled ? userId : null;
  if (!identity || loading || onboardingOpen) return null;
  return (
    <AppShellEntries
      key={JSON.stringify([identity, selectedCompanyId])}
      context={{ companyId: selectedCompanyId, companyPrefix: selectedCompany?.issuePrefix ?? null }}
    />
  );
}
