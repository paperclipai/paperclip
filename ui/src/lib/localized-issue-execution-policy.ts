import { buildExecutionPolicy as buildPolicy, ExecutionPolicyUnavailableError } from "./issue-execution-policy.js";
import { localizeUiError } from "./localized-ui-error.js";

export * from "./issue-execution-policy.js";

/** Keep browser presentation separate from the portable policy serializer. */
export function buildExecutionPolicy(input: Parameters<typeof buildPolicy>[0]) {
  try {
    return buildPolicy(input);
  } catch (error) {
    if (error instanceof ExecutionPolicyUnavailableError) {
      throw localizeUiError(error, { key: "integration-errors:policyUnavailable" });
    }
    throw error;
  }
}
