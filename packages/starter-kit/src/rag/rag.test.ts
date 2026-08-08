/**
 * RAG / agent skeleton tests — offline, no credentials.
 * Proves retrieval ranking and grounded answering end-to-end through the demo kit.
 */

import { describe, expect, it } from 'vitest';
import { FakeEmbedder, cosineSimilarity } from './embedder.js';
import { InMemoryVectorStore } from './vector-store.js';
import { Retriever } from './retriever.js';
import { RagAgent } from './agent.js';
import { FakeChatModel } from '../llm/fake.js';
import { buildDemoKit } from '../index.js';

describe('FakeEmbedder + cosine similarity', () => {
  it('produces fixed-width normalized vectors', async () => {
    const e = new FakeEmbedder(64);
    const v = await e.embed('refund policy returns');
    expect(v).toHaveLength(64);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('similar text scores higher than unrelated text', async () => {
    const e = new FakeEmbedder(64);
    const a = await e.embed('how do I get a refund');
    const b = await e.embed('refund policy and returns');
    const c = await e.embed('shipping takes three days');
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
  });
});

describe('InMemoryVectorStore + Retriever', () => {
  it('ranks the most relevant doc first and respects topK', async () => {
    const store = new InMemoryVectorStore(new FakeEmbedder());
    await store.add({ id: 'a', text: 'refunds within 30 days' });
    await store.add({ id: 'b', text: 'shipping takes 3-5 business days' });
    await store.add({ id: 'c', text: 'warranty covers defects' });
    expect(store.count()).toBe(3);

    const retriever = new Retriever(store, { topK: 1 });
    const hits = await retriever.retrieve('tell me about refunds');
    expect(hits[0].id).toBe('a');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('rejects duplicate ids', async () => {
    const store = new InMemoryVectorStore(new FakeEmbedder());
    await store.add({ id: 'dup', text: 'x' });
    await expect(store.add({ id: 'dup', text: 'y' })).rejects.toThrow(/already indexed/);
  });
});

describe('RagAgent (end-to-end, offline)', () => {
  it('answers from retrieved context and cites the source', async () => {
    const { agent } = await buildDemoKit();
    const ans = await agent.ask('How long do I have to return an item for a refund?');
    expect(ans.ungrounded).toBe(false);
    expect(ans.answer).toMatch(/30 days/i);
    expect(ans.citations).toContain('policy_refunds');
  });

  it('refuses gracefully when nothing is retrieved', async () => {
    // Empty store -> no retrieval -> honest "I don't know".
    const store = new InMemoryVectorStore(new FakeEmbedder());
    const agent = new RagAgent(new FakeChatModel(), new Retriever(store));
    const ans = await agent.ask('anything');
    expect(ans.ungrounded).toBe(true);
  });

  it('grounds a shipping question on the shipping doc', async () => {
    const { agent } = await buildDemoKit();
    const ans = await agent.ask('How long does standard shipping take?');
    expect(ans.citations).toContain('shipping');
  });
});
