import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import {
  aggregatorProviderQuestion,
  AGGREGATOR_NAMES,
  type ConnectionSearchResultItem,
  type RemoteMcpConnectorId,
} from "@paperclipai/shared";
import { RemoteMcpAccountChoice } from "@/features/connections/remote-mcp/RemoteMcpAccountChoice";
import { QuestionForm } from "@/components/task-chat/QuestionForm";
import { RemoteMcpConnectionReview } from "../prototypes/RemoteMcpConnectionReview";

function ProviderChoice({
  existing = false,
  onlyOne = false,
}: {
  existing?: boolean;
  onlyOne?: boolean;
}) {
  const [choice, setChoice] = useState<string>();
  const providers: RemoteMcpConnectorId[] = onlyOne
    ? ["composio"]
    : ["composio", "arcade", "executor", "zapier"];
  const routes: ConnectionSearchResultItem[] = providers.map((provider) => ({
    service: `via:${provider}:hubspot`,
    name: `HubSpot through ${AGGREGATOR_NAMES[provider]}`,
    source: "aggregator",
    state: "available",
    methods: [],
    description: null,
    logoUrl: null,
    connectionId: null,
    reason: "Authorize HubSpot in this external service.",
    aggregator: {
      provider,
      targetService: "hubspot",
      targetName: "HubSpot",
      evidenceUrl: null,
      verifiedAt: "2026-09-23",
      readiness: existing
        ? "requires_app_verification"
        : "requires_provider_setup",
    },
  }));
  const question = aggregatorProviderQuestion("hubspot", "HubSpot", routes);
  if (choice === "none")
    return (
      <div role="status" className="p-6">
        No external connection was created. HubSpot access remains unavailable.
      </div>
    );
  if (choice && existing)
    return (
      <div className="space-y-3 p-6">
        <h2 className="text-lg font-semibold">External provider connected</h2>
        <p>
          {AGGREGATOR_NAMES[choice as RemoteMcpConnectorId]} is available.
          HubSpot access still needs to be verified.
        </p>
        <p className="text-sm text-muted-foreground">
          The agent checks the requested action and asks you to authorize
          HubSpot if needed.
        </p>
      </div>
    );
  if (choice)
    return (
      <RemoteMcpConnectionReview
        provider={choice as RemoteMcpConnectorId}
        upstreamServiceName="HubSpot"
        inline
        scenario="initial"
      />
    );
  return (
    <div className="mx-auto max-w-3xl p-6">
      <p className="mb-4 text-sm text-muted-foreground">
        Design review: simulated provider support, including an Executor
        workspace with HubSpot configured. No external requests.
      </p>
      <QuestionForm
        id="provider-choice-review"
        questionSet={{
          schema: "paperclip.question_set.v1",
          questions: [
            {
              id: question.id,
              header: "Connection",
              prompt: question.prompt,
              helpText: question.helpText ?? undefined,
              required: true,
              answerMode: "single_select",
              options: question.options.map((option) => ({
                ...option,
                description: option.description ?? undefined,
              })),
            },
          ],
        }}
        onSubmit={(response) => {
          const selected =
            response.answers[question.id]?.selectedOptionIds?.[0];
          if (selected)
            setChoice(selected === "none" ? "none" : selected.split(":")[1]);
        }}
      />
    </div>
  );
}
const meta = {
  title: "Apps/Connections/Provider choice",
  component: ProviderChoice,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ProviderChoice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ChooseProvider: Story = {};
export const OnlyOneProvider: Story = { args: { onlyOne: true } };
export const NarrowChoice: Story = {
  globals: { viewport: { value: "mobile", isRotated: false } },
};
export const Decline: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("radio", { name: /None for now/ }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Submit answers" }),
    );
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "No external connection was created",
    );
  },
};
export const SecondProvider: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("radio", { name: /^Arcade/ }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Submit answers" }),
    );
    await expect(
      within(document.body).getByRole("heading", {
        name: "Connect HubSpot through Arcade",
      }),
    ).toBeVisible();
  },
};
export const ExistingAccount: Story = {
  args: { existing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("radio", { name: /^Composio/ }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Submit answers" }),
    );
    await expect(
      canvas.getByText(/HubSpot access still needs to be verified/),
    ).toBeVisible();
  },
};

export const ReuseAccount: Story = {
  render: function ReuseAccountStory() {
    const [selected, setSelected] = useState(false);
    return (
      <div className="mx-auto max-w-3xl p-6">
        {selected ? (
          <p role="status">
            Arcade is available. HubSpot authorization still needs to be
            verified.
          </p>
        ) : (
          <RemoteMcpAccountChoice
            providerName="Arcade"
            upstreamServiceName="HubSpot"
            connections={[
              { id: "review-arcade", name: "Existing Arcade account" },
            ]}
            onSelect={() => setSelected(true)}
            onConnectNew={() => {}}
          />
        )}
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Connect HubSpot through Arcade" }),
    ).toBeVisible();
    await expect(
      canvas.getByText(
        /Arcade is an external service that handles the connection and requests to HubSpot/,
      ),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Existing Arcade account" }),
    );
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "HubSpot authorization still needs to be verified",
    );
  },
};
