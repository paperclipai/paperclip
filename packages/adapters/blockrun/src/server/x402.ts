import { createWalletClient, http, encodeFunctionData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

interface PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
}

interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function getRandomNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

async function signTransferAuthorization(
  walletKey: Hex,
  payTo: string,
  amount: string,
  asset: string,
): Promise<{
  signature: Hex;
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}> {
  const account = privateKeyToAccount(walletKey);
  const client = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });

  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60;
  const validBefore = now + 300;
  const nonce = getRandomNonce();

  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: BigInt(base.id),
    verifyingContract: asset as Hex,
  };

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  } as const;

  const message = {
    from: account.address as Hex,
    to: payTo as Hex,
    value: BigInt(amount),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce,
  };

  const signature = await client.signTypedData({
    domain,
    types,
    primaryType: "TransferWithAuthorization",
    message,
  });

  return {
    signature,
    from: account.address,
    to: payTo,
    value: amount,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  };
}

function encodePaymentHeader(
  requirement: PaymentRequirement,
  authorization: Awaited<ReturnType<typeof signTransferAuthorization>>,
): string {
  const payload = {
    x402Version: 2,
    resource: {
      url: requirement.resource,
      description: requirement.description,
      mimeType: requirement.mimeType,
    },
    payload: {
      signature: authorization.signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value,
        validAfter: authorization.validAfter,
        validBefore: authorization.validBefore,
        nonce: authorization.nonce,
      },
    },
  };
  return btoa(JSON.stringify(payload));
}

export async function callBlockRunAPI(
  walletKey: string,
  apiUrl: string,
  body: ChatCompletionRequest,
  timeoutSec: number,
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<{ response: ChatCompletionResponse; costUsd: number }> {
  const endpoint = `${apiUrl}/api/v1/chat/completions`;

  // Step 1: initial request
  const controller1 = new AbortController();
  const timeout1 = setTimeout(() => controller1.abort(), timeoutSec * 1000);

  let initialResponse: Response;
  try {
    initialResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller1.signal,
    });
  } finally {
    clearTimeout(timeout1);
  }

  // If not 402, model is free or there's an error
  if (initialResponse.status !== 402) {
    if (!initialResponse.ok) {
      const errorText = await initialResponse.text();
      throw new Error(`BlockRun API error ${initialResponse.status}: ${errorText.slice(0, 500)}`);
    }
    const data = (await initialResponse.json()) as ChatCompletionResponse;
    return { response: data, costUsd: 0 };
  }

  // Step 2: parse payment requirements from 402
  const requirementsHeader = initialResponse.headers.get("x-payment") || initialResponse.headers.get("X-PAYMENT");
  if (!requirementsHeader) {
    throw new Error("BlockRun returned 402 but no payment requirements header");
  }

  let requirement: PaymentRequirement;
  try {
    const decoded = JSON.parse(atob(requirementsHeader));
    // x402 v2: requirements is an array, take first
    const req = Array.isArray(decoded) ? decoded[0] : decoded;
    requirement = {
      scheme: req.scheme ?? "exact",
      network: req.network ?? `eip155:${base.id}`,
      maxAmountRequired: req.maxAmountRequired ?? req.amount ?? "0",
      resource: req.resource ?? endpoint,
      description: req.description ?? "",
      mimeType: req.mimeType ?? "application/json",
      payTo: req.payTo ?? "",
      maxTimeoutSeconds: req.maxTimeoutSeconds ?? 300,
      asset: req.asset ?? USDC_ADDRESS,
    };
  } catch (err) {
    throw new Error(`Failed to parse payment requirements: ${err instanceof Error ? err.message : String(err)}`);
  }

  const costMicroUsdc = Number(requirement.maxAmountRequired);
  const costUsd = costMicroUsdc / 1_000_000;

  await onLog("stdout", `[blockrun] payment required: $${costUsd.toFixed(6)} USDC to ${requirement.payTo}\n`);

  // Step 3: sign payment
  const authorization = await signTransferAuthorization(
    walletKey as Hex,
    requirement.payTo,
    requirement.maxAmountRequired,
    requirement.asset,
  );

  const paymentHeader = encodePaymentHeader(requirement, authorization);

  // Step 4: retry with payment
  const controller2 = new AbortController();
  const timeout2 = setTimeout(() => controller2.abort(), timeoutSec * 1000);

  let paidResponse: Response;
  try {
    paidResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": paymentHeader,
      },
      body: JSON.stringify(body),
      signal: controller2.signal,
    });
  } finally {
    clearTimeout(timeout2);
  }

  if (!paidResponse.ok) {
    const errorText = await paidResponse.text();
    throw new Error(`BlockRun paid request failed ${paidResponse.status}: ${errorText.slice(0, 500)}`);
  }

  const data = (await paidResponse.json()) as ChatCompletionResponse;
  return { response: data, costUsd };
}

export function validateWalletKey(key: string): { valid: boolean; address?: string; error?: string } {
  try {
    const account = privateKeyToAccount(key as Hex);
    return { valid: true, address: account.address };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : "Invalid private key" };
  }
}
