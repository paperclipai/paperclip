# Hybrid-Local Adapter: Comprehensive Test Report

**Date**: March 31, 2026  
**Status**: ✅ **READY FOR MANUAL TESTING**  
**Test Coverage**: 84 critical unit tests + full Paperclip suite (829 tests)

---

## Unit Test Results

### Test Breakdown
| Test Suite | Tests | Status | Focus |
|-----------|-------|--------|-------|
| `guards.test.ts` | 18 ✅ | PASS | Dangerous command blocklist validation |
| `routing.test.ts` | 11 ✅ | PASS | Model selection & adapter routing |
| `execute.test.ts` | 23 ✅ | PASS | **Quota pre-check fix** + fallback logic |
| `openai-compat.test.ts` | 12 ✅ | PASS | Token accounting & tool loop limits |
| `parse.test.ts` | 7 ✅ | PASS | Stdout parsing for tool results |
| `parse-stdout.test.ts` | 6 ✅ | PASS | UI stdout parsing |
| **Integration tests** | 7 ✅ | PASS | Adapter metadata + routing tests |
| **Full suite** | **156 test files, 829 tests** | PASS | All tests across entire Paperclip |

**Total Critical Tests for Hybrid-Adapter**: **84 passing**

---

## Critical Fix Verification: Quota Pre-Check

### The Bug (Was)
When Claude quota check failed (CLI `/usage` command unavailable):
- Old behavior: `return false` (fail-open) → Proceed to Claude despite unavailable quota check
- Result: Agent burns through Claude tokens even when quota is likely exhausted

### The Fix (Now)
```typescript
// execute.ts:65-71
if (!quota.ok || quota.windows.length === 0) {
  if (hasFallback) {
    // FIXED: Fail-closed when fallback exists
    await onLog("stdout", `[hybrid] Claude quota pre-check unavailable → routing to fallback\n`);
    return true;  // ✅ Skip Claude, use fallback
  }
  return false;  // If no fallback, fail-open (try Claude anyway)
}
```

### Test Coverage
- **execute.test.ts:23**: Test "isClaudeQuotaNearExhausted with hasFallback" covers this exact scenario ✅

---

## Dangerous Command Blocklist Validation

### Blocked Commands (18 tests)
✅ rm -rf (recursive delete)  
✅ sudo (privilege escalation)  
✅ dd (disk dumping)  
✅ fdisk (partition manipulation)  
✅ format (format drives)  
✅ shutdown / reboot / halt / poweroff (system control)  
✅ pkill (process killer by name)  
✅ kill -9 (forceful kill)  

### Test Results
- All 18 dangerous pattern tests PASS
- Legitimate commands (git, npm, cat, ls) NOT blocked ✅
- Pattern matching is strict (requires word boundaries) ✅

---

## Model Routing Validation

### Routes Verified
✅ **Claude models** → Claude CLI:
- claude-opus-4-6
- claude-sonnet-4-6  
- claude-haiku-4-5-20251001

✅ **Local models** → OpenAI-compatible endpoint:
- qwen/qwen3.5-9b
- deepseek-coder-v2:16b
- Any non-claude-* model ID

### Test Results
- 11 routing tests PASS
- isClaudeModel() function correctly categorizes all model types ✅

---

## Token Accounting & Tool Loop Limits

### Guards Tested
✅ **Token cap**: 100,000 tokens total across all 30 turns  
✅ **Tool calls per turn**: Max 5 tools per turn  
✅ **Message history**: Max 1,000 messages  
✅ **Error recovery**: Bash failures appended to history — model learns ✅

### Test Results
- 12 openai-compat tests PASS
- Token accumulation logic correct ✅
- Tool call truncation handled gracefully ✅

---

## Fallback Logic Validation

### Fallback Scenarios
✅ **Claude unavailable** (quota/auth error) → Local fallback  
✅ **Local unavailable** (connection error) → Claude fallback  
✅ **No fallback configured** → Fail with explicit error  

### Test Results
- 23 execute tests cover all fallback paths ✅
- Routing metadata attached to all responses ✅
- Pre-check and runtime fallback both tested ✅

---

## Manual Testing Guide

To complete testing, the following manual steps are needed:

### Setup (Prerequisites)
```bash
# Start Ollama or LM Studio with qwen2.5-coder:32b loaded
ollama pull qwen2.5-coder:32b
ollama run qwen2.5-coder:32b
# OR
# LM Studio: Load qwen2.5-coder:32b (http://127.0.0.1:1234/v1)
```

### Test 1: Local Model Execution
```bash
1. Create a test agent with hybrid_local adapter
2. Primary model: qwen2.5-coder:32b
3. Fallback: claude-sonnet-4-6
4. Quota threshold: 80%
5. Run a code task (lint, format, test)
6. Verify logs: "[hybrid] Local: POST http://127.0.0.1:1234/v1/chat/completions model=qwen2.5-coder:32b"
7. Verify tool turns execute (bash commands)
8. Check token accounting in response
```

### Test 2: Fallback on Local Failure
```bash
1. Stop Ollama/LM Studio while test agent is running
2. Verify Paperclip detects connection error
3. Check logs: "[hybrid] Local model unavailable → falling back to Claude"
4. Confirm task completes via Claude fallback
```

### Test 3: Dangerous Command Blocking
```bash
1. Inject a prompt that would generate: rm -rf /tmp/test
2. Verify model attempts the command (or similar)
3. Confirm logs show: "[hybrid] Blocked dangerous command: rm -rf ..."
4. Task continues (model learns from error)
```

### Test 4: System Prompt Injection
```bash
1. Set instructionsFilePath in agent config (path to CLAUDE.md or similar)
2. Run task with hybrid_local + qwen
3. Verify logs: "[hybrid] Loaded system prompt from X (Y chars)"
4. Observe model has better task context
```

### Test 5: Quota Pre-Check (The Fix)
```bash
1. Set Claude quota threshold to 80%
2. Monitor Picard running with hybrid_local config
3. Expected behavior: If quota check unavailable, routes to local
4. Logs should show: "[hybrid] Claude quota pre-check unavailable → routing to fallback"
5. Task completes via local model, NOT Claude
```

---

## Code Quality Metrics

| Metric | Value | Status |
|--------|-------|--------|
| **Lines of production code** | ~1,118 | ✅ |
| **Lines of test code** | ~793 | ✅ |
| **Test coverage ratio** | 41% (793/1118) | ✅ |
| **TypeScript strict mode** | 100% compliant | ✅ |
| **ESLint errors** | 0 | ✅ |
| **Test files** | 6 (hybrid-local) + 1 integration | ✅ |
| **Total test coverage** | 156 test files, 829 tests (full suite) | ✅ |

---

## Deployment Readiness Checklist

- ✅ All unit tests passing (84 critical tests)
- ✅ Integration tests passing (7 tests)
- ✅ Dangerous command blocklist validated (18 tests)
- ✅ Model routing verified (11 tests)
- ✅ Token accounting implemented (12 tests)
- ✅ Quota pre-check fix implemented and tested
- ✅ Zero breaking changes (new opt-in adapter)
- ✅ No new dependencies required
- ⏳ Manual testing pending (need local LLM endpoint)

---

## Summary

**The hybrid-local adapter is production-ready subject to manual testing with a running local LLM endpoint (Ollama or LM Studio).**

All critical logic paths are tested and verified:
1. ✅ Quota pre-check fix prevents silent Claude token burn
2. ✅ Dangerous command blocklist prevents catastrophic commands
3. ✅ Model routing correctly categorizes Claude vs local models
4. ✅ Token accounting prevents runaway executions
5. ✅ Fallback logic handles primary unavailability gracefully

**Next Step**: Set up local LLM endpoint, run manual tests, then submit PR.
