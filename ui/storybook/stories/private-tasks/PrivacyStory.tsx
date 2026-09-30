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

export function StoryFrame({
  title,
  story,
  checks,
  children,
}: {
  title: string;
  story: string;
  checks: string[];
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Private tasks · Interactive product review
          </p>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{story}</p>
        </header>
        <section
          aria-label="Production component"
          className="rounded-lg border border-border bg-card p-4"
        >
          {children}
        </section>
        <aside className="space-y-2 text-sm text-muted-foreground">
          <h2 className="font-medium text-foreground">What to review</h2>
          <ul className="list-disc space-y-1 pl-5">
            {checks.map((check) => (
              <li key={check}>{check}</li>
            ))}
          </ul>
          <p className="pt-2 text-xs">
            Fictional company and in-memory API responses. Interactions reset on
            story reload. These stories review the UX; server authorization is
            covered by the feature's integration tests.
          </p>
        </aside>
        <ToastViewport />
      </div>
    </main>
  );
}

/** Radix may focus/open the selector on mount. Explicitly open it when it
 * remains closed, without toggling an already-open selector back shut. */
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
