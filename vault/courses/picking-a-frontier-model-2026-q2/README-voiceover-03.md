# Chapter 3 Voiceover Status

## ✅ Deliverable Complete

**File**: `voiceover-03.md` (this directory)  
**Word count**: 425 words  
**Estimated duration**: ~90–110 seconds @ natural speaking pace  
**Voice preset**: nova-warm (Academy brand standard)  
**Status**: Ready for synthesis

## Content Summary

- **Topic**: Long-context behavior — advertised vs effective context windows
- **Key coverage**: 
  - Retrieval effective limit vs synthesis effective limit
  - Three failure modes (lost needles, hallucinated synthesis, degraded reasoning)
  - RAG vs full-context tradeoff
- **Contrarian angle**: "A 1M-token context is not the same as a 1M-token working memory" + "RAG often outperforms full-context on synthesis tasks, both cheaper and more accurate"

## 🚫 Blocker: Audio Synthesis

Neither primary nor fallback synthesis tool is available in the environment:

- **Kokoro**: Install failed (Python 3.9 dependency conflict with `thinc<8.4.0`)
- **OmniVoice**: Not installed; requires CLI setup

## Next Steps

### Option 1: Install Kokoro (Preferred)
Requires resolving Python environment conflicts. Current blocker: `thinc>=8.3.12,<8.4.0` not available for Python 3.9.
- Consider upgrading Python to 3.11+
- Or use virtual environment with compatible Python version

### Option 2: Install OmniVoice
- Premium fallback (Apache 2.0, March 2026)
- Supports 600+ languages, 40× realtime
- Cost: ~$0.01–0.05 per voiceover
- Setup: Requires CLI installation + API credentials

### Option 3: Use macOS Built-in TTS
Quick alternative for testing; lower production quality:
```bash
say -f voiceover-03.md -o voiceover-03.aiff -v Nova
ffmpeg -i voiceover-03.aiff -q:a 9 -n voiceover-03.mp3
```

---

**Assigned to**: Voice Producer  
**Issue**: KOE-67  
**Last updated**: 2026-04-30 16:20 UTC
