import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { getAppStoreDefinition } from "@paperclipai/shared";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { useNavigate } from "@/lib/router";

const workspace = getAppStoreDefinition("google-workspace")!;
const noop = () => {};

const meta = {
  title: "Apps/Connections/Google Workspace",
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      if (url.pathname.endsWith("/tools/gallery")) return Response.json({
        apps: [{ ...workspace, ownershipAvailability: { ...workspace.ownershipAvailability, platform_shared: true } }],
        capabilities: { canCreateOrganizationGrant: true, canSetCompanyInstall: true },
      });
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(method.toUpperCase())) {
        return Response.json({ error: "Preview only: no Google authorization was started." }, { status: 422 });
      }
      return original(input, init);
    };
    return () => { window.fetch = original; };
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Setup() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    navigate("/apps/connect?source=google-workspace", { replace: true });
    setReady(true);
  }, [navigate]);
  return <div className="mx-auto max-w-5xl space-y-6 p-6 text-foreground">
    <p className="text-xs text-muted-foreground">Production setup UI with simulated account data. Google consent and provider calls are not simulated as successful.</p>
    {ready && <ConnectionSetupFlow serviceSlug="google-workspace" onCancel={noop} />}
  </div>;
}

export const Connect: Story = { render: () => <Setup /> };
export const Light: Story = { ...Connect, globals: { theme: "light" } };
export const Mobile: Story = { ...Connect, globals: { viewport: { value: "mobile", isRotated: false } } };
