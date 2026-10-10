import { useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { githubChatApi } from "@/api/githubChat";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Routes, Route } from "@/lib/router";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { Layout } from "@/components/Layout";
import { GitHubChatSetup } from "@/pages/apps/chat/GitHubChatSetup";
import { GitHubConnectionComplete } from "@/pages/apps/chat/GitHubConnectionComplete";
import { ChatEndpointDetail } from "@/pages/apps/chat/ChatEndpointDetail";
import {
  GitHubPolicyEditor,
  GitHubAccessEditor,
} from "@/pages/apps/chat/GitHubBotConfiguration";
import {
  GitHubRepositoryAccess,
  GitHubReviewList,
  GitHubReviewDetail,
} from "@/pages/apps/chat/GitHubBotManagement";
import { ChatConversationList } from "@/pages/apps/chat/ChatConversationList";
import {
  GitHubAppBranding,
  GitHubBotMention,
} from "@/pages/apps/chat/GitHubAppIdentity";
import { resolveAgentAppearance } from "@paperclipai/shared";
import { agentAvatarUrl } from "@/lib/agent-avatar-url";
import {
  endpoint,
  agent,
  configuration,
  reviews,
  conversations,
} from "./fixtures";
import { FixtureApi, type FixtureState } from "./fixture-api";

const meta = {
  title: "Connectors/GitHub bot management",
  parameters: {
    layout: "fullscreen",
    initialEntries: [`/PAP/apps/chat/${endpoint.id}/settings`],
    docs: {
      description: {
        component:
          "Production pages and components. Start with **01 Journey / Settings**, then use the actual contextual sidebar to visit Access, Reviews, and Conversations. Try editing instructions, switch tabs, and save or discard the shared draft. **01 Journey / Connected** opens the production confirmation modal over the same bot Settings. Close it with Done, the ×, or Escape and continue editing Settings. **02 States** covers empty, loading, recoverable error, long content, and mobile. **03 Components** isolates the policy editor, people access, repository access, review rows and detail, pending review, and conversations. Provider operations use isolated fixture APIs; these stories are not live GitHub evidence.",
      },
    },
  },
  args: { state: "populated" as FixtureState },
  argTypes: {
    state: {
      control: "select",
      options: ["populated", "empty", "loading", "error", "long", "many", "setup", "skills", "guests", "mentions"],
    },
  },
  render: ({ state }) => (
    <FixtureApi key={state} state={state}>
      <PluginLauncherProvider>
        <Routes>
          <Route path="/:companyPrefix" element={<Layout />}>
            <Route path="apps/chat/connect" element={<GitHubChatSetup />} />
            <Route
              path="apps/chat/:endpointId/reviews/:reviewId"
              element={<ChatEndpointDetail />}
            />
            <Route
              path="apps/chat/:endpointId/:tab"
              element={<ChatEndpointDetail />}
            />
          </Route>
        </Routes>
      </PluginLauncherProvider>
    </FixtureApi>
  ),
} satisfies Meta<{ state: FixtureState }>;
export default meta;
type Story = StoryObj<typeof meta>;
const route = (tab: string) => ({
  initialEntries: [`/PAP/apps/chat/${endpoint.id}/${tab}`],
});
export const ConnectedJourney: Story = {
  name: "01 Journey / Connected — dismiss to settings",
  parameters: { initialEntries: [`/PAP/apps/chat/connect?provider=github&resume=${endpoint.id}`] },
};
export const KnownOrganizationSetup: Story = {
  name: "01 Journey / Connect — known organizations and manual entry",
  args: { state: "setup" },
  parameters: {
    initialEntries: [`/PAP/apps/chat/connect?provider=github&resume=${endpoint.id}`],
    docs: { description: { story: "Choose an existing organization, or Another organization to type a different name. Personal repository owners remain under My account. No App is created in this fixture." } },
  },
};
export const ConnectedMobile: Story = {
  ...ConnectedJourney,
  name: "02 States / Mobile connected",
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
export const ConnectedNoRepositories: Story = {
  ...ConnectedJourney,
  name: "02 States / Connected without enabled repositories",
  args: { state: "empty" },
};
export const SettingsJourney: Story = { name: "01 Journey / Settings" };
export const SkillInstructions: Story = {
  name: "01 Journey / Instructions — slash skills and automatic events",
  args: { state: "skills" },
  parameters: {
    docs: { description: { story: "The production rich editor preserves a linked skill. Type /code-review to choose it from the shared slash picker; edit event-specific instructions, save, and switch tabs. The automatic-event mode explicitly includes authorized @mentions. Skill execution is verified separately against the live test drive." } },
  },
};
export const AccessJourney: Story = {
  name: "01 Journey / Access",
  parameters: route("access"),
};
export const ReviewsJourney: Story = {
  name: "01 Journey / Reviews",
  parameters: route("reviews"),
};
export const ConversationsJourney: Story = {
  name: "01 Journey / Conversations",
  parameters: route("conversations"),
};
export const FirstUse: Story = {
  name: "02 States / No conversations",
  args: { state: "empty" },
  parameters: route("conversations"),
};
export const NoReviews: Story = {
  name: "02 States / No reviews",
  args: { state: "empty" },
  parameters: route("reviews"),
};
export const Loading: Story = {
  name: "02 States / Loading settings",
  args: { state: "loading" },
};
export const Error: Story = {
  name: "02 States / Settings failure",
  args: { state: "error" },
};
export const LongAccess: Story = {
  name: "02 States / Long repository names",
  args: { state: "long" },
  parameters: route("access"),
};
export const ThousandRepositories: Story = {
  name: "02 States / 1000 repositories",
  args: { state: "many" },
  parameters: route("access"),
};
export const RepositoryFailure: Story = {
  name: "02 States / Repository loading failure",
  args: { state: "error" },
  parameters: route("access"),
};
export const Mobile: Story = {
  name: "02 States / Mobile conversations",
  args: { state: "long" },
  parameters: {
    ...route("conversations"),
    viewport: { defaultViewport: "mobile1" },
  },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
function Policy() {
  const [policy, setPolicy] = useState(configuration.defaults);
  return <GitHubPolicyEditor policy={policy} onChange={setPolicy} />;
}
function People() {
  const [config, setConfig] = useState(configuration);
  return (
    <FixtureApi>
      <GitHubAccessEditor
        endpointId={endpoint.id}
        companyId={endpoint.companyId}
        configuration={config}
        onChange={setConfig}
      />
    </FixtureApi>
  );
}
function Repositories() {
  return <FixtureApi><RepositoryExample /></FixtureApi>;
}
function RepositoryExample() {
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const save = async (fn: () => Promise<unknown>) => {
    setPending(true);
    try {
      await fn();
      await client.invalidateQueries({ queryKey: ["github-bot-repository-pages", endpoint.id] });
    } finally { setPending(false); }
  };
  return (
    <GitHubRepositoryAccess
      endpointId={endpoint.id}
      companyId={endpoint.companyId}
      managementUrl="https://github.com/settings/installations"
      pending={pending}
      onRefresh={() => {}}
      onChange={(id, enabled) =>
        void save(() => chatEndpointsApi.updateResources(endpoint.id, [{ id, enabled }]))
      }
      onToggleAll={(enabled) => void save(() => githubChatApi.toggleAllRepositories(endpoint.id, enabled))}
    />
  );
}
const component = (children: React.ReactNode) => (
  <div className="max-w-3xl p-6">{children}</div>
);
export const InstructionsAndBehavior: Story = {
  name: "03 Components / Instructions and behavior",
  render: () => component(<Policy />),
};
export const PeopleAccess: Story = {
  name: "03 Components / People access",
  render: () => component(<People />),
};
export const RepositoryAccess: Story = {
  name: "03 Components / Repository access",
  render: () => component(<Repositories />),
};
function ConnectedExample(props: Omit<ComponentProps<typeof GitHubConnectionComplete>, "onClose">) {
  const [open, setOpen] = useState(true);
  return <>
    <Button onClick={() => setOpen(true)}>Show connected confirmation</Button>
    {open && <GitHubConnectionComplete {...props} onClose={() => setOpen(false)} />}
  </>;
}
export const ConnectedSummary: Story = {
  name: "03 Components / Connected summary",
  render: () => component(<FixtureApi><ConnectedExample endpoint={endpoint} agent={agent} /></FixtureApi>),
};
export const ConnectedRuntimeNotReady: Story = {
  name: "03 Components / Connected — runtime needs setup",
  render: () => component(<FixtureApi><ConnectedExample endpoint={endpoint} agent={agent}
    runtimeChecks={[{ key: "runtime", label: "Runtime", ok: false, detail: "Configure an isolated runtime before the first review." }]} /></FixtureApi>),
};
export const ConnectedLongName: Story = {
  name: "03 Components / Connected — long App name",
  render: () => component(<FixtureApi><ConnectedExample endpoint={{ ...endpoint,
    botLabel: "Maya Platform Accessibility Reviews", botUsername: "maya-platform-accessibility-reviews[bot]",
    providerAccountLabel: "acme-platform-engineering" }} agent={agent} /></FixtureApi>),
};
export const AppIdentityAndLogo: Story = {
  name: "03 Components / App identity and logo",
  render: () =>
    component(
      <div className="space-y-6">
        <GitHubBotMention endpoint={endpoint} />
        <GitHubAppBranding
          endpoint={endpoint}
          avatarUrl={agentAvatarUrl(
            resolveAgentAppearance(agent.appearance, agent.id),
            512,
            1,
            "rest",
          )}
        />
      </div>,
    ),
};
export const ReviewHistory: Story = {
  name: "03 Components / Review rows",
  render: () =>
    component(<GitHubReviewList endpointId={endpoint.id} reviews={reviews} />),
};
export const PendingReview: Story = {
  name: "03 Components / Pending current commit",
  render: () =>
    component(
      <GitHubReviewList
        endpointId={endpoint.id}
        reviews={[
          {
            ...reviews[0],
            state: "running",
            assessment: null,
            conclusion: null,
          },
          reviews[1],
        ]}
      />,
    ),
};
export const ConversationRows: Story = {
  name: "03 Components / Conversation rows",
  render: () =>
    component(<ChatConversationList rows={conversations} provider="github" />),
};

export const ReviewDetailJourney: Story = {
  name: "01 Journey / Review detail",
  parameters: route(`reviews/${reviews[0].id}`),
};
export const ReviewDetail: Story = {
  name: "03 Components / Review detail",
  render: () =>
    component(
      <GitHubReviewDetail endpointId={endpoint.id} review={reviews[0]} />,
    ),
};

export const SettingsMobile: Story = {
  name: "02 States / Mobile settings",
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
export const AccessMobile: Story = {
  name: "02 States / Mobile people and contributors",
  args: { state: "guests" },
  parameters: route("access"),
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
export const ContributorAccess: Story = {
  name: "02 States / Selected members and external contributors",
  args: { state: "guests" },
  parameters: route("access"),
};
export const MentionsOnly: Story = {
  name: "02 States / All linked members with automatic runs off",
  args: { state: "mentions" },
  parameters: route("access"),
};
