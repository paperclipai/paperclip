---
name: "Qwen Tool Use + Qwen Agent"
kind: agent-sdk
one_liner: "Qwen Tool Use is Alibaba's tool-calling capability available across the Qwen 2.5 and Qwen 3.x families, with a JSON-Schema-based interface compatible with OpenAI function-calling clients — paired with Qwen Agent, an open-source Python framework that adds multi-step orchestration, browser control, and code execution on top of any Qwen model."
shipped: "2024-09-19"
status: ga
description: "Alibaba's open-source tool-calling and agent framework for the Qwen model family."
primary_url: "https://github.com/QwenLM/Qwen-Agent"
related_terms: [tool-use, function-calling, agent-harness]
related_courses: []
related_blogs: [gemma-4-vs-llama-4-vs-qwen-3-5]
sameAs: []
---

## What Qwen Tool Use offers

The Qwen API surface (DashScope from Alibaba Cloud) implements OpenAI-compatible function calling — the same `tools` parameter, the same `tool_calls` content blocks. This means existing OpenAI function-calling client libraries work against Qwen with only an endpoint URL change.

Qwen Agent (the open-source companion) provides higher-level abstractions: a multi-step planning loop, built-in browser control via Selenium or Playwright, sandboxed Python code execution, and a memory module for long-running tasks. It's roughly equivalent to LangGraph or the Vercel AI SDK 6 ToolLoopAgent, but designed specifically against Qwen's tool-call quirks.

## Why Qwen matters for builders

Qwen 2.5 and 3.x are the strongest open-weights option for tool use as of April 2026 — Qwen 3.5-72B-Instruct is competitive with Claude Sonnet 4.6 on simple tool-call benchmarks while running on 4×A100 hardware. For self-hosting AI in regulated environments (China, but also EU and India for on-premise), Qwen + Qwen Agent is the most production-ready open-weights stack.

## Limitations

Determinism on long agent loops still trails frontier-vendor models. The English-language documentation is incomplete; many features are documented only in Chinese on Alibaba's DashScope console.
