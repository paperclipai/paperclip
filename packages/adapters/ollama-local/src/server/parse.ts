/**
 * v0.1 parser stubs. The adapter does not produce a structured transcript
 * format yet; logs are streamed live via onLog from execute.ts. Reserved for
 * a future session-resume / replay implementation.
 */
export function parseOllamaTranscript(_raw: string): { messages: string[]; finalMessage: string | null } {
  return { messages: [], finalMessage: null };
}
