/**
 * LLM orchestration tests — offline, no credentials.
 * Proves the client's retry/timeout and the Fake/OpenAI adapter contracts.
 */

import { describe, expect, it } from 'vitest';
import { LlmClient } from './client.js';
import { FakeChatModel } from './fake.js';
import { OpenAIChatModel } from './openai.js';
import type { CompletionRequest, LlmProvider } from './types.js';

describe('FakeChatModel', () => {
  it('returns a keyword-grounded answer without any credentials', async () => {
    const model = new FakeChatModel();
    const res = await model.complete({
      messages: [{ role: 'user', content: 'What is your refund policy?' }],
    });
    expect(res.content).toMatch(/30 days/i);
    expect(res.model).toBe('fake-chat-1');
    expect(res.toolCalls).toHaveLength(0);
  });

  it('emits a deterministic tool call when tools are offered', async () => {
    const model = new FakeChatModel();
    const res = await model.complete({
      messages: [{ role: 'user', content: 'search the docs' }],
      tools: [{ name: 'lookup', description: 'lookup', parameters: {} }],
    });
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe('lookup');
    expect(JSON.parse(res.toolCalls[0].arguments)).toHaveProperty('query');
  });

  it('honours a fixed response for deterministic tests', async () => {
    const model = new FakeChatModel({ fixedResponse: 'X' });
    const res = await model.complete({
      messages: [{ role: 'user', content: 'anything' }],
    });
    expect(res.content).toBe('X');
  });

  it('estimates token usage', async () => {
    const model = new FakeChatModel();
    const res = await model.complete({
      messages: [{ role: 'user', content: 'one two three four five' }],
    });
    expect(res.usage?.completionTokens).toBeGreaterThan(0);
  });
});

describe('LlmClient reliability', () => {
  it('retries on transient failure then succeeds', async () => {
    let calls = 0;
    const flaky: LlmProvider = {
      model: 'test',
      async complete(_req: CompletionRequest) {
        calls += 1;
        if (calls < 3) throw new Error('transient 503');
        return { content: 'ok', toolCalls: [], model: 'test' };
      },
    };
    const client = new LlmClient(flaky, { maxRetries: 3, baseBackoffMs: 1 });
    const res = await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throws on its own timeout', async () => {
    // Provider resolves only after 1s; client times out at 20ms.
    const slow: LlmProvider = {
      model: 'test',
      complete: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ content: 'x', toolCalls: [], model: 'test' }), 1000),
        ),
    };
    const client = new LlmClient(slow, { timeoutMs: 20 });
    await expect(client.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /timed out/,
    );
  });
});

describe('OpenAIChatModel contract', () => {
  it('throws loudly when no API key is present (never logs/reads a secret)', async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const model = new OpenAIChatModel({ apiKey: undefined });
      await expect(model.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
        /missing API key/,
      );
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });

  it('maps a fake fetch response into the provider shape', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          model: 'gpt-4o-mini',
          choices: [{ message: { content: 'hello from openai', tool_calls: [] } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as Response;
    const model = new OpenAIChatModel({
      apiKey: 'sk-test',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    const res = await model.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('hello from openai');
    expect(res.usage?.totalTokens).toBe(3);
    expect(res.model).toBe('gpt-4o-mini');
  });
});
