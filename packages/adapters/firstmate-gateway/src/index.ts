export const type = "firstmate_gateway";
export const label = "FirstMate Gateway";
export const models: { id: string; label: string }[] = [];
export const agentConfigurationDoc = `# FirstMate Gateway\n\nRequired: url (wss:// relay URL) and authToken.\nOptional: timeoutSec (default 1800).\n\nPaperclip dispatches a run to FirstMate and waits for a signed lifecycle event from the bound FirstMate session. Completion is never inferred from terminal idleness.`;
