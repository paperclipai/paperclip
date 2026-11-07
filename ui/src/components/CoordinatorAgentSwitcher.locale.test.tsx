import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { CoordinatorAgentSwitcher } from "./CoordinatorAgentSwitcher";
import type { Agent } from "@paperclipai/shared";

vi.mock("./AgentChatPicker", () => ({ AgentChatPicker: ({ trigger }: { trigger: React.ReactNode }) => trigger }));
vi.mock("./AgentAvatar", () => ({ AgentAvatar: () => null }));
vi.mock("@/hooks/useAgentChatNavigation", () => ({ useAgentChatNavigation: () => ({ agents: { data: [] }, chats: { data: [] } }) }));
vi.mock("@/lib/router", () => ({ useNavigate: () => vi.fn() }));

afterEach(async () => { await i18n.changeLanguage("en"); });

it("localizes shell accessibility copy without translating agent names", async () => {
  const agent = { name: "Acme Agent", id: "agent-a" } as Agent;
  await i18n.changeLanguage("en");
  expect(renderToStaticMarkup(<CoordinatorAgentSwitcher agent={agent} />)).toContain('aria-label="Switch agent. Currently Acme Agent"');
  await i18n.changeLanguage("zh-CN");
  const markup = renderToStaticMarkup(<CoordinatorAgentSwitcher agent={agent} />);
  expect(markup).toContain('aria-label="切换智能体。当前为 Acme Agent"');
  expect(markup).toContain('title="切换智能体"');
  expect(markup).toContain('>Acme Agent</span>');
});
