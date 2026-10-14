import { userEvent, within } from "storybook/test";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Decorator } from "@storybook/react-vite";
import { useCompany } from "@/context/CompanyContext";
import { ToastViewport } from "@/components/ToastViewport";
import { queryKeys } from "@/lib/queryKeys";
import {
  createPrivacyState,
  installPrivacyApi,
  privacyAgents,
  privacyCompanyId,
  type PrivacyScenario,
  type PrivacyState,
} from "../../fixtures/privateTasks";

const PrivacyContext = createContext<PrivacyState | null>(null);
export function usePrivacyStory() {
  const state = useContext(PrivacyContext);
  if (!state) throw new Error("Private task stories require PrivacySandbox");
  return state;
}

function PrivacySandbox({
  options,
  children,
}: {
  options: PrivacyScenario;
  children: ReactNode;
}) {
  const [state] = useState(() => createPrivacyState(options));
  const [ready, setReady] = useState(false);
  const queryClient = useQueryClient();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  useLayoutEffect(() => {
    const restore = installPrivacyApi(state);
    queryClient.setQueryData(queryKeys.auth.session, state.session);
    queryClient.setQueryData(queryKeys.access.currentBoardAccess, state.access);
    queryClient.setQueryData(
      queryKeys.agents.list(privacyCompanyId),
      privacyAgents,
    );
    queryClient.setQueryData(
      queryKeys.projects.list(privacyCompanyId),
      state.projects,
    );
    setSelectedCompanyId(privacyCompanyId);
    setReady(true);
    return restore;
  }, [state, queryClient, setSelectedCompanyId]);
  return ready && selectedCompanyId === privacyCompanyId ? (
    <PrivacyContext.Provider value={state}>{children}</PrivacyContext.Provider>
  ) : null;
}

export const privacyDecorator: Decorator = (Story, context) => (
  <PrivacySandbox key={context.id} options={context.parameters.privacy ?? {}}>
    <Story />
  </PrivacySandbox>
);

export const privacyParameters = {
  layout: "fullscreen",
  // Each canvas gets an iframe: several open dialogs and scoped fetch fixtures
  // must never share one document on the autodocs page.
  docs: { story: { inline: false, height: "760px" } },
};
export const mobile = { viewport: { value: "mobile", isRotated: false } };

export function StoryFrame({ children }: { title: string; story: string; checks: string[]; children: ReactNode }) {
  return <main className="min-h-screen bg-background p-6 text-foreground"><div className="mx-auto max-w-4xl">{children}<ToastViewport /></div></main>;
}

export async function choosePrivateTask(page: ReturnType<typeof within>) {
  await userEvent.click(await page.findByRole("button", { name: "Add to composer" }));
  await userEvent.click(await page.findByTestId("composer-add-private"));
}

export async function openProjectMemberPicker(canvasElement: HTMLElement) {
  const page = within(canvasElement.ownerDocument.body);
  const dialog = await page.findByRole("dialog", {
    name: "Private project access",
  });
  const trigger = within(dialog).getByRole("combobox");
  if (trigger.getAttribute("aria-expanded") !== "true")
    await userEvent.click(trigger);
  await page.findByRole("dialog", { name: "Add a person or agent" });
}
