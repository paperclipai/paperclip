import { describe, it, expect } from 'vitest';
import {
  classifyBobError,
  describeBobFailure,
  isSessionError,
  shouldRetry,
} from '../error-detection.js';

describe('classifyBobError', () => {
  describe('timeout errors', () => {
    it('should classify timeout errors', () => {
      const result = classifyBobError({
        exitCode: null,
        signal: 'SIGTERM',
        timedOut: true,
        stdout: '',
        stderr: '',
      });

      expect(result.type).toBe('timeout');
      expect(result.code).toBe('timeout');
      expect(result.isRetryable).toBe(false);
    });
  });

  describe('session errors', () => {
    it('should classify session not found errors', () => {
      const result = classifyBobError({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: 'Error: Session not found: bob-session-123',
      });

      expect(result.type).toBe('session');
      expect(result.code).toBe('session_not_found');
      expect(result.isRetryable).toBe(true);
    });

    it('should classify session expired errors', () => {
      const result = classifyBobError({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: 'Error: Session expired: bob-session-123',
      });

      expect(result.type).toBe('session');
      expect(result.code).toBe('session_expired');
      expect(result.isRetryable).toBe(true);
    });

    it('should classify session corrupted errors', () => {
      const result = classifyBobError({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: 'Error: Session corrupted',
      });

      expect(result.type).toBe('session');
      expect(result.code).toBe('session_corrupted');
      expect(result.isRetryable).toBe(true);
    });
  });

  describe('API errors', () => {
    it('should classify rate limit errors', () => {
      const result = classifyBobError({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: 'Error: API rate limit exceeded',
      });

      expect(result.type).toBe('api');
      expect(result.code).toBe('api_rate_limit');
      expect(result.isRetryable).toBe(true);
    });

    it('should classify API timeout errors', () => {
      const result = classifyBobError({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: 'Error: API request timeout',
      });

      expect(result.type).toBe('api');
      expect(result.code).toBe('api_timeout');
      expect(result.isRetryable).toBe(true);
    });

    it('should classify server errors', () => {
      const result = classifyBobError({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: 'Error: Server error 503',
      });

      expect(result.type).toBe('api');
      expect(result.code).toBe('api_server_error');
      expect(result.isRetryable).toBe(true);
    });
  });

  describe('configuration errors', () => {
    it('should classify invalid auth errors', () => {
      const result = classifyBobError({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: 'Error: Authentication failed',
      });

      expect(result.type).toBe('auth');
      expect(result.code).toBe('auth_invalid');
      expect(result.isRetryable).toBe(false);
    });

    it('should classify auth required errors', () => {
      const result = classifyBobError({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: 'Error: Authentication required',
      });

      expect(result.type).toBe('auth');
      expect(result.code).toBe('auth_required');
      expect(result.isRetryable).toBe(false);
    });

    it('should classify invalid config errors', () => {
      const result = classifyBobError({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: 'Error: Invalid configuration',
      });

      expect(result.type).toBe('config');
      expect(result.code).toBe('config_invalid');
      expect(result.isRetryable).toBe(false);
    });
  });

  describe('execution errors', () => {
    it('should classify tool errors', () => {
      const result = classifyBobError({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: 'Error: Tool error: command failed',
      });

      expect(result.type).toBe('execution');
      expect(result.code).toBe('tool_error');
      expect(result.isRetryable).toBe(false);
    });

    it('should classify user cancellation', () => {
      const result = classifyBobError({
        exitCode: 130,
        signal: 'SIGINT',
        timedOut: false,
        stdout: '',
        stderr: '',
      });

      expect(result.type).toBe('execution');
      expect(result.code).toBe('user_cancelled');
      expect(result.isRetryable).toBe(false);
    });

    it('should classify generic execution errors', () => {
      const result = classifyBobError({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: 'Some unknown error',
      });

      expect(result.type).toBe('execution');
      expect(result.code).toBe('execution_error');
      expect(result.isRetryable).toBe(false);
    });
  });

  describe('unknown errors', () => {
    it('should classify unknown errors', () => {
      const result = classifyBobError({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: '',
      });

      expect(result.type).toBe('unknown');
      expect(result.code).toBe('unknown');
      expect(result.isRetryable).toBe(false);
    });
  });

  describe('case insensitivity', () => {
    it('should match errors case-insensitively', () => {
      const result = classifyBobError({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: 'ERROR: RATE LIMIT EXCEEDED',
      });

      expect(result.type).toBe('api');
      expect(result.code).toBe('api_rate_limit');
    });
  });
});

describe('describeBobFailure', () => {
  it('should generate detailed failure description', () => {
    const description = describeBobFailure({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: 'Error: API rate limit exceeded\nPlease try again later',
    });

    expect(description).toContain('Bob Shell run failed');
    expect(description).toContain('API rate limit exceeded');
    expect(description).toContain('type=api');
    expect(description).toContain('retryable=true');
    expect(description).toContain('hint=');
  });

  it('should include stderr details', () => {
    const description = describeBobFailure({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: 'Specific error details here',
    });

    expect(description).toContain('Bob Shell run failed');
    expect(description).toContain('stderr="Specific error details here"');
  });

  it('should handle timeout errors', () => {
    const description = describeBobFailure({
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
      stdout: '',
      stderr: '',
    });

    expect(description).toContain('Bob Shell run failed');
    expect(description).toContain('Execution timed out');
    expect(description).toContain('type=timeout');
    expect(description).toContain('signal=SIGTERM');
    expect(description).not.toContain('retryable');
  });
});

describe('isSessionError', () => {
  it('should identify session errors', () => {
    const classification = classifyBobError({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: 'Session not found',
    });

    expect(isSessionError(classification)).toBe(true);
  });

  it('should not identify non-session errors', () => {
    const classification = classifyBobError({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: 'API rate limit',
    });

    expect(isSessionError(classification)).toBe(false);
  });
});

describe('shouldRetry', () => {
  it('should allow retry for retryable errors on first attempt', () => {
    const classification = classifyBobError({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: 'API rate limit',
    });

    expect(shouldRetry(classification, 1, 2)).toBe(true);
  });

  it('should not allow retry when max attempts reached', () => {
    const classification = classifyBobError({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: 'API rate limit',
    });

    expect(shouldRetry(classification, 2, 2)).toBe(false);
  });

  it('should not allow retry for non-retryable errors', () => {
    const classification = classifyBobError({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: 'Invalid configuration',
    });

    expect(shouldRetry(classification, 1, 2)).toBe(false);
  });
});
