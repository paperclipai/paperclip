import type { AdapterFailureCategory } from "@paperclipai/adapter-utils";

/**
 * Map an adapter-emitted errorCode to the canonical AdapterFailureCategory.
 * Adapters are expected to use canonical codes directly, but legacy codes
 * (e.g. claude_auth_required) are also handled for backwards compatibility.
 */
export function categorizeAdapterError(errorCode: string | null | undefined): AdapterFailureCategory {
  if (!errorCode) return "unknown";
  switch (errorCode) {
    case "auth_required":
    case "claude_auth_required":
      return "auth_required";
    case "rate_limited":
    case "claude_rate_limited":
      return "rate_limited";
    case "session_invalid":
    case "claude_session_invalid":
      return "session_invalid";
    case "startup_failed":
    case "startup_failure":
      return "startup_failed";
    case "timeout":
      return "timeout";
    case "provider_unavailable":
      return "provider_unavailable";
    case "process_lost":
    case "process_detached":
      return "process_lost";
    case "crash_no_output":
    case "claude_crash_no_output":
      return "crash_no_output";
    case "parse_error":
    case "claude_json_parse_failed":
      return "parse_error";
    case "cancelled":
      return "cancelled";
    case "nonzero_exit":
      return "nonzero_exit";
    case "all_adapters_exhausted":
      // All adapters in the fallback chain were tried and failed
      return "unknown";
    default:
      return "unknown";
  }
}
