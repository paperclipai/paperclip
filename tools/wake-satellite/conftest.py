import os
import sys

# Geteilte voice-echo-bot-Module (jarvis_brain, tts, transcribe, config, …)
# in Tests importierbar machen.
_VCO = os.path.join(os.path.dirname(__file__), "..", "voice-echo-bot")
sys.path.insert(0, os.path.abspath(_VCO))
