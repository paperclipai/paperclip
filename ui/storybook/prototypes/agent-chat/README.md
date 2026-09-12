# Agent chat production fixtures

These stories mount `AgentChat`, `TaskDetailSurface`, `Layout`, and their actual task transcript, composer, and side panel. They provide in-memory API responses; they contain no alternate chat controller or renderer. Sending appends a fixture comment, `/new` adds a shared session marker, and switching agents preserves each fixture history during the mounted story. Unsupported mutations fail explicitly.

The sidebar uses production resource memberships and company/user-scoped recent conversation visits. Starred agents sort alphabetically, followed by four recent unstarred agents. Stars appear on hover/focus. The gear and See all agents render the real agent configuration and roster pages. Roster Chat actions open the corresponding conversation.

Scenarios cover returning, first conversation, working, paused, failed send, long history, collapsed panel, light theme, ordinary task comparison, `/new`, and disabled experiment. Production API/runtime behavior is verified by server database/route tests; fixture replies do not represent live provider execution.
