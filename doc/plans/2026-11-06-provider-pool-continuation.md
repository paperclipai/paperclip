# Provider pool continuation implementation — 2026-11-06

Approved behavior: ordered mixed-provider accounts; keep healthy task sessions pinned; fail over after quota/auth/definitive runner failure, with durable account cooldown (provider deadline, otherwise quota two hours), preserving workspace, task history and known completed actions. Stop, budgets, permissions and task ownership remain authoritative. No automatic replay of uncertain mutations. Existing upstream PR remains ready; verified work merges directly to local develop; no watcher.

1. Persist effective adapter/provider per selected pool run and use it consistently in admission, claim, credentials, session codec, dispatch, completion and recovery; never change the agent primary adapter.
2. Integrate bounded, durable successor admission, failure classification, account cooldown, task pin transition, termination and context continuation. Reuse current lifecycle and journals; do not require a new provider proxy/sandbox architecture.
3. Enable mixed-provider UI selection and meaningful active/waiting status; synchronize contracts/docs.
4. Verify genuine mid-run Claude-to-Claude and Claude-to-Codex paths, session missing, restart, shared cooldown, concurrent retry/Stop and completed/uncertain action behavior. Full repository checks, upstream push and direct local develop integration follow verification.
