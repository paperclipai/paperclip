import { describe, expect, it } from 'vitest';
import {
  describeGeminiContextWindow,
  GEMINI_AVAILABILITY_ENV_KEY,
  geminiRequiresClaudeReasoningPass,
  isGeminiAvailable,
  shouldPromoteToGeminiLongContext,
} from './index.js';

describe('orchestration.gemini — long-context hooks', () => {
  it('isGeminiAvailable defaults to false when env var unset', () => {
    expect(isGeminiAvailable({})).toBe(false);
  });

  it('isGeminiAvailable accepts truthy variants', () => {
    expect(isGeminiAvailable({ [GEMINI_AVAILABILITY_ENV_KEY]: 'true' })).toBe(true);
    expect(isGeminiAvailable({ [GEMINI_AVAILABILITY_ENV_KEY]: '1' })).toBe(true);
    expect(isGeminiAvailable({ [GEMINI_AVAILABILITY_ENV_KEY]: 'yes' })).toBe(true);
    expect(isGeminiAvailable({ [GEMINI_AVAILABILITY_ENV_KEY]: 'no' })).toBe(false);
  });

  it('shouldPromoteToGeminiLongContext fires above 200k', () => {
    expect(shouldPromoteToGeminiLongContext(199_999)).toBe(false);
    expect(shouldPromoteToGeminiLongContext(200_001)).toBe(true);
    expect(shouldPromoteToGeminiLongContext(undefined)).toBe(false);
  });

  it('describeGeminiContextWindow reports utilization and overflow', () => {
    const ok = describeGeminiContextWindow(500_000, 1_000_000);
    expect(ok.utilization).toBeCloseTo(0.5);
    expect(ok.exceeds_window).toBe(false);

    const overflow = describeGeminiContextWindow(2_500_000, 2_000_000);
    expect(overflow.utilization).toBe(1);
    expect(overflow.exceeds_window).toBe(true);
  });

  it('geminiRequiresClaudeReasoningPass fires for outbound-class sensitivity', () => {
    expect(geminiRequiresClaudeReasoningPass('internal')).toBe(false);
    expect(geminiRequiresClaudeReasoningPass('outbound')).toBe(true);
    expect(geminiRequiresClaudeReasoningPass('regulatory')).toBe(true);
    expect(geminiRequiresClaudeReasoningPass('critical')).toBe(true);
  });
});
