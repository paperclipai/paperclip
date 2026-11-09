# Agent chat discovery

Open **Design explorations → Chat entry**. The sidebar, picker, conversation,
and composer are production components backed by the agent-chat in-memory API.
Only the first-use landing page is a review fixture. No real agents run.

The earliest-created agent always stays in Chats, even after unstarring. Stars
precede that default and four recent agents. Compose and star controls align;
compose appears on hover/focus and remains visible on touch. The picker searches
the whole company by name or role, with no subtitle, count, continuation labels,
or footer. Each agent keeps a distinct fixture conversation across switches.

Stories cover first use, returning chats, picker, role search, search recovery,
paused-agent discovery, larger roster, light theme, and mobile. Try selecting
Design Lead, sending a message, switching to CodexCoder, and returning. Star a
conversation to keep it above recents. Story-scoped recent visits are restored
on unmount.

Run `pnpm storybook` from the repository root.
