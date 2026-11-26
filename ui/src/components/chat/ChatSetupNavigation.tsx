import { useQuery } from "@tanstack/react-query";
import type { GitHubAppWizardState } from "@paperclipai/shared";
import { githubChatApi } from "@/api/githubChat";
import { useSearchParams } from "@/lib/router";
import { SetupWizardNavigation, SetupWizardSidebar } from "../SetupWizard";
import { SidebarNavItem } from "../SidebarNavItem";
import { ChatDetailSidebar } from "./ChatDetailSidebar";

/** Once setup completes, reuse the connection's normal management navigation. */
export function ChatSetupSidebar({ NavItem = SidebarNavItem }: { NavItem?: typeof SidebarNavItem }) {
  const [params] = useSearchParams();
  const resume = params.get("resume");
  // Observe progress owned and fetched by the wizard; the sidebar never advances setup.
  const progress = useQuery<GitHubAppWizardState>({
    queryKey: ["github-wizard", resume],
    queryFn: () => githubChatApi.advance(resume!),
    enabled: false,
  });
  return params.get("provider") === "github" && resume &&
    params.get("stage") !== "identity" && params.get("reconnect") !== "1" &&
    progress.data?.state === "connected"
    ? <ChatDetailSidebar endpointId={resume} NavItem={NavItem} />
    : <SetupWizardSidebar />;
}
export function ChatSetupNavigation(props: {
  labels?: string[]; step: number; availableStep: number; disabled?: boolean; onSelect: (step: number) => void;
}) {
  return <SetupWizardNavigation {...props} labels={props.labels ?? ["Choose agent", "Connect provider", "Try it"]} ariaLabel="Connection setup progress" />;
}
