/**
 * @chimeric/starter-kit — reusable solutions starter kit.
 *
 * The single dependency every client engagement inherits. It provides, out of the
 * box, the three pillars of a production AI solution:
 *
 *   1. LLM orchestration  — provider-agnostic client with retry/timeout, plus a
 *      deterministic offline {@link FakeChatModel} (dev/CI) and an OpenAI adapter
 *      ({@link OpenAIChatModel}) for production.
 *   2. RAG / agent skeleton — embedder, in-memory vector store, retriever, and a
 *      grounded {@link RagAgent}.
 *   3. Eval harness — scorers, a suite runner, and a threshold gate
 *      ({@link withinThreshold}) so quality is measurable before handoff.
 *
 * The "second client is faster than the first" payoff: the interfaces are fixed.
 * A new engagement swaps the fake adapters for real ones (keys from the CEO's
 * secret store) and reuses everything else.
 */

// --- LLM orchestration ----------------------------------------------------
export type {
  Role,
  Message,
  ToolCall,
  ToolDefinition,
  CompletionRequest,
  CompletionResponse,
  LlmProvider,
} from './llm/types.js';
export { LlmClient, type ClientOptions } from './llm/client.js';
export { FakeChatModel, type FakeOptions } from './llm/fake.js';
export { OpenAIChatModel, type OpenAIOptions } from './llm/openai.js';

// --- RAG / agent skeleton -------------------------------------------------
export type { Embedder } from './rag/embedder.js';
export { FakeEmbedder, cosineSimilarity } from './rag/embedder.js';
export type { StoredDoc, ScoredDoc } from './rag/vector-store.js';
export { InMemoryVectorStore } from './rag/vector-store.js';
export type { RetrievalOptions } from './rag/retriever.js';
export { Retriever } from './rag/retriever.js';
export type { RagAnswer } from './rag/agent.js';
export { RagAgent } from './rag/agent.js';

// --- Eval harness ---------------------------------------------------------
export type { ScorerName, Scorer, EvalCaseInput, EvalOutput } from './evals/scorers.js';
export { scorers } from './evals/scorers.js';
export type {
  EvalCase,
  EvalSuite,
  EvalRun,
  CaseResult,
  SuiteResult,
  GateThresholds,
} from './evals/runner.js';
export { runSuite, withinThreshold } from './evals/runner.js';
export { SAMPLE_CORPUS, type CorpusDoc } from './evals/corpus.js';
export { STARTER_KIT_SUITE } from './evals/suites.js';

import { FakeEmbedder } from './rag/embedder.js';
import { InMemoryVectorStore } from './rag/vector-store.js';
import { Retriever } from './rag/retriever.js';
import { RagAgent } from './rag/agent.js';
import { FakeChatModel } from './llm/fake.js';
import { LlmClient } from './llm/client.js';
import type { LlmProvider } from './llm/types.js';
import { SAMPLE_CORPUS } from './evals/corpus.js';

export interface DemoKit {
  llm: LlmProvider;
  store: InMemoryVectorStore;
  agent: RagAgent;
}

/**
 * Build the fully-offline demo kit (no credentials, no network). Used by the
 * smoke test, the eval suite, and as the zero-config reference the "hello world"
 * engagement starts from. Replace FakeChatModel/FakeEmbedder with real adapters
 * for a client deployment.
 */
export async function buildDemoKit(opts?: {
  model?: FakeChatModel;
  embedder?: FakeEmbedder;
}): Promise<DemoKit> {
  const llm = opts?.model ?? new FakeChatModel();
  const embedder = opts?.embedder ?? new FakeEmbedder();
  const store = new InMemoryVectorStore(embedder);
  for (const doc of SAMPLE_CORPUS) {
    await store.add({ id: doc.id, text: doc.text, metadata: doc.metadata });
  }
  const retriever = new Retriever(store);
  const agent = new RagAgent(llm, retriever);
  return { llm: opts?.model ?? llm, store, agent };
}

// Re-export the client for callers that want the orchestrated (retry/timeout)
// surface rather than the raw provider.
export { LlmClient as Llm };
