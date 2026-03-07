/**
 * Bittensor Subnet Inference Tests
 *
 * Covers the two BDD scenarios from the feature spec:
 *
 * Scenario: Authenticated inference request
 *   Given a deployed wallet with valid hotkey
 *   When the agent calls the /neurons endpoint
 *   Then inference result is returned in < 1 second
 *
 * Scenario: Fallback chain
 *   Given Bittensor is unreachable
 *   When the inference request fails
 *   Then Venice AI is tried next, then local model
 *    And costs are logged
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BittensorClient } from '../../src/inference/bittensor-client.js';
import { VeniceAIClient } from '../../src/inference/venice-client.js';
import { LocalModelClient } from '../../src/inference/local-model-client.js';
import { InferenceFallbackChain } from '../../src/inference/fallback-chain.js';

// ---------------------------------------------------------------------------
// Scenario 1 – Authenticated inference request
// ---------------------------------------------------------------------------

describe('Scenario: Authenticated inference request', () => {
  const WALLET = {
    hotkey: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    coldkey: '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty',
    hotkeySecret: 'a'.repeat(64), // 32-byte hex test secret
  };

  let client: BittensorClient;

  beforeEach(() => {
    client = new BittensorClient({
      apiEndpoint: 'https://api.bittensor.com',
      timeout: 5_000,
      wallet: WALLET,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Given a deployed wallet with valid hotkey – client is configured with wallet credentials', () => {
    // The client stores wallet config
    expect((client as any).config.wallet.hotkey).toBe(WALLET.hotkey);
    expect((client as any).config.wallet.hotkeySecret).toBe(WALLET.hotkeySecret);
  });

  it('When the agent calls the /neurons endpoint – builds X-Hotkey header', async () => {
    const mockPost = vi.fn().mockResolvedValue({ data: { success: true, output: 'result', uid: 5, name: 'neuron-5' } });
    const mockGet = vi.fn().mockResolvedValue({ data: { neurons: [{ uid: 5, hotkey: WALLET.hotkey, active: true, stake: 100, trust: 0.9, consensus: 0.8, incentive: 0.7, dividends: 0.1, emission: 50, rank: 1, validator_permit: false }] } });

    // Inject mock axios
    (client as any).axiosInstance = { post: mockPost, get: mockGet };

    const neurons = await client.getNeurons(1);
    expect(neurons).toHaveLength(1);
    expect(neurons[0]!.uid).toBe(5);

    // The get call should include the X-Hotkey header
    expect(mockGet).toHaveBeenCalledWith('/neurons/1', expect.objectContaining({
      headers: expect.objectContaining({ 'X-Hotkey': WALLET.hotkey }),
    }));
  });

  it('When the agent calls inferWithWallet – X-Signature header is included when hotkeySecret is set', async () => {
    const mockPost = vi.fn().mockResolvedValue({
      data: { success: true, output: 'inference result', uid: 5, name: 'neuron-5' },
    });
    (client as any).axiosInstance = { post: mockPost, get: vi.fn() };

    await client.inferWithWallet({ netuid: 1, inputs: { prompt: 'hello' } });

    const [, , options] = mockPost.mock.calls[0]!;
    expect(options.headers).toHaveProperty('X-Hotkey', WALLET.hotkey);
    expect(options.headers).toHaveProperty('X-Signature');
    // Signature must be a non-empty hex string
    expect((options.headers['X-Signature'] as string).length).toBeGreaterThan(0);
  });

  it('Then inference result is returned – success flag is true', async () => {
    const mockPost = vi.fn().mockResolvedValue({
      data: { success: true, output: 'decentralised AI response', uid: 3, name: 'top-miner' },
    });
    (client as any).axiosInstance = { post: mockPost, get: vi.fn() };

    const result = await client.inferWithWallet({ netuid: 1, inputs: { prompt: 'What is the capital of France?' } });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });

  it('Then inference result is returned in < 1 second – subSecond flag is set', async () => {
    const mockPost = vi.fn().mockImplementation(async () => {
      // Simulate a fast response (< 1 s)
      return { data: { success: true, output: 'fast', uid: 1, name: 'fast-miner' } };
    });
    (client as any).axiosInstance = { post: mockPost, get: vi.fn() };

    const result = await client.inferWithWallet({ netuid: 1, inputs: { prompt: 'ping' } });

    expect(result.success).toBe(true);
    expect(result.metadata?.responseTime).toBeDefined();
    // The mock returns near-instantly so subSecond should be true
    expect(result.subSecond).toBe(true);
  });

  it('Then responseTime is tracked in metadata', async () => {
    const mockPost = vi.fn().mockResolvedValue({
      data: { success: true, output: 'ok', uid: 2, name: 'miner-2' },
    });
    (client as any).axiosInstance = { post: mockPost, get: vi.fn() };

    const result = await client.inferWithWallet({ netuid: 1, inputs: { prompt: 'test' } });

    expect(result.metadata?.responseTime).toBeGreaterThanOrEqual(0);
    expect(result.metadata?.netuid).toBe(1);
  });

  it('getNeurons returns NeuronInfo array with expected fields', async () => {
    const mockNeurons = [
      { uid: 0, hotkey: WALLET.hotkey, coldkey: WALLET.coldkey, stake: 500, trust: 0.95, consensus: 0.9, incentive: 0.8, dividends: 0.2, emission: 100, rank: 0, validator_permit: true, active: true, axon_info: { ip: '1.2.3.4', port: 8091, version: 1, protocol: 4 } },
      { uid: 1, hotkey: '5abc', coldkey: '5def', stake: 200, trust: 0.6, consensus: 0.5, incentive: 0.4, dividends: 0.1, emission: 40, rank: 1, validator_permit: false, active: true },
    ];
    (client as any).axiosInstance = {
      get: vi.fn().mockResolvedValue({ data: { neurons: mockNeurons } }),
      post: vi.fn(),
    };

    const neurons = await client.getNeurons(1);
    expect(neurons).toHaveLength(2);
    expect(neurons[0]).toMatchObject({ uid: 0, active: true, validator_permit: true });
    expect(neurons[1]).toMatchObject({ uid: 1, active: true, validator_permit: false });
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 – Fallback chain
// ---------------------------------------------------------------------------

describe('Scenario: Fallback chain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Given Bittensor is unreachable – BittensorClient.inferWithWallet returns success:false', async () => {
    const client = new BittensorClient({});
    (client as any).axiosInstance = {
      post: vi.fn().mockRejectedValue(new Error('ECONNREFUSED – bittensor unreachable')),
      get: vi.fn(),
    };

    const result = await client.inferWithWallet({ netuid: 1, inputs: { prompt: 'test' } });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('When Bittensor fails – fallback chain tries Venice AI next', async () => {
    const chain = new InferenceFallbackChain({
      bittensor: { netuid: 1 },
    });

    // Make Bittensor fail
    const btClient = (chain as any).bittensor as BittensorClient;
    vi.spyOn(btClient, 'inferWithWallet').mockResolvedValue({
      success: false,
      error: 'Bittensor unreachable',
    });

    // Make Venice AI succeed
    const veniceClient = (chain as any).venice as VeniceAIClient;
    vi.spyOn(veniceClient, 'infer').mockResolvedValue({
      success: true,
      text: 'Venice AI response',
      estimatedCostUsd: 0.0001,
      responseTime: 450,
    });

    const result = await chain.infer({ prompt: 'Hello world' });

    expect(result.success).toBe(true);
    expect(result.provider).toBe('venice');
    expect(result.text).toBe('Venice AI response');
  });

  it('When Bittensor and Venice AI both fail – local model is tried', async () => {
    const chain = new InferenceFallbackChain({
      bittensor: { netuid: 1 },
    });

    vi.spyOn((chain as any).bittensor as BittensorClient, 'inferWithWallet').mockResolvedValue({
      success: false,
      error: 'Bittensor unreachable',
    });

    vi.spyOn((chain as any).venice as VeniceAIClient, 'infer').mockResolvedValue({
      success: false,
      error: 'Venice AI key invalid',
    });

    vi.spyOn((chain as any).local as LocalModelClient, 'infer').mockResolvedValue({
      success: true,
      text: 'local llama response',
      estimatedCostUsd: 0,
      responseTime: 200,
    });

    const result = await chain.infer({ prompt: 'Hello world' });

    expect(result.success).toBe(true);
    expect(result.provider).toBe('local');
    expect(result.text).toBe('local llama response');
  });

  it('And costs are logged – attemptsLog contains an entry for each provider tried', async () => {
    const chain = new InferenceFallbackChain({ bittensor: { netuid: 1 } });

    vi.spyOn((chain as any).bittensor as BittensorClient, 'inferWithWallet').mockResolvedValue({
      success: false,
      error: 'Bittensor unreachable',
    });

    vi.spyOn((chain as any).venice as VeniceAIClient, 'infer').mockResolvedValue({
      success: false,
      error: 'Venice unavailable',
    });

    vi.spyOn((chain as any).local as LocalModelClient, 'infer').mockResolvedValue({
      success: true,
      text: 'local response',
      estimatedCostUsd: 0,
      responseTime: 100,
    });

    const result = await chain.infer({ prompt: 'test' });

    expect(result.attemptsLog).toHaveLength(3);
    expect(result.attemptsLog[0]!.provider).toBe('bittensor');
    expect(result.attemptsLog[1]!.provider).toBe('venice');
    expect(result.attemptsLog[2]!.provider).toBe('local');

    // Each failed attempt is logged with its error
    expect(result.attemptsLog[0]!.success).toBe(false);
    expect(result.attemptsLog[0]!.error).toContain('Bittensor');
    expect(result.attemptsLog[1]!.success).toBe(false);
    expect(result.attemptsLog[2]!.success).toBe(true);
  });

  it('And costs are logged – CostLog totals are computed correctly', async () => {
    const chain = new InferenceFallbackChain({ bittensor: { netuid: 1 } });

    vi.spyOn((chain as any).bittensor as BittensorClient, 'inferWithWallet').mockResolvedValue({
      success: false,
      error: 'Bittensor unreachable',
    });

    vi.spyOn((chain as any).venice as VeniceAIClient, 'infer').mockResolvedValue({
      success: true,
      text: 'Venice response',
      estimatedCostUsd: 0.0005,
      responseTime: 600,
    });

    const result = await chain.infer({ prompt: 'cost test' });

    expect(result.costs.bittensorUsd).toBe(0);
    expect(result.costs.veniceUsd).toBe(0.0005);
    expect(result.costs.totalUsd).toBeCloseTo(0.0005);
  });

  it('And costs are logged – local model cost is always 0', async () => {
    const chain = new InferenceFallbackChain({
      bittensor: { netuid: 1 },
      disableProviders: ['bittensor', 'venice'],
    });

    vi.spyOn((chain as any).local as LocalModelClient, 'infer').mockResolvedValue({
      success: true,
      text: 'free local',
      estimatedCostUsd: 0,
      responseTime: 150,
    });

    const result = await chain.infer({ prompt: 'free compute' });

    expect(result.provider).toBe('local');
    expect(result.costs.localUsd).toBe(0);
    expect(result.costs.totalUsd).toBe(0);
  });

  it('When all providers fail – returns success:false with combined error message', async () => {
    const chain = new InferenceFallbackChain({ bittensor: { netuid: 1 } });

    vi.spyOn((chain as any).bittensor as BittensorClient, 'inferWithWallet').mockResolvedValue({
      success: false,
      error: 'BT down',
    });

    vi.spyOn((chain as any).venice as VeniceAIClient, 'infer').mockResolvedValue({
      success: false,
      error: 'Venice down',
    });

    vi.spyOn((chain as any).local as LocalModelClient, 'infer').mockResolvedValue({
      success: false,
      estimatedCostUsd: 0,
      error: 'Local model not running',
    });

    const result = await chain.infer({ prompt: 'impossible' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('bittensor');
    expect(result.error).toContain('venice');
    expect(result.error).toContain('local');
  });

  it('Fallback chain respects disableProviders – skips Bittensor when disabled', async () => {
    const chain = new InferenceFallbackChain({
      bittensor: { netuid: 1 },
      disableProviders: ['bittensor'],
    });

    const btSpy = vi.spyOn((chain as any).bittensor as BittensorClient, 'inferWithWallet');

    vi.spyOn((chain as any).venice as VeniceAIClient, 'infer').mockResolvedValue({
      success: true,
      text: 'Venice only',
      estimatedCostUsd: 0,
      responseTime: 300,
    });

    const result = await chain.infer({ prompt: 'skip BT' });

    expect(btSpy).not.toHaveBeenCalled();
    expect(result.provider).toBe('venice');
  });
});

// ---------------------------------------------------------------------------
// VeniceAIClient unit tests
// ---------------------------------------------------------------------------

describe('VeniceAIClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns error when no API key is configured', async () => {
    const client = new VeniceAIClient({ apiKey: '' });
    const result = await client.infer({ prompt: 'hello' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('VENICE_API_KEY');
  });

  it('parses successful OpenAI-compatible response', async () => {
    const client = new VeniceAIClient({ apiKey: 'test-key' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Paris' } }],
        model: 'llama-3.3-70b',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    }));

    const result = await client.infer({ prompt: 'Capital of France?' });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Paris');
    expect(result.usage?.totalTokens).toBe(15);
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it('handles non-ok HTTP response gracefully', async () => {
    const client = new VeniceAIClient({ apiKey: 'test-key' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Unauthorized',
    }));

    const result = await client.infer({ prompt: 'hello' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// LocalModelClient unit tests
// ---------------------------------------------------------------------------

describe('LocalModelClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends correct Ollama generate payload', async () => {
    const client = new LocalModelClient({ endpoint: 'http://localhost:11434', model: 'llama3' });
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'local answer', model: 'llama3' }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await client.infer({ prompt: 'test prompt' });

    expect(result.success).toBe(true);
    expect(result.text).toBe('local answer');
    expect(result.estimatedCostUsd).toBe(0);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain('/api/generate');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('llama3');
    expect(body.stream).toBe(false);
    vi.unstubAllGlobals();
  });

  it('returns estimatedCostUsd = 0 always', async () => {
    const client = new LocalModelClient({});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'ok', model: 'llama3' }),
    }));

    const result = await client.infer({ prompt: 'free?' });
    expect(result.estimatedCostUsd).toBe(0);
    vi.unstubAllGlobals();
  });

  it('handles fetch failure gracefully', async () => {
    const client = new LocalModelClient({});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const result = await client.infer({ prompt: 'unreachable' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('connection refused');
    vi.unstubAllGlobals();
  });
});
