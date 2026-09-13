import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { CodexLocalConfigFields } from "@/adapters/codex-local/config-fields";
import { CliAuthPage } from "@/pages/CliAuth";
import { WorkFolderStoryProvider } from "../fixtures/WorkFolderStoryProvider";

function PiConfiguration() {
  const [config, setConfig] = useState<Record<string, unknown>>({
    provider: "acpx",
    acpxAgent: "pi",
    model: "openrouter/deepseek/deepseek-v4-flash-0731",
    lifecycleMode: "warm",
    acpxPermissionMode: "approve-all",
  });
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">Native runner configuration</h1>
      <p className="text-sm text-muted-foreground">
        The existing runtime fields with the new Pi option selected. Changes
        stay in this story.
      </p>
      <CodexLocalConfigFields
        mode="edit"
        isCreate={false}
        adapterType="paperclip_runner"
        values={null}
        set={null}
        config={config}
        eff={(_group, _field, original) => original}
        mark={(_group, field, value) =>
          setConfig((previous) => ({ ...previous, [field]: value }))
        }
        models={[]}
        hideInstructionsFile
        managedSandboxOnly
      />
    </div>
  );
}

function CliAuthScenario({
  state,
}: {
  state: "pending" | "approved" | "signin" | "expired";
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const path = "/cli-auth/storybook-challenge";
  useState(() => {
    client.setQueryData(
      ["cli-auth-challenge", "storybook-challenge", "storybook-demo"],
      {
        id: "storybook-challenge",
        status: state === "signin" ? "pending" : state,
        requiresSignIn: state === "signin",
        canApprove: state === "pending",
        command: "paperclipai auth login",
        clientName: "Design review fixture",
        requestedAccess: "board",
        requestedCompanyName: "Paperclip Storybook",
      },
    );
    return true;
  });
  const onRoute = location.pathname === path;
  useEffect(() => {
    if (!onRoute) navigate(`${path}?token=storybook-demo`, { replace: true });
  }, [onRoute, navigate]);
  return onRoute ? (
    <Routes>
      <Route path="/cli-auth/:id" element={<CliAuthPage />} />
    </Routes>
  ) : null;
}
const meta = {
  title: "Work folders/Supporting UI",
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The two supporting UI changes in the feature stack: the Pi ACPX selector and Cloud-aware CLI approval states. These render the real components. The CLI challenge is fictional; these stories do not grant access or create credentials.",
      },
    },
  },
  decorators: [
    (Story) => (
      <WorkFolderStoryProvider>
        <Story />
      </WorkFolderStoryProvider>
    ),
  ],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const NativePiConfiguration: Story = {
  render: () => <PiConfiguration />,
};
export const CliAccessRequest: Story = {
  render: () => <CliAuthScenario state="pending" />,
};
export const CliAccessApproved: Story = {
  render: () => <CliAuthScenario state="approved" />,
};
export const CliSignInRequired: Story = {
  render: () => <CliAuthScenario state="signin" />,
};
export const CliRequestExpired: Story = {
  render: () => <CliAuthScenario state="expired" />,
};
