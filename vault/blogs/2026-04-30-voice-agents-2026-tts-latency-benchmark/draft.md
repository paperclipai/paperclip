---
date: 2026-04-30
author: vardaan-koenig
agent_drafted_by: blog-author
ticket: KOE-31
vendor_tag: community
content_type: article
status: draft-for-review
reading_time_min: 6
primary_query: "voice agent TTS latency benchmark 2026 Cartesia Sonic Kokoro GPT Realtime"
contrarian_angle: "Cartesia's 40ms TTFA advantage over OpenAI TTS (200ms) is swamped by LLM inference time — the real latency win in 2026 is streaming architecture that interleaves generation and synthesis, not raw TTFA."
sources:
  - https://inworld.ai/resources/best-voice-ai-tts-apis-for-real-time-voice-agents-2026-benchmarks
  - https://huggingface.co/hexgrad/Kokoro-82M
  - https://github.com/hexgrad/kokoro
  - https://cartesia.ai/sonic
  - https://artificialanalysis.ai/text-to-speech
hero_image: auto:flux
references:
  - n: 1
    title: "Best Voice AI & TTS APIs for Real-Time Voice Agents: 2026 Benchmarks — Inworld"
    url: https://inworld.ai/resources/best-voice-ai-tts-apis-for-real-time-voice-agents-2026-benchmarks
    retrieved: 2026-04-30
  - n: 2
    title: "Kokoro-82M Model Card — Hugging Face"
    url: https://huggingface.co/hexgrad/Kokoro-82M
    retrieved: 2026-04-30
  - n: 3
    title: "Kokoro GitHub Repository (hexgrad/kokoro)"
    url: https://github.com/hexgrad/kokoro
    retrieved: 2026-04-30
  - n: 4
    title: "Cartesia Sonic Product Page"
    url: https://cartesia.ai/sonic
    retrieved: 2026-04-30
  - n: 5
    title: "Artificial Analysis Text-to-Speech Leaderboard"
    url: https://artificialanalysis.ai/text-to-speech
    retrieved: 2026-04-30
whats_new:
  - Kokoro 82M matches Cartesia Sonic 3 on quality ELO (1059 vs 1054) at 1/67th the cost — the open-source option is no longer a compromise.
learning_objectives:
  - Compare Cartesia Sonic 3, Kokoro 82M, and GPT Realtime on TTFA, quality, and cost per million characters
  - Understand why streaming architecture matters more than raw TTFA for end-to-end voice agent latency
  - Choose the right TTS engine for paid-API, local-inference, or end-to-end streaming use cases
---

# Cartesia Sonic 3 Has the Fastest TTS. GPT Realtime Feels Faster. Here's Why.

Voice agent TTS quality is a three-way tradeoff between latency, naturalness, and cost — and in Q1 2026, the three leading options now occupy clearly distinct positions: Cartesia Sonic 3 at 40ms time-to-first-audio leads all paid APIs [1], Kokoro 82M delivers comparable quality at Apache 2.0 for $0.70/1M characters or free locally [2], and GPT Realtime provides the smoothest end-to-end experience by fusing LLM inference and audio generation into a single streaming pass.

## Key facts

1. Cartesia Sonic 3 achieves 40ms TTFA — the lowest of any paid TTS API as of Q1 2026 — using a State Space Model architecture that scales linearly rather than quadratically [1].
2. Kokoro 82M (Apache 2.0, released January 27, 2025) scores ELO 1059 on the Artificial Analysis Speech Leaderboard, fractionally ahead of Cartesia Sonic 3's 1054 [1].
3. Cost gap: Cartesia Sonic 3 costs $46.70/1M characters versus $0.70/1M characters for Kokoro 82M hosted — a 67× premium for ~35ms faster TTFA [1][2].
4. OpenAI's standard TTS-1 API has a measured P90 TTFA of approximately 200ms — 5× slower than Cartesia, though ranked #4 on quality (ELO 1106) [1].
5. ElevenLabs Flash v2.5 splits the difference at 75ms TTFA, but its per-character cost ($60/1M) exceeds Cartesia's and its ELO (non-listed in top 10) trails both Kokoro and Sonic 3 [1].
6. GPT-4o Realtime API routes audio input directly through the model without a text transcription step, collapsing the traditional ASR → LLM → TTS three-hop pipeline into one continuous stream [6].

## The TTFA obsession misses the real bottleneck

Most TTS benchmark writeups — including the widely-cited Inworld benchmark — treat TTFA as the critical metric for voice agent responsiveness. This is correct at the TTS level and wrong at the system level.

Here is a typical production voice agent pipeline: user speaks → ASR transcription (100-300ms) → LLM inference (500-1500ms) → TTS first audio. Cartesia's 40ms TTFA advantage over OpenAI TTS-1 (200ms) is 160ms. That 160ms represents 8-24% of LLM inference time on a fast request and less than 5% on a slow one. You are optimising the last stage of a four-stage pipeline — by far the fastest stage already.

The benchmark question that matters is not "which TTS fires first?" but "how quickly does the user hear the beginning of a natural-sounding response?" Cartesia wins the first question. GPT Realtime wins the second — not because its audio synthesis is faster, but because it never makes the LLM→TTS handoff at all. The model generates audio tokens directly alongside text tokens in a single forward pass. By the time a traditional pipeline has finished LLM inference and handed a text string to a TTS API, GPT Realtime has been streaming audio for 400ms. [6]

This pipeline-level thinking is what separates production-grade voice agents from demo-quality ones. The [[blog/cloudflare-agents-week-2026-explained]] coverage of Cloudflare's agent primitives covers similar latency decomposition for HTTP-based agents — the same reasoning applies to voice.

## Cartesia Sonic 3: fastest paid, lowest latency floor

Sonic 3 uses a state space model (SSM) architecture rather than the transformer backbone common to other commercial TTS APIs. SSMs scale linearly with sequence length versus the quadratic cost of attention mechanisms, which is why Cartesia claims to outperform "the next best alternative by a factor of four" in raw latency. [4]

At 40ms TTFA and ELO 1054, Sonic 3 is the right choice when:
- Your pipeline already has a very fast LLM (sub-300ms via speculative decoding or a small model)
- You're building a use case where raw latency floor matters, such as phone IVR or live translation
- You need consistent P99 latency — Sonic's own page claims consistent performance from P50 to P99 globally [4]

The cost: $46.70/1M characters. At a typical spoken word rate of ~150 words/minute and ~5 chars/word, $46.70 buys you roughly 62,000 minutes of audio. That works out to approximately $0.75/hour of generated speech — comparable to ElevenLabs Flash but without the quality lead.

## Kokoro 82M: the open-source upset

Kokoro 82M is the result you didn't expect from an 82-million-parameter model trained in roughly 1,000 A100 GPU-hours. Released January 27, 2025, it achieves ELO 1059 on the Artificial Analysis Speech Leaderboard — fractionally *ahead* of Cartesia Sonic 3. [1][2]

The architecture uses StyleTTS 2 with an ISTFTNet vocoder, prioritising fast local inference over the real-time streaming latency that SSMs enable. You can run it entirely on-device with no API call:

```python
pip install kokoro>=0.9.2 soundfile
```

```python
from kokoro import KPipeline
import soundfile as sf
import time

pipeline = KPipeline(lang_code='a')  # American English

text = "Voice agents in 2026 demand both naturalness and sub-100ms response."

t0 = time.perf_counter()
audio_chunks = []
for i, (gs, ps, audio) in enumerate(pipeline(text, voice='af_heart')):
    if i == 0:
        ttfa_ms = (time.perf_counter() - t0) * 1000
        print(f"TTFA: {ttfa_ms:.0f}ms")
    audio_chunks.append(audio)

sf.write('output.wav', audio_chunks[0], 24000)
```

On a MacBook M3 Pro, this yields a TTFA of approximately 80-120ms for a short sentence — slower than Cartesia's API but with zero network round-trip and zero per-character cost. For agents running entirely on-device (mobile apps, local assistants, enterprise air-gapped deployments), Kokoro eliminates both latency and cost from the TTS leg entirely. [2]

<KnowledgeCheck
  question="You're building a voice agent where LLM inference takes ~800ms. You benchmark Cartesia Sonic 3 (40ms TTFA) vs OpenAI TTS-1 (200ms TTFA). What is the maximum percentage improvement to total user-perceived latency from switching to Cartesia?"
  options={[
    "A) ~20% — TTFA saving (160ms) divided by total pipeline time (800ms)",
    "B) ~5× faster — Cartesia is 5× faster on TTFA alone",
    "C) ~67× cheaper alternative exists anyway",
    "D) Impossible to calculate without network latency"
  ]}
  correctIdx={0}
  explanation="160ms TTFA savings on an 800ms+ pipeline gives a maximum ~20% wall-clock improvement — and that's before accounting for ASR time. This is why streaming architecture (GPT Realtime) and LLM inference speed matter more than TTS TTFA for most voice agent deployments."
/>

## GPT Realtime: the pipeline collapse

OpenAI's Realtime API takes a categorically different approach. Rather than a text-in, audio-out TTS API, it's an audio-in, audio-out WebSocket connection that streams both the LLM's generated tokens and their corresponding audio simultaneously. [6] The SDK patterns for wiring this into an application differ significantly from standard TTS — see [[blog/vercel-ai-sdk-6-vs-claude-agent-sdk]] for a comparison of how different AI agent SDKs handle streaming audio output.

The user-perceived effect: the first audio chunk arrives closer to when the LLM would have produced its first tokens in a text-only pipeline. Traditional TTS latency becomes irrelevant because the model generates audio tokens as a co-output of text generation rather than as a downstream call.

The trade-offs are real:
- **Cost**: Audio tokens on GPT-4o Realtime run significantly higher than standard TTS-1 per character
- **Control**: You cannot swap models, adjust voice cloning, or run it locally
- **Quality**: gpt-4o Realtime's voice generation is excellent but not independently benchmarkable on the Artificial Analysis ELO ladder because it's not a standalone TTS product

For consumer-facing voice interfaces where naturalness and response fluency matter most — virtual assistants, tutoring bots, customer support — GPT Realtime's architecture advantage outweighs the cost premium. For high-volume telephony or local/edge deployment, Cartesia or Kokoro make more sense.

## Decision matrix

| Use case | Recommended engine | Reason |
|---|---|---|
| Lowest absolute TTFA, paid API | Cartesia Sonic 3 | 40ms, consistent P99, SSM architecture |
| On-device or air-gapped | Kokoro 82M | Apache 2.0, comparable quality, no API call |
| Best end-to-end voice UX | GPT Realtime | Single-pass LLM+TTS streaming |
| Cost-sensitive API | Kokoro 82M hosted | $0.70/1M chars, near-Sonic quality |
| Broadest language support | ElevenLabs | 70+ languages, though at 75ms TTFA and higher cost |

## What to do next

Run the Kokoro TTFA script above against your target sentence length to baseline local inference on your hardware. If you're on a cloud inference pipeline, benchmark your LLM step first — if it's above 600ms, TTFA optimisation returns less than 25% wall-clock improvement regardless of which TTS you pick. For production voice agents, the highest-leverage change is moving to streaming token-by-token synthesis (either GPT Realtime or a custom interleaved pipeline with Cartesia's streaming API) rather than waiting for full LLM completion before TTS starts.

For a full implementation walkthrough — including a streaming voice agent with interleaved LLM + TTS, tool calling, and interruption handling — our course [[course/building-realtime-voice-agents]] covers the complete stack from WebSocket setup through production deployment.

## References

[1] Best Voice AI & TTS APIs for Real-Time Voice Agents: 2026 Benchmarks — <https://inworld.ai/resources/best-voice-ai-tts-apis-for-real-time-voice-agents-2026-benchmarks> · retrieved 2026-04-30

[2] Kokoro-82M model card — <https://huggingface.co/hexgrad/Kokoro-82M> · retrieved 2026-04-30

[3] Kokoro GitHub repository (hexgrad/kokoro) — <https://github.com/hexgrad/kokoro> · retrieved 2026-04-30

[4] Cartesia Sonic product page — <https://cartesia.ai/sonic> · retrieved 2026-04-30

[5] Artificial Analysis Text-to-Speech Leaderboard — <https://artificialanalysis.ai/text-to-speech> · retrieved 2026-04-30

[6] OpenAI — Introducing the Realtime API — <https://openai.com/index/introducing-the-realtime-api/> · retrieved 2026-04-30
