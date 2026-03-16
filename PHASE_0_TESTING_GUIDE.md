# Phase 0: End-to-End Testing Guide

Complete this checklist to verify all Phase 0 features work together:

## Prerequisite: App Running

- [ ] Paperclip running at `http://localhost:3100`
- [ ] Database healthy and migrations applied
- [ ] No startup errors in Docker logs

```bash
docker-compose logs app | tail -50
```

---

## Test 1: Bootstrap Flow

**Goal:** Sign up as first admin and accept bootstrap invite

### Steps:
1. [ ] Open http://localhost:3100 in browser
2. [ ] Verify "Set up your Paperclip instance" page appears
3. [ ] Enter name, email, password
4. [ ] Click "Create account"
5. [ ] Verify auto-redirected to onboarding (NOT back to invite page)
6. [ ] Verify session is persisted (reload page → still on onboarding)

**Expected:** Single flow without loops, bootstrap invite accepted automatically

---

## Test 2: Company & CEO Agent Creation (Steps 1-2)

**Goal:** Create first company and CEO agent

### Step 1: Company Info
1. [ ] Enter company name: "Test Corp"
2. [ ] Click "Next" → proceeds to Step 2

### Step 2: CEO Agent
1. [ ] Agent name field shows: "Adit" (user's name)
2. [ ] Role shows: "ceo"
3. [ ] Adapter Type shows: "Platform (Built-in)"
4. [ ] Click "Next" → proceeds to Step 3

**Expected:** Both steps complete smoothly with platform adapter selected

---

## Test 3: LLM Configuration (Step 3) ⭐ CRITICAL

**Goal:** Configure LLM provider (BYOM) and test validation

### Option A: OpenRouter (Recommended)
1. [ ] Click "Add LLM Provider"
2. [ ] Select "OpenRouter"
3. [ ] Paste your OpenRouter API key
4. [ ] Click "Test & Save"
5. [ ] Verify spinner appears (1-2 seconds)
6. [ ] Verify "Provider saved!" message appears
7. [ ] Model dropdown populates with models
8. [ ] Select any model (e.g., "OpenAI GPT-4o mini")
9. [ ] Click "Continue" → proceeds to Step 4

**Expected:** Validation success, models load, no errors

### Option B: Anthropic
1. [ ] Click "Add LLM Provider"
2. [ ] Select "Anthropic"
3. [ ] Paste your Anthropic API key
4. [ ] Click "Test & Save"
5. [ ] Verify success message
6. [ ] Select "Claude 3.5 Sonnet" model
7. [ ] Click "Continue" → proceeds to Step 4

### Option C: Local Ollama
1. [ ] Start Ollama locally: `ollama serve`
2. [ ] Run: `ollama pull mistral` (in another terminal)
3. [ ] Click "Add LLM Provider"
4. [ ] Select "Ollama"
5. [ ] Enter base URL: `http://localhost:11434`
6. [ ] Click "Test & Save"
7. [ ] Verify success
8. [ ] Select "mistral" from dropdown
9. [ ] Click "Continue" → proceeds to Step 4

**Expected:** All three options work, validation endpoint returns 200, models list loads

---

## Test 4: First Task Creation (Step 4)

**Goal:** Create a task for the CEO agent

### Steps:
1. [ ] Agent name still shows: "Adit" (CEO)
2. [ ] Task title field: enter "Plan company structure"
3. [ ] Click "Create Agent & Task"
4. [ ] Verify spinner appears (2-3 seconds)
5. [ ] Verify redirected to Step 5 (Launch page)

**Expected:** Agent created, task created and assigned, smooth progression

---

## Test 5: Launch & Dashboard (Step 5)

**Goal:** View launch page and verify app state

### Steps:
1. [ ] See "Your Paperclip instance is ready!" message
2. [ ] See company info: "Test Corp"
3. [ ] See CEO agent: "Adit"
4. [ ] See task: "Plan company structure"
5. [ ] Click "Go to Dashboard"
6. [ ] Verify dashboard loads (no 404 errors)

**Expected:** Clean launch, dashboard accessible

---

## Test 6: Agent Chat Integration (Task 4)

**Goal:** Verify agent chat is functional

### Steps:
1. [ ] From dashboard, find agent "Adit" (CEO)
2. [ ] Click on agent → opens Agent Detail page
3. [ ] Verify tabs: "Overview", "Chat"
4. [ ] Click "Chat" tab
5. [ ] See chat interface with message input
6. [ ] Type message: "What are your goals?"
7. [ ] Click send
8. [ ] Verify message sent (shows in chat)
9. [ ] Platform agent processes message ✅ (TBD - executor implementation)

**Expected:** Chat UI renders, messages send, LLM executor integrates

---

## Test 7: Platform Adapter Execution ⭐ PHASE 2

**Goal:** Verify platform agent executes tasks

*Note: This requires full LLM executor implementation - placeholder in Phase 0*

### Steps:
1. [ ] Create issue: "Build homepage"
2. [ ] Assign to CEO agent
3. [ ] Verify agent receives task (event triggered)
4. [ ] Platform adapter calls LLM with task description
5. [ ] LLM response processed
6. [ ] Issue updated with execution result

**Expected:** Agent autonomously executes, issue marked as in_progress → done

---

## Validation Checklist

### Database
- [ ] `psql` connects to Paperclip DB
- [ ] Tables exist: `companies`, `agents`, `issues`, `agentConversations`
- [ ] Company record created
- [ ] Agent record created with `adapter_type = 'platform'`
- [ ] Issue record created

### API Endpoints
- [ ] `POST /api/llm-providers/validate` → 200 with { ok: true }
- [ ] `POST /api/companies` → 201 company created
- [ ] `POST /api/agents` → 201 agent created
- [ ] `POST /api/issues` → 201 issue created
- [ ] `GET /api/agents/:id/chat` → 200 chat messages

### Frontend
- [ ] No console errors (F12 → Console)
- [ ] No network 500 errors (F12 → Network)
- [ ] React Query devtools show cached queries
- [ ] CSS styling correct (TailwindCSS loaded)

---

## Common Issues & Fixes

### "Port 3100 already in use"
```bash
docker-compose down
docker-compose up -d
```

### "Validation error on LLM test"
- Check API key is valid (try in OpenRouter UI directly)
- Verify network connectivity to provider
- Check `.env` has `OPENROUTER_API_KEY=...` set
- Check server logs: `docker-compose logs app | grep -i "validation"`

### "Sign in button does nothing"
- Refresh page (F5)
- Check console for errors (F12)
- Verify backend is healthy: `curl http://localhost:3100/api/health`

### "Chat doesn't send messages"
- Check platform adapter executor is implemented (Phase 2)
- Verify `agentConversations` table exists
- Check `agentRuntimeState` for agent status

---

## Success Criteria

✅ **Phase 0 Complete When:**
1. Bootstrap flow works (one signup, no loops)
2. Onboarding 5-step flow completes
3. LLM provider validation works (all 3 providers)
4. CEO agent created with platform adapter
5. First task created and assigned
6. Agent chat UI renders and messages send
7. No console/network errors
8. Docker deployment stable (no restarts)

---

## Notes for Phase 1

- Platform adapter executor is stub (returns success)
- Full LLM integration with tool calling deferred
- Channels/messaging integration deferred
- Workflow builder UI deferred
