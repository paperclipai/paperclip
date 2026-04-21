export const type = "bastionclaw_gateway";
export const label = "BastionClaw Gateway";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# bastionclaw agent configuration

Adapter: bastionclaw

Use when:
- You want Paperclip to dispatch work to a BastionClaw instance running on the same machine.
- BastionClaw manages its own Claude auth and sandboxed container execution.

Don't use when:
- BastionClaw is on a remote host (filesystem IPC requires local access).
- You need sub-second response times (BastionClaw runs full agent sessions).

Core fields:
- bastionclaw_root (string, required): absolute path to BastionClaw installation directory
- target_jid (string, optional): chat JID for task routing (default: uses main group)
- timeout_sec (number, optional): max seconds to wait for task completion (default: 1800)
- poll_interval_sec (number, optional): SQLite poll interval in seconds (default: 5)
`;
