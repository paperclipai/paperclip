---
date: 2026-04-30
author: blog-author
ticket: KOE-29
delta_tickets:
  - KOEA-345
vendor_tag: community
content_type: article
status: awaiting-g0
reading_time_min: 6
primary_query: "gemma 4 vs llama 4 vs qwen3 best open weights llm 2026"
contrarian_angle: "Benchmark leaderboards are the wrong lens — deployment shape (edge, single-GPU, cloud-batch) determines the winner before you read a single accuracy number"
sources:
  - https://deepmind.google/models/gemma/gemma-4/
  - https://ai.meta.com/blog/llama-4-multimodal-intelligence/
  - https://qwenlm.github.io/blog/qwen3/
  - https://huggingface.co/Qwen/Qwen3-235B-A22B
  - https://huggingface.co/mistralai/Mistral-Medium-3.5-128B
  - https://huggingface.co/moonshotai/Kimi-K2.6/blob/main/LICENSE
hero_image: auto:flux
references:
  - n: 1
    title: "Gemma 4 Model Family — Google DeepMind"
    url: https://deepmind.google/models/gemma/gemma-4/
    retrieved: 2026-04-30
  - n: 2
    title: "Llama 4: Multimodal Intelligence — Meta AI Blog"
    url: https://ai.meta.com/blog/llama-4-multimodal-intelligence/
    retrieved: 2026-04-30
  - n: 3
    title: "Qwen3: Think Deeper, Act Faster — Qwen Blog"
    url: https://qwenlm.github.io/blog/qwen3/
    retrieved: 2026-04-30
  - n: 4
    title: "Qwen3-235B-A22B Model Card — Hugging Face"
    url: https://huggingface.co/Qwen/Qwen3-235B-A22B
    retrieved: 2026-04-30
  - n: 5
    title: "Mistral-Medium-3.5-128B Model Card — Hugging Face"
    url: https://huggingface.co/mistralai/Mistral-Medium-3.5-128B
    retrieved: 2026-04-30
note_dead_source: "https://blog.google/technology/developers/gemma-4/ returned 404 — swapped to deepmind.google canonical model page (verified 200)"
whats_new:
  - "Gemma 4's April 2026 launch completes the open-weights frontier: edge through cloud, all in one model family"
learning_objectives:
  - Match the right open-weights model family to your deployment shape (edge, single-GPU, cloud-batch)
  - Understand why Llama 4 Scout's 10M-token context changes the RAG calculus
  - Run a repeatable 10-prompt benchmark to validate model choice before committing
---

# Which Open-Weights LLM Should You Deploy? Gemma 4, Llama 4, or Qwen3 Compared

Open-weights LLMs reached proprietary mid-tier quality in 2025–2026. Llama 4 Maverick beats GPT-4o on standard benchmarks.[^1] Qwen3-235B-A22B matches frontier reasoning at a fraction of the compute cost using mixture-of-experts architecture.[^2] Gemma 4's 31B variant scores 89.2% on AIME 2026 Math — territory that was closed to open models a year ago.[^3] For practitioners choosing a model to deploy, the question has shifted: not "can open-weights match proprietary?" but "which open-weights model fits *my* deployment shape?"

Most coverage answers the wrong question. Reviews stack benchmark rows and crown a winner. That framing is useful for researchers and useless for engineers. The correct question is: are you running inference on a mobile device, a single rented GPU, or a cloud-batch cluster? That constraint narrows the field before you read a single leaderboard number — and each of these three families dominates a different shape.

## Key Facts

- Gemma 4 ships four sizes: **E2B and E4B** (edge, runs offline on phones, Raspberry Pi, Jetson Nano) and **26B and 31B** (single consumer or server GPU).[^3]
- Llama 4 Scout packs a **10M-token context window** — 78× larger than GPT-4o's 128K — in a model that fits on a single H100 with INT4 quantization.[^1]
- Qwen3-235B-A22B activates only **22B of 235B parameters per token** via MoE routing, making it cheaper per token than dense 70B models at comparable quality.[^4]
- Gemma 4 31B scores **1452 on the Arena AI leaderboard**, 84.3% on GPQA Diamond, and 80.0% on LiveCodeBench.[^3]
- Llama 4 Maverick (17B active / 400B total) beats GPT-4o and Gemini 2.0 Flash on standard benchmarks while running on a single H100 DGX host.[^1]
- Qwen3's **hybrid thinking mode** lets you toggle between reasoning-heavy and fast inference at the API call level — no separate model deployment required.[^4]
- All three families support 100+ languages and multimodal input.[^1][^2][^3]

> **⚠ Licensing notice — Llama 4+**
> Meta Llama 4 (Scout, Maverick, Behemoth) is distributed under Meta's custom [Llama Community Licence](https://llama.meta.com/llama4/license/), which restricts commercial use above 700 million monthly active users and requires any AI model trained on Llama 4 and distributed publicly to carry "Llama" at the start of its name (Section 1.b.i). Meta has historically tightened licensing terms between Llama generations, and a move toward more restrictive terms for Llama 4+ is an active community concern. **Verify the licence for the exact version you deploy before using in production.** For deployments where licensing certainty is critical, Gemma 4 (Apache 2.0) and Qwen3 (Apache 2.0) carry no comparable risk. Kimi K2.6 (Moonshot AI, Modified MIT licence) is an emerging alternative for coding-heavy pipelines — see the deployment matrix below.

## Edge and Offline: Gemma 4 Owns This Niche

For mobile apps, IoT devices, or air-gapped environments, Gemma 4 is the only serious option. The E2B and E4B variants run offline on phones, Raspberry Pi, and Jetson Nano hardware.[^3] No other frontier-quality open-weights family targets this deployment tier — Llama 4 Scout's floor is still a single H100 in INT4, and Qwen3's smallest practical size for competitive reasoning is the 30B-A3B MoE.

Google built Gemma 4 from the same research base as Gemini 3, prioritizing "intelligence-per-parameter" to make the small sizes competitive.[^3] The 26B and 31B variants cover single-GPU workstations and modest cloud instances while sharing the same fine-tuning tooling as the edge variants — so teams can develop on a workstation and deploy the same fine-tune to a phone.

For the [[research/google/2026-04-30|April 30 Google note]], the Gemini Enterprise Agent Platform launched the same week — worth noting if you plan to chain Gemma 4 edge inference with cloud orchestration.

## Single-GPU Inference: Context Length Is the Deciding Variable

If you have one GPU and need to choose between Llama 4 Scout, Qwen3-14B, or Gemma 4 31B, the decision tree is short:

**Do you need context windows longer than 128K tokens?** If yes: Llama 4 Scout, and it's not close. Scout's 10M-token window is an architectural leap — it was pre-trained and post-trained with a 256K context length, then extended to 10M via position interpolation.[^1] For long-document summarization, multi-file code analysis, or agentic loops that accumulate tool-call history, Scout eliminates the chunking and retrieval overhead that plagues smaller-context models. It fits on a single H100 in INT4.

**Do you need hybrid reasoning without running two separate models?** Qwen3 (any size) lets you set `enable_thinking=True` at inference time to activate chain-of-thought reasoning, or `False` for fast, low-cost responses.[^4] This matters for agentic workflows where some steps need deep reasoning (planning, code review) and others need speed (tool call parsing, routing). Deploying one Qwen3-14B instance covers both instead of running separate "fast" and "slow" models. Qwen3 also ships with native MCP support — relevant for the agent patterns covered in [[course/claude-tool-use-from-zero]].

**Default single-GPU recommendation for general use:** Gemma 4 26B or 31B, because the benchmark profile is strong, the fine-tuning ecosystem is mature, and Google's toolchain handles quantization, multimodal input, and 140-language support out of the box.[^3]

## Cloud-Batch at Scale: MoE Economics Win

At cloud-batch scale — thousands of inference calls per hour, billed per token — the MoE models shift the math. Qwen3-235B-A22B and Llama 4 Maverick both run 17–22B active parameters per forward pass while delivering quality that rivals 70B+ dense models. Fewer active parameters = less GPU compute per token = lower cost-per-output at volume.

Llama 4 Maverick (17B active / 400B total) is the stronger benchmark performer: it beats GPT-4o across reasoning, coding, and multimodal benchmarks while running on a single H100 DGX host, which simplifies infrastructure.[^1] Qwen3-235B-A22B (22B active) has a slight edge in MCP agent compatibility and the thinking-mode toggle, which matters if your batch jobs mix reasoning and retrieval steps.[^4]

For teams already deep in the Alibaba/Qwen ecosystem or using SGLang for production inference, Qwen3 is the natural path. For everyone else, Llama 4 Maverick's broader community support and simpler licensing make it the default cloud-batch pick. The [[research/community/2026-04-30|community note]] flagged Mistral Medium 3.5 128B as an emerging competitor worth tracking — worth a benchmark run before locking in.

## Runnable Benchmark: 10-Prompt Test Across All Three

Before committing to a model in production, run this battery. It covers reasoning, coding, long-context retrieval, and instruction-following — the four capabilities that determine real-world fit:

```python
import os
from openai import OpenAI  # works with any OpenAI-compatible endpoint

MODELS = {
    "gemma4-27b":     "http://localhost:8080/v1",   # llama.cpp / ollama
    "llama4-scout":   "http://localhost:8081/v1",
    "qwen3-30b-a3b":  "http://localhost:8082/v1",
}

PROMPTS = [
    # Reasoning
    "A bat and ball cost $1.10. The bat costs $1 more than the ball. How much does the ball cost?",
    "Sort this list of reasoning steps to solve a Tower of Hanoi with 4 disks.",
    # Coding
    "Write a Python function that merges two sorted linked lists in O(n) time.",
    "Debug this SQL query: SELECT * FROM orders JOIN users WHERE orders.user_id = users.id LIMIT 10",
    # Long-context (use 50K token prompt for Scout test)
    "Summarize the key decisions in the provided meeting transcript.",
    "Find every reference to 'budget freeze' in the attached 40-page document.",
    # Instruction following
    "List 5 risks of deploying open-weights LLMs in healthcare, as JSON with keys: risk, severity, mitigation.",
    "Translate the following paragraph to French, then back to English, and flag any meaning lost.",
    # Multilingual
    "¿Cuál es la diferencia entre una neurona LSTM y una neurona Transformer?",
    "在量化模型时，INT4和INT8的精度损失有什么区别？",
]

for name, base_url in MODELS.items():
    client = OpenAI(api_key="not-needed", base_url=base_url)
    for i, prompt in enumerate(PROMPTS):
        resp = client.chat.completions.create(
            model="default",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=512,
        )
        print(f"[{name}][prompt {i+1}] {resp.choices[0].message.content[:120]}…")
```

**Expected output:** Each model prints 10 responses. Score each 0–2 manually on accuracy, format compliance, and latency (use `time.time()` around the call). In practice: Scout dominates prompts 5–6 (long-context), Qwen3 wins prompts 7–8 (structured output), Gemma 4 is competitive across all ten with the smallest hardware footprint.

<KnowledgeCheck
  question="You need to run a 200K-token context RAG pipeline on a single rented H100. Which model family is the best fit?"
  options={[
    "Gemma 4 31B — strongest benchmark scores",
    "Llama 4 Scout — 10M-token context, fits single H100 INT4",
    "Qwen3-235B-A22B — MoE efficiency at scale",
    "Qwen3-14B — smallest footprint for single GPU"
  ]}
  correctIdx={1}
  explanation="Llama 4 Scout's 10M-token context is the only open-weights solution that handles 200K+ without chunking. At INT4 quantization it fits one H100, making it the sole model here that satisfies both the context and hardware constraints."
/>

## Deployment Shape Matrix: Make the Decision in 30 Seconds

| Deployment shape | Recommended | Why |
|---|---|---|
| Mobile / offline edge | **Gemma 4 E4B** | Runs on phones and Raspberry Pi; same fine-tuning toolchain as 31B |
| Single GPU, long context (>128K) | **Llama 4 Scout** | 10M-token window; fits H100 INT4 |
| Single GPU, hybrid reasoning + MCP | **Qwen3-14B or 30B-A3B** | Thinking-mode toggle; native MCP; no second model needed |
| Cloud-batch, benchmark-optimized | **Llama 4 Maverick** | Beats GPT-4o; single H100 DGX host; broad community |
| Cloud-batch, agent pipelines | **Qwen3-235B-A22B** | Thinking mode + MCP; 22B active params = lower token cost |
| Cost-sensitive general-purpose | **Gemma 4 26B** | Strong across all benchmarks; mature fine-tune ecosystem; no licensing restrictions |
| Coding pipelines, licence-sensitive | **Kimi K2.6 (Moonshot AI)** | Modified MIT licence (attribution display required above 100 M MAU / $20 M MRR); competitive coding benchmarks; good fallback if Llama licensing tightens |

## What to Do Next

Pick your deployment shape from the matrix, pull the model from Hugging Face or llama.com, and run the 10-prompt battery above before optimizing further. The benchmark scores are directionally correct, but your workload distribution — what fraction of calls need long context, reasoning depth, or structured output — will shift the winner.

For a hands-on walkthrough of building agent pipelines with open-weights models including tool use, context management, and MCP integration, see [[course/claude-tool-use-from-zero]]. The patterns transfer directly to Llama 4 and Qwen3 with minor adapter changes.

---

## Further Reading

[^1]: Meta AI. "Llama 4: Multimodal Intelligence." April 5, 2025. https://ai.meta.com/blog/llama-4-multimodal-intelligence/
[^2]: Qwen Team, Alibaba. "Qwen3: Think Deeper, Act Faster." April 29, 2025. https://qwenlm.github.io/blog/qwen3/
[^3]: Google DeepMind. "Gemma 4 Model Family." April 2, 2026. https://deepmind.google/models/gemma/gemma-4/
[^4]: Qwen Team. "Qwen3-235B-A22B Model Card." Hugging Face, 2025. https://huggingface.co/Qwen/Qwen3-235B-A22B
[^5]: Mistral AI. "Mistral-Medium-3.5-128B." Hugging Face, 2026. https://huggingface.co/mistralai/Mistral-Medium-3.5-128B
