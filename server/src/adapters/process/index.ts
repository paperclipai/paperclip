import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const processAdapter: ServerAdapterModule = {
  type: "process",
  runtimeToolDelivery: "environment",
  execute,
  testEnvironment,
  models: [],
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: `# process agent configuration

Adapter: process

Core fields:
- command (string, required): command to execute
- args (string[] | string, optional): command arguments
- cwd (string, optional): absolute working directory
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Canonical writer-root admission (optional, operator provisioning):
- executionResourceResolver (object, optional): admits the run against the exact
  canonical writable lane the command will mutate, before any adapter or model
  work. Omit it and the adapter behaves exactly as before.
  - command (string, required): absolute path to the fixed executable
  - entry (string, required): absolute path to the resolver script
  - template (string, required): absolute path to the operator-owned template
  - timeoutMs (number, optional): 1000..60000, default 15000
  Paperclip invokes exactly: <command> <entry> <template>
  --resolve-execution-resource '<json scope>' with the scope
  {companyId, projectId, workMode} taken from the run's own bound issue. It
  reads one JSON receipt from stdout:
  {schemaVersion:1, kind:"paperclip_execution_writer_resource", access:
  "isolated"|"read_only"|"exclusive", writerRootKey: "writer-root-v1:<64 hex>" | null
  (the canonical physical lane, required for read_only AND exclusive, null only for isolated),
  configIdentity: "writer-config-v1:<64 hex>"}. Every non-isolated receipt
  reserves the canonical writer root it names before the run starts, so
  read/write overlap is serialized by native scheduling: an exclusive run waits
  for any live holder of that root, a read_only run waits only for a live
  writer, and two read_only runs on one root run concurrently. A live holder
  whose receipt predates the canonical identity is treated as touching the root,
  so an unidentified holder is never overlapped by accident. A live run is never
  evicted: a holder stops counting only once it is silent past recovery's own
  suspicion bar (the contained runner tears its own container down when its
  launcher dies). An unreadable, malformed or failed
  resolution is a configuration-incomplete blocker for the human owner, never a
  dispatched-then-failed run. Nothing in a task, a model or a wake can set a
  command, a path or an argument here.
`,
};
