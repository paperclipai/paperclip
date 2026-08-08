/**
 * FakeChatModel — a deterministic, offline {@link LlmProvider} for local dev,
 * tests, and CI. It needs NO credentials and never touches the network, so the
 * entire starter kit (agents, RAG, evals) runs green without API keys.
 *
 * Behaviour is driven by a small rule table:
 *   - If a tool call is requested (`tools` present), it emits a deterministic
 *     tool call (handy for routing/agent tests).
 *   - Otherwise it echoes keyword-based canned answers (e.g. mentions of
 *     "refund" -> a policy answer, "rag" or a known fact -> grounded reply).
 *
 * A real client replaces this with {@link OpenAIChatModel} (key from the CEO's
 * secret store) and the rest of the kit is unchanged.
 */

import type { CompletionRequest, CompletionResponse, LlmProvider, ToolCall } from './types.js';

export interface FakeOptions {
  model?: string;
  /** Force a fixed response regardless of input. */
  fixedResponse?: string;
  /** Extra latency in ms (simulate network) — default 0. */
  latencyMs?: number;
  /** Injectable RNG for reproducible tests (default Math.random). */
  random?: () => number;
}

const DEFAULT_ANSWERS: { match: RegExp; reply: string }[] = [
  {
    match: /refund|return|cancel/i,
    reply:
      'Our refund policy allows returns within 30 days of purchase for a full refund. Items must be unused and in original packaging.',
  },
  {
    match: /hours|open|close|time/i,
    reply: 'We are open Monday to Friday, 9am to 5pm Eastern time.',
  },
  {
    match: /shipping|delivery|ship/i,
    reply: 'Standard shipping takes 3-5 business days. Express options are available at checkout.',
  },
  {
    match: /warranty|guarantee/i,
    reply:
      'Our warranty covers manufacturing defects for 12 months. Accidental damage is not covered.',
  },
];

export class FakeChatModel implements LlmProvider {
  readonly model: string;
  private readonly fixed?: string;
  private readonly latencyMs: number;
  private readonly random: () => number;

  constructor(opts: FakeOptions = {}) {
    this.model = opts.model ?? 'fake-chat-1';
    this.fixed = opts.fixedResponse;
    this.latencyMs = opts.latencyMs ?? 0;
    this.random = opts.random ?? Math.random;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs));
    }

    // Deterministic tool-call emission when tools are offered.
    if (req.tools && req.tools.length > 0) {
      const tool = req.tools[0];
      const call: ToolCall = {
        id: `call_${Math.floor(this.random() * 1e9).toString(36)}`,
        name: tool.name,
        arguments: JSON.stringify({ query: lastUserText(req) }),
      };
      return {
        content: '',
        toolCalls: [call],
        model: this.model,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    }

    const text = this.resolveText(req);
    return {
      content: text,
      toolCalls: [],
      model: this.model,
      usage: {
        promptTokens: tokenEstimate(req.messages.map((m) => m.content).join(' ')),
        completionTokens: tokenEstimate(text),
        totalTokens: 0,
      },
    };
  }

  private resolveText(req: CompletionRequest): string {
    if (this.fixed !== undefined) return this.fixed;
    // Intent is taken from the USER'S question only — not the injected RAG
    // context. Otherwise a retrieved doc mentioning "refund" would hijack a
    // "business hours" question into a refund answer.
    const prompt = lastUserText(req);
    for (const rule of DEFAULT_ANSWERS) {
      if (rule.match.test(prompt)) return rule.reply;
    }
    return "I'm a demo assistant. Ask me about our refund policy, business hours, or shipping.";
  }
}

function lastUserText(req: CompletionRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i].role === 'user') {
      const body = req.messages[i].content;
      // In a RAG prompt the question is the text after the final "QUESTION:"
      // marker; the retrieved CONTEXT before it must NOT drive intent, or a
      // retrieved doc mentioning "refund" would hijack an unrelated question.
      const idx = body.lastIndexOf('QUESTION:');
      return idx >= 0 ? body.slice(idx) : body;
    }
  }
  return '';
}

/** Tiny token estimate (words+1) — good enough for usage accounting in dev. */
function tokenEstimate(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 1.3));
}
