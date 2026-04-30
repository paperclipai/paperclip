---
name: "Gemini Extensions"
kind: extension
one_liner: "Gemini Extensions are Google's first-party integrations that let Gemini (in the consumer Gemini app) read and act on user data in connected Google services — Gmail, Google Drive, Google Calendar, Google Maps, Google Flights, Google Hotels, YouTube, and the Workspace suite — with explicit user consent and Google's standard OAuth scoping."
shipped: "2024-02-08"
status: ga
description: "Google's first-party agent integrations for Gemini across Workspace + consumer Google services."
primary_url: "https://gemini.google.com/help/extensions"
related_terms: [tool-use, agent-harness]
related_courses: [gemini-enterprise-agent-platform-hands-on-tour]
related_blogs: []
sameAs: []
---

## What Extensions cover

Extensions are the consumer-facing equivalent of Anthropic Connectors and OpenAI Custom GPT Actions. The user authorizes Gemini to access a service; subsequent prompts can reference data and take actions in that service ("schedule a meeting with my team next Tuesday morning," "find the cheapest flight to Tokyo in April").

Notable Extensions as of April 2026: Workspace (Gmail + Drive + Calendar + Docs + Sheets), Google Flights, Google Hotels, Google Maps (with route planning + place lookup), YouTube (transcripts + content discovery), Google Tasks, and Google Keep.

## Limitations and the consumer / enterprise split

Gemini Extensions are a consumer feature available in the Gemini app + Workspace personal accounts; the equivalent enterprise capability lives in Gemini Enterprise via the Vertex Agent Platform (which has its own per-org admin controls + a different developer surface).

For builders: Extensions are not directly callable from your own application; they only work inside the Gemini chat surface. To get equivalent behavior in your app, build a Vertex Agent with the equivalent tools or call the underlying Workspace APIs directly with your own OAuth flow.
