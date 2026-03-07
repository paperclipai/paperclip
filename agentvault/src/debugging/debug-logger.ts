/**
 * Debug logger — only emits when AGENTVAULT_DEBUG=1 is explicitly set.
 *
 * Production rule: zero output by default so a compromised logger can never
 * leak keys, mnemonics, API tokens, or any other secret material.
 */

const DEBUG_ENABLED = process.env['AGENTVAULT_DEBUG'] === '1';

export const debugLog = DEBUG_ENABLED
  ? (...args: unknown[]): void => { console.debug('[agentvault:debug]', ...args); }
  : (): void => { /* noop in production */ };
