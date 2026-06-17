import { useEffect, useMemo, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TOOL_APP_GALLERY, type AppGalleryEntry } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { AppsConnect } from "@/pages/apps/AppsConnect";

/**
 * PAP-11283 — the gallery Connect wizard names the connection at create time.
 *
 * The key step now leads with a Name field (default = the app name) so two
 * connections to the same app (e.g. a stdio and an HTTP Google Sheets) can be
 * told apart in the Apps list without a detail-page rename hop.
 */

const COMPANY = "company-storybook";

// Zapier is an api_key gallery app, so the key step renders both the new Name
// field and a credential input — a representative shape for this screenshot.
const ZAPIER = TOOL_APP_GALLERY.find((e) => e.key === "zapier") as AppGalleryEntry;
const GALLERY: AppGalleryEntry[] = [ZAPIER];

function seededClient() {
  const c = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false },
    },
  });
  c.setQueryData(queryKeys.apps.gallery(COMPANY), { apps: GALLERY });
  return c;
}

/**
 * Auto-advances into the key step by clicking the first gallery card, then —
 * for the custom-name variant — types a distinct name so the screenshot lands
 * on the edited field.
 */
function KeyStepHost({ customName }: { customName?: string }) {
  const client = useMemo(() => seededClient(), []);
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    let cancelled = false;
    const tick = window.setInterval(() => {
      if (cancelled) return;
      const card = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
        b.textContent?.includes("Zapier"),
      );
      if (!card) return;
      card.click();
      ranRef.current = true;
      window.clearInterval(tick);
      if (customName) {
        window.setTimeout(() => {
          const nameInput = Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(
            (i) => i.getAttribute("placeholder") === "My app",
          );
          if (!nameInput) return;
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
          )?.set;
          setter?.call(nameInput, customName);
          nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        }, 30);
      }
    }, 50);
    return () => {
      cancelled = true;
      window.clearInterval(tick);
    };
  }, [customName]);

  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-4xl p-6">
        <AppsConnect />
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta = {
  title: "Apps/Connect name at create time (PAP-11283)",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

export const DefaultName: Story = {
  name: "Gallery key step — default name",
  render: () => <KeyStepHost />,
};

export const CustomName: Story = {
  name: "Gallery key step — custom name",
  render: () => <KeyStepHost customName="Zapier (stdio smoke)" />,
};
