---
name: "Custom GPTs"
kind: plugin
one_liner: "Custom GPTs are user-creatable, shareable variants of ChatGPT introduced by OpenAI in November 2023, where a creator configures a system prompt, optional file uploads, and optional Actions (third-party API calls) to produce a specialized assistant that other ChatGPT subscribers can use."
shipped: "2023-11-06"
status: ga
description: "User-built specialized ChatGPT variants, shareable via the GPT Store."
primary_url: "https://openai.com/index/introducing-gpts/"
related_terms: [function-calling, tool-use]
related_courses: []
related_blogs: []
sameAs:
  - https://en.wikipedia.org/wiki/ChatGPT#GPTs
---

## What Custom GPTs are

A Custom GPT bundles a system prompt + reference files + Actions (OpenAPI-described external API calls) into a single shareable artifact. Creators can publish to the GPT Store; subscribers can install and use them within their ChatGPT workflow.

Custom GPTs are not the same as the Assistants API (which is a developer-side concept for building applications). Custom GPTs live in ChatGPT's UI; Assistants live in your code. The 2025-2026 trajectory is toward consolidation: the Assistants API has gradually absorbed Custom GPT-like patterns, and the GPT Store has converged with the Plugins/Connectors model.

## Limitations

Custom GPTs run on whichever ChatGPT model the user has selected (free tier limited to GPT-4o-mini variants; Plus/Pro users get full access). They cannot maintain persistent state across conversations beyond what fits in the context window. Their Actions surface is limited to JSON-Schema-conformant REST APIs.

## Comparison with Anthropic Skills + Connectors

Custom GPTs are closer to Anthropic Skills (instruction packaging) plus Connectors (third-party integration) wrapped together — but the Anthropic offerings are unbundled (Skills are pure instructions, Connectors are pure integrations) which is more flexible for advanced builders. Custom GPTs are friendlier for non-developers.
