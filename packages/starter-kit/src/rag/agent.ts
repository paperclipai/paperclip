/**
 * RagAgent — the RAG/agent pipeline skeleton.
 *
 * Given a question, it retrieves relevant chunks and asks the LLM to answer
 * strictly from the retrieved context (grounding). The answer is returned together
 * with the citations and the raw retrieval, which the eval harness consumes to
 * score groundedness.
 *
 * This is the engagement template: swap the embedder/store for a real index and
 * the LLM provider for a production model, and you have a client-ready RAG bot.
 */

import type { LlmProvider } from '../llm/types.js';
import type { Retriever } from './retriever.js';
import type { ScoredDoc } from './vector-store.js';

export interface RagAnswer {
  answer: string;
  citations: string[];
  retrieved: ScoredDoc[];
  model: string;
  /** True when no context was retrieved (agent answers "I don't know"). */
  ungrounded: boolean;
}

export class RagAgent {
  private readonly systemPrompt =
    'You are a helpful assistant. Answer ONLY using the provided CONTEXT. ' +
    "If the context does not contain the answer, say you don't know. " +
    'Cite the source id of each fact you use as [source_id].';

  constructor(
    private readonly llm: LlmProvider,
    private readonly retriever: Retriever,
  ) {}

  async ask(question: string): Promise<RagAnswer> {
    const retrieved = await this.retriever.retrieve(question);

    if (retrieved.length === 0) {
      return {
        answer: "I don't know.",
        citations: [],
        retrieved,
        model: this.llm.model,
        ungrounded: true,
      };
    }

    const context = retrieved.map((d) => `[[${d.id}]] ${d.text}`).join('\n\n');

    const reply = await this.llm.complete({
      messages: [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: `CONTEXT:\n${context}\n\nQUESTION: ${question}` },
      ],
      temperature: 0,
    });

    // Citations = the docs the answer was grounded on (the retrieved context),
    // unioned with any [[id]] tokens the model emitted. This keeps groundedness
    // measurable even with the offline Fake provider, which does not emit tokens.
    const groundedIds = retrieved.map((d) => d.id);
    const emitted = extractCitations(reply.content).filter((id) => groundedIds.includes(id));

    return {
      answer: reply.content,
      citations: [...new Set([...groundedIds, ...emitted])],
      retrieved,
      model: reply.model,
      ungrounded: false,
    };
  }
}

/** Pull [[id]] tokens out of a model response. */
function extractCitations(text: string): string[] {
  const ids = new Set<string>();
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  return [...ids];
}
