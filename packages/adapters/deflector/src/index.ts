export const type = "deflector_local";
export const label = "Deflector";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# deflector_local agent configuration

Adapter: deflector_local

Non-AI pre-check adapter. Matches assigned issues against a deterministic
SQLite pattern KB and auto-resolves only high-confidence repeats.

Core fields:
- kbPath (string, optional): absolute path to kb.sqlite
  Default: ~/.paperclip/instances/default/deflector/kb.sqlite
- auditPath (string, optional): absolute path to audit log JSONL
  Default: ~/.paperclip/instances/default/deflector/audit.jsonl
- dryRun (boolean, optional, default false): match and log only, never PATCH
- apiBaseUrl (string, optional): override Paperclip API base URL

Notes:
- Bias is toward doing nothing. Uncertain matches are skipped.
- No embeddings, no vector DB, no LLM.
`;
