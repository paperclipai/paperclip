# State & Scheduling

Read the current Cloudflare documentation before implementing state, SQL, or scheduling; check installed SDK versions when adapting an existing agent.

| Task | Documentation |
|------|---------------|
| Define state, validate updates, choose state versus SQL, and query SQLite | [Store and sync state](https://developers.cloudflare.com/agents/runtime/lifecycle/state/) |
| Synchronize state with React or vanilla JavaScript clients | [Client SDK](https://developers.cloudflare.com/agents/communication-channels/chat/client-sdk/) |
| Select delayed, date-based, cron, or interval execution; manage schedules and callbacks | [Schedule tasks](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/) |
| Configure schedule retry behavior | [Retries](https://developers.cloudflare.com/agents/runtime/execution/retries/) |
| Handle lifecycle events, connections, and hibernation | [WebSockets](https://developers.cloudflare.com/agents/runtime/communication/websockets/) |

Use synchronized state for data clients need immediately, and SQL for larger collections, history, or queries. Reject invalid updates in the validation hook; state-change notifications are for reacting to accepted updates. Use the state documentation for current hook names and behavior.

Choose a one-time delay or date for work that runs once, cron for calendar recurrence, and an interval for a fixed cadence. For queued work and retry tradeoffs, see [queue-retries.md](queue-retries.md).
