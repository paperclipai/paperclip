# Workers AI Troubleshooting

Use the actual error, model identifier, integration, and installed versions to choose the relevant reference.

| Symptom or decision | Documentation and checks |
|---------------------|--------------------------|
| Missing binding or types | [Binding configuration](https://developers.cloudflare.com/workers-ai/configuration/bindings/) and [Workers TypeScript](https://developers.cloudflare.com/workers/languages/typescript/); check the environment being run |
| Development inference fails | [Workers and Wrangler setup](https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/); check account access and binding setup |
| Unknown model, invalid input, or unexpected response | Open the exact model in the [catalog](https://developers.cloudflare.com/workers-ai/models/); check its schema, context window, and feature support |
| Inference error or retry decision | [Error codes and HTTP statuses](https://developers.cloudflare.com/workers-ai/platform/errors/) |
| Throttling or concurrency planning | [Current limits](https://developers.cloudflare.com/workers-ai/platform/limits/) |
| Usage or cost estimate | [Current pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/); use the selected model's billing units and expected workload |
| Old SDK examples fail | [Native binding](https://developers.cloudflare.com/workers-ai/configuration/bindings/), [AI SDK](https://developers.cloudflare.com/workers-ai/configuration/ai-sdk/), or [OpenAI compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/), according to the integration |

Do not copy an error-code mapping, per-request neuron estimate, or context-window range from another model or an older example. Measure latency for the intended workload rather than promising a fixed cold-start or inference time.
