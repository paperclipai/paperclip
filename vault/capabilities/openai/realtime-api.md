---
name: "OpenAI Realtime API"
kind: api
one_liner: "The OpenAI Realtime API, generally available since late 2024 and significantly expanded through April 2026, provides a streaming WebSocket interface for voice-to-voice conversation, tool calling, image input, MCP server invocation, SIP telephony, and DTMF tone handling — turning GPT into a real-time agent that can hold a phone call."
shipped: "2024-10-01"
status: ga
description: "OpenAI's WebSocket-based real-time voice + tool agent API."
primary_url: "https://platform.openai.com/docs/guides/realtime"
related_terms: [tool-use, function-calling, mcp]
related_courses: []
related_blogs: [voice-agents-2026-tts-latency-benchmark]
sameAs: []
---

## Capabilities as of April 2026

The Realtime API now supports: voice-in / voice-out (STT + TTS handled in-API), function calling, image input mid-conversation, MCP server invocation (the agent can call tools exposed by external MCP servers), SIP for phone-system integration, and DTMF tone generation/recognition for IVR navigation.

The April 2026 update added the SIP + DTMF features specifically for telephony agents — meaning a developer can wire the API directly to a phone number and have GPT handle calls end-to-end without a separate voice runtime.

## Latency profile

Voice-to-voice round-trip latency is typically 300-800ms in the same region, comparable to Cartesia Sonic 3 + GPT pipeline but tighter end-to-end because OpenAI runs everything in one server-side stack.

## When to use

Use the Realtime API when: you want voice agents with sub-second response, you're integrating with telephony, or you want a single API for both modality and reasoning. Build your own pipeline (Cartesia + GPT-5.5 + AssemblyAI, or Kokoro + Claude + custom STT) when: you need full control over voice quality, you have strict on-device requirements, or your costs at scale make the bundled pricing unfavorable.
