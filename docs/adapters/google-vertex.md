---
title: "Google Vertex AI"
description: "Run Paperclip agents on Gemini models through Google Cloud Vertex AI"
---

The `google_vertex` adapter runs the local Hermes agent harness with its provider fixed to Google Vertex AI. It uses Gemini models through Vertex's OpenAI-compatible endpoint while retaining Hermes tools, skills, and session continuity.

## Prerequisites

- Hermes Agent 0.21.2 or newer on the execution host
- A Google Cloud project with the Vertex AI API enabled and billing active
- An identity with the `roles/aiplatform.user` role
- Either a service-account JSON file or Google Application Default Credentials (ADC)

## Configure an agent

Choose **Google Vertex AI** when creating an agent, then set:

- **Model**: a Vertex model ID such as `google/gemini-3.8-flash`
- **Google Cloud project ID**: optional when embedded in the credential
- **Vertex region**: defaults to `global`; Gemini 3 preview models require it
- **Service-account JSON path**: optional absolute path on the execution host; leave blank to use ADC

Vertex uses OAuth2 rather than a static API key. Paperclip stores only the credential-file path and non-secret routing configuration. Hermes mints and refreshes short-lived access tokens at runtime.

For local development with ADC, configure Google Cloud on the same host that executes the agent:

```bash
gcloud auth application-default login
```

For servers, place the service-account JSON outside the repository, restrict its filesystem permissions, and configure its absolute path in the adapter. Do not paste service-account JSON or access tokens into agent configuration fields.
