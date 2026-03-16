# Phase 0: Ready to Test Checklist

**Status:** Docker build in progress (step 26/24, ~5-10 min remaining)

When Docker finishes → Use this checklist to rapidly verify Phase 0 is complete.

---

## 1. Start Paperclip (When Docker Build Completes)

```bash
# In terminal:
docker-compose up -d

# Wait 10-15 seconds for services to be healthy
docker-compose ps
```

**Expected:**
- ✅ app (paperclip-v2-app) - Up
- ✅ db (pgvector:pg17) - Up
- ✅ No restart loops

---

## 2. Verify Health Endpoint

```bash
curl http://localhost:3100/api/health
```

**Expected Response:**
```json
{
  "status": "healthy",
  "bootstrapStatus": "bootstrap_pending",
  "deploymentMode": "authenticated"
}
```

**If fails:** Check `docker-compose logs app | tail -50`

---

## 3. Open Browser & Test Bootstrap Flow

1. Navigate to: `http://localhost:3100`
2. Should see: **"Set up your Paperclip instance"** page
3. Fill in:
   - Name: `Test User`
   - Email: `test@example.com`
   - Password: `Test@123456`
4. Click: "Create account"
5. **Expected:** Auto-redirected to onboarding (NOT back to invite page)

**If loops:** Check browser console (F12) for errors

---

## 4. Onboarding Steps 1-5

### Step 1: Company
- Enter: "Test Corp"
- Click: "Next"
- Expected: Progress to Step 2 ✅

### Step 2: CEO Agent
- Agent name: `Test User` (auto-filled)
- Role: `ceo`
- Adapter: `Platform (Built-in)`
- Click: "Next"
- Expected: Progress to Step 3 ✅

### Step 3: LLM Provider ⭐ CRITICAL

**Option A: OpenRouter (Recommended)**
```
1. Click: "Add LLM Provider"
2. Select: "OpenRouter"
3. Paste: Your OpenRouter API key
4. Click: "Test & Save"
   Expected: "Provider saved!" message (2-3 sec)
5. Models dropdown populates
6. Select any model
7. Click: "Continue" → Step 4
```

**Option B: Anthropic**
```
1. Click: "Add LLM Provider"
2. Select: "Anthropic"
3. Paste: Your Anthropic API key
4. Click: "Test & Save"
   Expected: "Provider saved!" message
5. Select: "Claude 3.5 Sonnet"
6. Click: "Continue" → Step 4
```

**Option C: Ollama (Local)**
```
1. Start locally: ollama serve
2. In another terminal: ollama pull mistral
3. Click: "Add LLM Provider"
4. Select: "Ollama"
5. Enter: http://localhost:11434
6. Click: "Test & Save"
   Expected: Success message
7. Select: "mistral"
8. Click: "Continue" → Step 4
```

**If validation fails (400 error):**
- Check API key is valid
- Check network connectivity
- Check console for error details
- Check server logs: `docker-compose logs app | grep -i "validation"`

---

### Step 4: First Task
- Agent name: `Test User` (read-only)
- Task title: `Plan company structure`
- Click: "Create Agent & Task"
- Expected: Redirected to Step 5 ✅

**If fails:** Check `docker-compose logs app | grep -i "error"`

---

### Step 5: Launch
- See: "Your Paperclip instance is ready!"
- Company: "Test Corp"
- Agent: "Test User"
- Task: "Plan company structure"
- Click: "Go to Dashboard"
- Expected: Dashboard loads ✅

---

## 5. Verify Database State

```bash
# Connect to PostgreSQL
docker exec paperclip-v2-db psql -U paperclip -d paperclip

# Check company was created
SELECT id, name FROM companies;

# Check agent was created with platform adapter
SELECT id, name, adapter_type FROM agents;

# Check issue was created
SELECT id, title, assignee_agent_id FROM issues;

# Exit
\q
```

**Expected:**
- ✅ 1 company record
- ✅ 1 agent with `adapter_type = 'platform'`
- ✅ 1 issue assigned to agent

---

## 6. Verify API Endpoints

```bash
# Get all agents
curl http://localhost:3100/api/agents

# Get all issues
curl http://localhost:3100/api/issues

# Get agent details
curl http://localhost:3100/api/agents/{agentId}

# Get LLM providers
curl http://localhost:3100/api/llm-providers
```

**Expected:** All return 200 with data

---

## 7. Check Frontend (No Errors)

Open browser DevTools (F12):

**Console Tab:**
- ✅ No red errors
- ✅ No 404s
- ✅ React warnings OK (yellow)

**Network Tab:**
- ✅ All API calls 200/201
- ✅ No 500 errors
- ✅ HTML, CSS, JS all loaded

**Application Tab:**
- ✅ Session is stored
- ✅ React Query cache visible

---

## 8. Phase 0 Success Criteria

Check all boxes:

- [ ] Docker services healthy
- [ ] Bootstrap signup works (no loops)
- [ ] Onboarding 5-step flow completes
- [ ] LLM provider validation works (at least 1 provider)
- [ ] CEO agent created with platform adapter
- [ ] First task created and assigned
- [ ] Dashboard accessible
- [ ] Database records exist
- [ ] API endpoints responsive
- [ ] No console/network errors

---

## 9. If Something Fails

### "Port 3100 already in use"
```bash
docker-compose down --remove-orphans
docker-compose up -d
```

### "Database connection refused"
```bash
docker-compose logs db
# Wait 30 seconds and retry
```

### "Onboarding redirects to invite"
- F12 → Console → Check error
- Check server logs: `docker-compose logs app | tail -100`
- Known fix: Refresh browser

### "LLM validation returns 400"
- Verify API key is correct
- Check network tab for response body
- Try different provider (Ollama is always available locally)
- Check server logs: `docker-compose logs app | grep -i "llm"`

### "Database tables missing"
```bash
docker-compose logs app | grep -i "migration"
# Check if migrations ran during startup
```

---

## 10. Once All Tests Pass ✅

Proceed to **Phase 1**:
1. Full LLM integration (executor implementation)
2. Zeroclaw UI pages (7 pages)
3. Workflow engine (Sim executor)
4. Visual canvas (@xyflow/react)

---

## Quick Command Reference

```bash
# Check all services
docker-compose ps

# View app logs
docker-compose logs app

# View database logs
docker-compose logs db

# Restart everything
docker-compose restart

# Full reset
docker-compose down --remove-orphans && docker-compose up -d

# Database shell
docker exec paperclip-v2-db psql -U paperclip -d paperclip

# API health check
curl http://localhost:3100/api/health

# Check migrations
docker-compose logs app | grep -i "migration\|pending"
```

---

## Test Summary Template

When done, copy/paste and fill in:

```
✅ Phase 0 Complete!

Docker Build: [SUCCESS / FAILED]
Bootstrap Flow: [WORKING / BROKEN - REASON: ___]
Onboarding Steps 1-5: [COMPLETE / INCOMPLETE - STOPPED AT STEP ___]
LLM Provider: [WORKING - PROVIDER: ___ / FAILED]
Agent Created: [YES / NO]
Database State: [CORRECT / WRONG]
API Endpoints: [ALL 200 / SOME FAILING]
Frontend: [NO ERRORS / ERRORS: ___]
Dashboard: [LOADS / 404]

Overall: [PHASE 0 COMPLETE] or [BLOCKED ON: ___]

Time to Complete Phase 0: ___ minutes
```

---

**Ready to test? Watch this file for updates as we proceed.** 🚀
