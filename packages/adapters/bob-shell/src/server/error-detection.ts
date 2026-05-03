import { asString } from "@paperclipai/adapter-utils/server-utils";

/**
 * Error classification for Bob Shell runs
 */
export interface BobErrorClassification {
  type: 'session' | 'api' | 'auth' | 'config' | 'execution' | 'timeout' | 'max_turns' | 'unknown';
  code: string;
  message: string;
  isRetryable: boolean;
  details?: Record<string, unknown>;
}

// Legacy type alias for backward compatibility
export type ErrorClassification = BobErrorClassification;

/**
 * Detects if Bob Shell requires authentication/login
 */
export function detectBobAuthRequired(input: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): { requiresAuth: boolean; message: string | null } {
  const { exitCode, stdout, stderr } = input;
  
  // Common auth error patterns
  const authPatterns = [
    /authentication\s+(?:required|failed)/i,
    /not\s+(?:authenticated|logged\s+in)/i,
    /invalid\s+(?:api\s+)?key/i,
    /unauthorized/i,
    /401\s+unauthorized/i,
    /access\s+denied/i,
    /permission\s+denied/i,
  ];

  const allOutput = [stdout, stderr].join("\n");
  const requiresAuth = authPatterns.some((pattern) => pattern.test(allOutput));

  if (requiresAuth) {
    // Try to extract specific error message
    const lines = allOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const errorLine = lines.find((line) => authPatterns.some((pattern) => pattern.test(line)));
    return {
      requiresAuth: true,
      message: errorLine || "Authentication required",
    };
  }

  return { requiresAuth: false, message: null };
}

/**
 * Detects if Bob Shell encountered a session error
 */
export function detectBobSessionError(input: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): boolean {
  const { exitCode, stdout, stderr } = input;

  // Session error patterns
  const sessionErrorPatterns = [
    /session\s+(?:not\s+found|invalid|expired|corrupted|does\s+not\s+exist)/i,
    /no\s+(?:such\s+)?session/i,
    /unknown\s+session/i,
    /session\s+.*\s+not\s+found/i,
    /failed\s+to\s+(?:resume|restore)\s+session/i,
    /could\s+not\s+(?:resume|restore)\s+session/i,
  ];

  const allOutput = [stdout, stderr].join("\n");
  return sessionErrorPatterns.some((pattern) => pattern.test(allOutput));
}

/**
 * Detects if Bob Shell hit max turns limit
 */
export function detectBobMaxTurns(input: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): boolean {
  const { exitCode, stdout, stderr } = input;

  // Max turns patterns
  const maxTurnsPatterns = [
    /max(?:imum)?\s+turns?\s+(?:reached|exceeded|limit)/i,
    /turn\s+limit\s+(?:reached|exceeded)/i,
    /too\s+many\s+turns/i,
    /exceeded\s+(?:maximum\s+)?turn\s+count/i,
  ];

  const allOutput = [stdout, stderr].join("\n");
  return maxTurnsPatterns.some((pattern) => pattern.test(allOutput));
}

/**
 * Detects if Bob Shell timed out
 */
export function detectBobTimeout(input: {
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): boolean {
  if (input.timedOut) return true;

  // Additional timeout patterns in output (but not API timeouts)
  const allOutput = [input.stdout, input.stderr].join("\n").toLowerCase();
  
  // Exclude API-related timeouts
  if (allOutput.includes('api') && allOutput.includes('timeout')) {
    return false;
  }
  if (allOutput.includes('request timeout')) {
    return false;
  }
  
  const timeoutPatterns = [
    /execution\s+(?:timed?\s+out|timeout)/i,
    /process\s+(?:timed?\s+out|timeout)/i,
    /command\s+(?:timed?\s+out|timeout)/i,
    /execution\s+time\s+limit/i,
  ];

  return timeoutPatterns.some((pattern) => pattern.test(allOutput));
}

/**
 * Classifies Bob Shell error for retry logic
 */
export function classifyBobError(input: {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}): BobErrorClassification {
  const { exitCode, signal, timedOut, stdout, stderr } = input;

  // Check for timeout first (before other checks)
  if (detectBobTimeout({ timedOut, exitCode, stdout, stderr })) {
    return {
      type: "timeout",
      code: "timeout",
      message: "Execution timed out",
      isRetryable: false,
    };
  }

  const stderrLower = stderr.toLowerCase();
  const stdoutLower = stdout.toLowerCase();

  // Check for session errors (retryable)
  if (detectBobSessionError({ exitCode, stdout, stderr })) {
    let code = "session_error";
    if (stderrLower.includes('session not found') || stdoutLower.includes('session not found')) {
      code = "session_not_found";
    } else if (stderrLower.includes('session expired') || stdoutLower.includes('session expired')) {
      code = "session_expired";
    } else if (stderrLower.includes('session corrupted') || stdoutLower.includes('session corrupted')) {
      code = "session_corrupted";
    }
    
    return {
      type: "session",
      code,
      message: "Session error - will retry with new session",
      isRetryable: true,
      details: { hint: 'Session may have expired or been deleted' },
    };
  }

  // Check for API errors (retryable) - must come before auth check
  if (stderrLower.includes('rate limit') || stdoutLower.includes('rate limit')) {
    return {
      type: "api",
      code: "api_rate_limit",
      message: "API rate limit exceeded",
      isRetryable: true,
      details: { hint: 'Wait before retrying' },
    };
  }

  // API timeout must be checked before general timeout patterns
  if ((stderrLower.includes('api') && stderrLower.includes('timeout')) || 
      stderrLower.includes('request timeout')) {
    return {
      type: "api",
      code: "api_timeout",
      message: "API request timed out",
      isRetryable: true,
      details: { hint: 'Network or API server issue' },
    };
  }

  if (stderrLower.includes('server error') || stderrLower.includes('500') || 
      stderrLower.includes('502') || stderrLower.includes('503')) {
    return {
      type: "api",
      code: "api_server_error",
      message: "API server error",
      isRetryable: true,
      details: { hint: 'Temporary server issue' },
    };
  }

  // Check for auth errors
  const authCheck = detectBobAuthRequired({ exitCode, stdout, stderr });
  if (authCheck.requiresAuth) {
    // Distinguish between invalid and missing auth
    const isInvalidAuth = stderrLower.includes('authentication failed') || 
                          stderrLower.includes('invalid api key') ||
                          stdoutLower.includes('authentication failed') ||
                          stdoutLower.includes('invalid api key');
    
    return {
      type: "auth",
      code: isInvalidAuth ? "auth_invalid" : "auth_required",
      message: authCheck.message || "Authentication required",
      isRetryable: false,
      details: { hint: 'Check API key configuration' },
    };
  }

  // Check for config errors
  if (stderrLower.includes('invalid configuration') || stderrLower.includes('invalid config') ||
      stdoutLower.includes('invalid configuration') || stdoutLower.includes('invalid config')) {
    return {
      type: "config",
      code: "config_invalid",
      message: "Invalid configuration",
      isRetryable: false,
      details: { hint: 'Check agent configuration' },
    };
  }

  // Check for tool errors
  if (stderrLower.includes('tool error') || stderrLower.includes('command failed') ||
      stdoutLower.includes('tool error') || stdoutLower.includes('command failed')) {
    return {
      type: "execution",
      code: "tool_error",
      message: "Tool execution failed",
      isRetryable: false,
      details: { hint: 'Check tool parameters and permissions' },
    };
  }

  // Check for max turns
  if (detectBobMaxTurns({ exitCode, stdout, stderr })) {
    return {
      type: "max_turns",
      code: "max_turns",
      message: "Maximum turns limit reached",
      isRetryable: false,
    };
  }

  // User cancellation
  if (stderrLower.includes('cancelled') || stderrLower.includes('interrupted') || signal === 'SIGINT') {
    return {
      type: "execution",
      code: "user_cancelled",
      message: "Execution cancelled by user",
      isRetryable: false,
    };
  }

  // Generic execution error
  if (exitCode !== null && exitCode !== 0) {
    return {
      type: "execution",
      code: "execution_error",
      message: `Bob Shell exited with code ${exitCode}`,
      isRetryable: false,
      details: { exitCode },
    };
  }

  // Unknown error
  return {
    type: "unknown",
    code: "unknown",
    message: `Bob Shell failed with exit code ${exitCode ?? "unknown"}`,
    isRetryable: false,
  };
}

/**
 * Describes Bob Shell failure for logging
 */
export function describeBobFailure(input: {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}): string {
  const classification = classifyBobError(input);
  
  const parts: string[] = ['Bob Shell run failed:', classification.message];

  if (classification.type !== 'unknown') {
    parts.push(`type=${classification.type}`);
  }

  if (input.exitCode !== null) {
    parts.push(`exitCode=${input.exitCode}`);
  }

  if (input.signal) {
    parts.push(`signal=${input.signal}`);
  }

  if (classification.isRetryable) {
    parts.push('retryable=true');
  }

  if (classification.details?.hint) {
    parts.push(`hint="${classification.details.hint}"`);
  }

  // Add relevant stderr excerpt (first non-empty line)
  const stderrLines = input.stderr.split('\n').filter(line => line.trim());
  if (stderrLines.length > 0) {
    const relevantLine = stderrLines[0].trim();
    if (relevantLine.length > 0 && !parts[1].toLowerCase().includes(relevantLine.toLowerCase())) {
      parts.push(`stderr="${relevantLine}"`);
    }
  }

  return parts.join(' ');
}

/**
 * Detects if an error is session-related (for future session management)
 */
export function isSessionError(classification: BobErrorClassification): boolean {
  return classification.type === 'session';
}

/**
 * Determines if an error should trigger a retry
 */
export function shouldRetry(classification: BobErrorClassification, attemptNumber: number, maxAttempts: number = 2): boolean {
  return classification.isRetryable && attemptNumber < maxAttempts;
}
