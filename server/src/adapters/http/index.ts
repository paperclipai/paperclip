import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const httpAdapter: ServerAdapterModule = {
  type: "http",
  runtimeToolDelivery: "invocation_context",
  execute,
  testEnvironment,
  models: [],
  agentConfigurationDoc: `# http agent configuration

Adapter: http

Core fields:
- url (string, required): endpoint to invoke
- method (string, optional): HTTP method, default POST
- headers (object, optional): request headers
- payloadTemplate (object, optional): JSON payload template
- timeoutMs (number, optional): invoke request timeout in milliseconds

Every string in payloadTemplate is rendered with the run's context, using the
same data the local adapters expose to promptTemplate: agentId, companyId,
runId, company, agent, run, and context. So
\`input: "Work issue {{ context.issueId }}"\` resolves per run. Non-strings pass
through untouched, so \`timeout_sec: 120\` stays a number. The exposed \`agent\` is
a narrow subset (id, name, companyId, adapterType) rather than the whole record,
because this payload leaves the box and adapterConfig can hold credentials.

Optional poll block. Without it the adapter is fire-and-forget: it returns as
soon as the endpoint accepts the request, and the remote's result is never
collected. With it, the adapter reads a run id out of the invoke response and
polls until the run reaches a terminal status, then captures output, usage,
cost, and model.

- poll.enabled (boolean): must be true, or the whole block is ignored
- poll.urlTemplate (string, required): status URL. Use DOUBLE braces:
  "https://runtime.example/runs/{{run_id}}". Single braces are not rendered,
  the literal text is requested, and every poll 404s until attempts run out.
- poll.intervalMs (number, default 2000)
- poll.maxAttempts (number, default 90)
- poll.terminalStatuses (string[], default completed/failed/succeeded/error/cancelled)
- poll.runIdPath (string, default "run_id"): dotted path in the invoke response
- poll.statusPath (string, default "status"): dotted path in the poll response
- poll.outputPath (string, default "output")
- poll.usagePath (string, default "usage")
- poll.costUsdPath / poll.modelPath / poll.providerPath (string, optional)
- poll.outputAsSummary (boolean, default false): use the captured output as the
  run summary instead of a status line, which routes it onto the issue through
  the normal run-comment path

intervalMs x maxAttempts is a hard ceiling, not a target. The defaults allow 180
seconds; a remote run that legitimately takes longer is recorded as a poll
timeout while it actually succeeds, so size this to the slowest real run.
`,
};
