# Implementation Plan: Add Support for Ollama, LM Studio, and OpenRouter APIs

**Date**: 2026-05-24  
**Status**: Planning  
**Owner**: To be assigned  
**Scope**: Add three new OpenAI-compatible model adapter implementations

## 1. Overview

This plan adds support for three open-model inference platforms to Paperclip's adapter system:

- **Ollama**: Local/self-hosted LLM inference engine
- **LM Studio**: Desktop application for running open-source LLMs locally
- **OpenRouter**: API service providing access to multiple open and proprietary models

All three platforms expose OpenAI-compatible APIs, allowing us to build unified adapters that leverage shared HTTP client infrastructure while providing platform-specific configuration and authentication handling.

## 2. Architecture

### 2.1 Design Pattern

Each adapter follows the existing Paperclip pattern established by `claude-local`:

```
packages/adapters/
├── {adapter-name}-openai/          # Shared OpenAI-compatible base
│   ├── src/
│   │   ├── index.ts                # Model definitions, metadata
│   │   ├── server/
│   │   │   ├── index.ts            # Exports and session codec
│   │   │   ├── execute.ts          # HTTP invocation orchestration
│   │   │   ├── models.ts           # Platform-specific model list
│   │   │   ├── config.ts           # Config validation & defaults
│   │   │   ├── quota.ts            # Optional: platform quota tracking
│   │   │   └── *.test.ts           # Unit tests
│   │   ├── ui/
│   │   │   └── index.ts            # UI panel/config components (if needed)
│   │   └── cli/
│   │       └── quota-probe.ts      # Optional: quota inspection
│   ├── package.json
│   ├── tsconfig.json
│   └── vitest.config.ts
├── ollama-local/                   # Specialized implementations
├── lm-studio-local/
└── openrouter-api/
```

### 2.2 Shared Infrastructure

Rather than duplicating HTTP client logic, we introduce a utility layer in `adapter-utils`:

- `packages/adapter-utils/src/openai-compatible-client.ts` — reusable HTTP, auth, retry, and streaming logic
- Integration with existing error handling, redaction, and billing frameworks

### 2.3 Session and Resumption

For stateful chat-based workflows:
- Session codec serializes conversation context (messages, model, temperature, etc.)
- Resume logic detects model/config mismatches and starts fresh if needed
- Streaming SSE/JSON-lines parsing handles both completion and chat endpoints

## 3. Detailed Adapter Specifications

### 3.1 Ollama Adapter (`ollama-local`)

**Use Case**: Local development and self-hosted deployment  
**Configuration**:
```typescript
{
  baseUrl: "http://localhost:11434",         // Default Ollama port
  model: "llama2",                            // Model name in Ollama
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  repeatPenalty: 1.1,
  contextWindow: 4096,                        // For prompt sizing
  systemPrompt?: string,                      // Optional default system message
  requestTimeoutMs: 300000,                   // 5-minute default for local inference
  stream: true,                               // Use streaming endpoints
}
```

**Models**:
- Query live list via `GET /api/tags` on startup
- Cache with 1-hour TTL
- Fallback to hardcoded common models (llama2, mistral, neural-chat, etc.)

**Execution Path**:
1. Build request body with model, messages, and parameters
2. POST to `{baseUrl}/api/chat` with streaming enabled
3. Parse SSE event stream, extract token-by-token output
4. Aggregate usage metrics from final message
5. Session codec saves model + last N messages for resume

**Quota/Limits**: None (self-hosted; rate-limit by deployment)

**Authentication**: None (assumes local/trusted network)

### 3.2 LM Studio Adapter (`lm-studio-local`)

**Use Case**: Desktop-based local inference with GUI  
**Configuration**:
```typescript
{
  baseUrl: "http://localhost:1234",          // Default LM Studio port
  model: "model-identifier",                 // Loaded model in LM Studio
  temperature: 0.7,
  topP: 0.9,
  frequencyPenalty: 0.0,
  presencePenalty: 0.0,
  maxTokens: 2048,
  requestTimeoutMs: 300000,
  stream: true,
}
```

**Models**:
- List available models via `GET /v1/models`
- Reflect currently-loaded model in UI
- Support model switching via UI with heartbeat reconfig

**Execution Path**:
1. Same as Ollama but POST to `{baseUrl}/v1/chat/completions`
2. LM Studio returns standard OpenAI-compatible response
3. Use `finish_reason` and token counts from response

**Quota/Limits**: None (self-hosted)

**Authentication**: Optional API key in headers (if LM Studio configured for auth)

### 3.3 OpenRouter Adapter (`openrouter-api`)

**Use Case**: Cloud-hosted multi-model inference  
**Configuration**:
```typescript
{
  apiKey: "sk-or-...",                       // Required; should use secret ref
  model: "openai/gpt-4",                     // Use OpenRouter model slug
  temperature: 0.7,
  topP: 1.0,
  topK: null,
  frequencyPenalty: 0.0,
  presencePenalty: 0.0,
  maxTokens: 4096,
  requestTimeoutMs: 120000,                  // 2-minute default for cloud
  customSystemPrompt?: string,
  customHeaders?: Record<string, string>,    // For organization/account headers
  billingCode?: string,                      // For cost allocation
}
```

**Models**:
- Query `GET https://openrouter.io/api/v1/models` (public list)
- Filter by provider tags (e.g., `free`, `requires_api_key`)
- Cache with 24-hour TTL
- Fallback to curated list of popular models

**Execution Path**:
1. Build request with model, messages, and optional `transforms` for response formatting
2. POST to `https://openrouter.io/api/v1/chat/completions` with streaming
3. Parse SSE response; OpenRouter includes usage and cost in metadata headers
4. Extract `x-cost` header for billing integration
5. Session codec saves full chat history for multi-turn conversations

**Quota/Limits**:
- Respect `x-ratelimit-remaining-requests` header
- Log warnings when approaching quota limits
- Session codec can implement optional backoff/request prioritization

**Authentication**:
- Bearer token in `Authorization: Bearer {apiKey}` header
- Store encrypted in `company_secrets` with key ref in `adapter_config.env`
- Validate on config save via probe request

### 3.4 Session Codec (Shared)

All three adapters implement the same session codec pattern:

```typescript
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw): SessionParams | null {
    // Extract conversation state, model, temperature, etc.
    // Validate compatibility with current config
  },
  serialize(params): SerializedSession {
    // Save model, last N messages, token counts
  },
  getDisplayId(params): string {
    // Return conversation start timestamp or ID
  }
}
```

Resume logic:
- If model hasn't changed and config is compatible, restore conversation
- If context window would overflow, truncate oldest messages
- If model changed significantly, start fresh with single system message

## 4. Implementation Phases

### Phase 1: Foundation (Week 1)

**Deliverables**:
- Add `openai-compatible-client.ts` to `adapter-utils` with:
  - HTTP client with retry/timeout logic
  - SSE streaming parser
  - Error handling and classification (rate-limit, auth, transient, etc.)
  - Redaction for auth headers and API keys
  - Optional billing cost extraction

**Tasks**:
- [ ] Design `OpenAICompatibleClientConfig` interface
- [ ] Implement HTTP client with exponential backoff
- [ ] Add SSE stream parser for chat endpoints
- [ ] Add error classification (maps API errors to `AdapterExecutionResult.errorCode`)
- [ ] Write client unit tests with mocked HTTP responses
- [ ] Update `packages/adapter-utils/src/index.ts` exports

**Estimated effort**: 3–4 days

### Phase 2: Ollama Adapter (Week 2)

**Deliverables**:
- Functional Ollama adapter with local model enumeration

**Tasks**:
- [ ] Create `packages/adapters/ollama-local/` package structure
- [ ] Implement `src/index.ts` with model definitions and metadata
- [ ] Implement `src/server/execute.ts` using shared client
- [ ] Implement `src/server/models.ts` with dynamic model fetch
- [ ] Implement `src/server/index.ts` with session codec
- [ ] Add integration tests (mock Ollama server)
- [ ] Add UI config panel (baseUrl, model selector)
- [ ] Document configuration in `agentConfigurationDoc`

**Estimated effort**: 2–3 days

### Phase 3: LM Studio Adapter (Week 2)

**Deliverables**:
- Functional LM Studio adapter

**Tasks**:
- [ ] Create `packages/adapters/lm-studio-local/` package structure
- [ ] Implement core adapter files (similar to Ollama)
- [ ] Handle model switching and detection of loaded model
- [ ] Add optional API key authentication
- [ ] Add integration tests
- [ ] Add UI config panel

**Estimated effort**: 2–3 days

### Phase 4: OpenRouter Adapter (Week 3)

**Deliverables**:
- Production-ready OpenRouter adapter with quota tracking

**Tasks**:
- [ ] Create `packages/adapters/openrouter-api/` package structure
- [ ] Implement core adapter with API key secret management
- [ ] Implement `src/server/models.ts` with public model list caching
- [ ] Implement quota tracking via response headers
- [ ] Implement billing cost extraction and logging
- [ ] Add config validation (API key probe on save)
- [ ] Add integration tests (mock OpenRouter API)
- [ ] Add UI config panel with billing code, custom headers, model selector
- [ ] Add quota probe CLI command

**Estimated effort**: 3–4 days

### Phase 5: Integration & Registration (Week 3)

**Deliverables**:
- Adapters registered and exposed in Paperclip core

**Tasks**:
- [ ] Update `packages/shared/src/constants.ts` with new adapter type enums
- [ ] Register adapters in `server/src/services/adapter-registry.ts` (or equivalent)
- [ ] Update UI adapter selector dropdown
- [ ] Add adapter type validation in database schema (if needed)
- [ ] Update `doc/SPEC-implementation.md` section 7.2 agents table with new adapter types
- [ ] Add quick-start documentation for each adapter

**Estimated effort**: 1–2 days

### Phase 6: Testing & Verification (Week 4)

**Deliverables**:
- Full end-to-end test coverage and release readiness

**Tasks**:
- [ ] Run full repo typecheck: `pnpm -r typecheck`
- [ ] Run unit test suite: `pnpm test`
- [ ] Run build: `pnpm build`
- [ ] Write E2E tests for agent creation → task assignment → execution flow
- [ ] Test resume logic with model switching and context window overflow
- [ ] Verify error handling for auth/quota/transient failures
- [ ] Test with real Ollama, LM Studio, and OpenRouter instances (if possible)
- [ ] Document troubleshooting guide

**Estimated effort**: 2–3 days

## 5. Database & Schema Changes

**No breaking changes required.** Existing `agents.adapter_type` enum extends to include:
- `ollama_local`
- `lm_studio_local`
- `openrouter_api`

Add these to `packages/db/src/schema/agents.ts` as new enum values.

## 6. API Contract Changes

### New Config Schemas

Each adapter exposes configuration via `AdapterConfigSchema`:

**Ollama**:
```json
{
  "fields": [
    { "key": "baseUrl", "type": "string", "default": "http://localhost:11434" },
    { "key": "model", "type": "select", "options": "dynamic" },
    { "key": "temperature", "type": "number", "min": 0, "max": 2, "default": 0.7 },
    { "key": "stream", "type": "boolean", "default": true },
  ]
}
```

**LM Studio**: Similar structure, different defaults.

**OpenRouter**:
```json
{
  "fields": [
    { "key": "apiKey", "type": "secret", "required": true },
    { "key": "model", "type": "select", "options": "dynamic" },
    { "key": "billingCode", "type": "string", "required": false },
  ]
}
```

### Shared Session Format

All three use compatible session serialization:

```typescript
type SessionParams = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  timestamp?: string;
}
```

## 7. Error Handling Strategy

Each adapter classifies errors into standard codes:

- `auth_required` — API key invalid or missing (OpenRouter)
- `rate_limit` — quota exceeded or request throttled
- `transient_upstream` — temporary service failure
- `model_not_found` — specified model unavailable
- `context_window_exceeded` — prompt too long for model
- `timeout` — request exceeded time limit
- `validation_error` — malformed request

## 8. Testing Strategy

### Unit Tests

- Mock HTTP responses for each adapter
- Test session codec serialize/deserialize
- Test error classification
- Test prompt truncation when context window exceeded

### Integration Tests

- Spin up local Ollama/LM Studio containers (or use real instances if available)
- Test full invoke → parse → cost calculation flow
- Test resume with model switching
- Test quota header parsing (OpenRouter)

### E2E Tests

- Create test agent for each adapter
- Assign a task and invoke heartbeat
- Verify execution result, usage metrics, and cost tracking
- Verify session resumption on subsequent heartbeats

### Regression Suite Additions

Add to required pre-release checks:
- [ ] OpenAI-compatible client retry logic
- [ ] Session resume with context window edge cases
- [ ] Error code mapping for each platform

## 9. Documentation

### User-Facing

1. **Quick Start Guides** (in `doc/` or UI help):
   - "Getting started with Ollama"
   - "Setting up LM Studio with Paperclip"
   - "Configuring OpenRouter billing and quotas"

2. **Troubleshooting**:
   - Common connection errors and fixes
   - Model selection and format validation
   - API key and authentication issues

### Developer-Facing

1. **Adapter Architecture Guide**: How to extend with new OpenAI-compatible providers
2. **Session Codec Pattern**: How to implement stateful resume logic
3. **Billing Integration**: How to extract and log cost metrics

## 10. Acceptance Criteria

- [ ] All three adapters are registered and selectable in UI
- [ ] Agent can be created with each adapter type
- [ ] Heartbeat execution works end-to-end for each adapter
- [ ] Session resumption works (if supported by adapter)
- [ ] Error classification and retry logic work correctly
- [ ] Cost extraction and logging work (OpenRouter)
- [ ] Full repo builds and all tests pass
- [ ] Documentation is complete and accurate
- [ ] No regression in existing adapter functionality (claude-local, codex-local, etc.)

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| API incompatibilities between platforms | Adapter breakage | Comprehensive mocking in tests; early integration testing |
| Session resume logic breaks on model update | Loss of conversation state | Explicit version/config checking in deserialize; fallback to fresh session |
| Rate-limit handling varies by platform | Unfair quota exhaustion | Platform-specific backoff; expose quota metrics in dashboard |
| Context window edge cases | Prompt truncation errors | Robust validation before sending; comprehensive edge-case tests |

## 12. Success Metrics

- All three adapters pass unit + integration test suite
- E2E test with each adapter succeeds
- No regressions in existing adapter tests
- Documentation is 100% complete
- User can deploy multi-adapter setup with Ollama + OpenRouter without issues

## 13. Post-V1 Enhancements (Out of Scope)

- Adapter-specific UI panels for quota/cost dashboard
- Automatic model recommendation based on task complexity
- Load-balancing across multiple OpenRouter providers
- Custom cost calculation and chargeback models
- Real-time streaming response output to board operator UI
