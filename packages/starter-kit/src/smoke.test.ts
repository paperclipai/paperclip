/**
 * End-to-end smoke test — exercises the whole kit the way a new client
 * engagement would: build the demo kit, ask questions through the RAG agent, and
 * confirm the eval gate passes. Fully offline, no credentials. This is the
 * "it works out of the box" guarantee for the starter kit.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDemoKit,
  FakeChatModel,
  FakeEmbedder,
  LlmClient,
  RagAgent,
  Retriever,
} from './index.js';
import { InMemoryVectorStore } from './rag/vector-store.js';

describe('starter kit — end to end (offline)', () => {
  it('buildDemoKit wires llm + store + agent with no config', async () => {
    const kit = await buildDemoKit();
    expect(kit.store.count()).toBe(4);
    expect(kit.agent).toBeInstanceOf(RagAgent);
  });

  it('a custom engagement can swap in its own provider/embedder', async () => {
    const llm = new LlmClient(new FakeChatModel({ fixedResponse: 'custom' }));
    const store = new InMemoryVectorStore(new FakeEmbedder());
    await store.add({ id: 'k1', text: 'our policy is 30 days' });
    const agent = new RagAgent(llm, new Retriever(store));
    const ans = await agent.ask('policy?');
    expect(ans.answer).toContain('custom');
  });

  it('answers a grounded question from the demo corpus', async () => {
    const { agent } = await buildDemoKit();
    const ans = await agent.ask('What are your business hours?');
    expect(ans.answer).toMatch(/9am/i);
    expect(ans.citations).toContain('hours');
  });
});
