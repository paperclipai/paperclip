import { Layout } from "@/components/Layout";
export { AgentChats as AgentChatSidebarLanding } from "@/pages/AgentChats";
import type { SidebarScenario } from "./fixtures";

/** Story fixtures feed the production navigation and chat pages. */
export function AgentChatSidebarReviewLayout(_props: { scenario: SidebarScenario }) {
  return <Layout sidebarSections={<></>} />;
}
