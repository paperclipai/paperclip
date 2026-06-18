# Meeting Analysis Workflow Design (ROC-2825)

## Objective
Ingest meeting recordings/notes, extract actionable signals, and file them as board tickets.

## Pipeline
1. **Ingest**: Use a polling mechanism to watch a designated directory (or simulate with a manual trigger for now).
2. **Transcribe**: Leverage local `whisper` model.
3. **Analyze**: Use local LLM (Qwen2.5-Coder-32B via RunPod/vLLM) to extract signals.
4. **Triage**: Use the existing `signal-scanner` logic (or a new scanner) to upsert signals to Paperclip API.
5. **Human-in-the-loop**: For high-impact signals, route through a confirmation step before filing.

## Implementation Steps
1. Create a `meeting-scanner.py` that interfaces with the local transcription tool.
2. Define the Signal schema for meeting analysis.
3. Integrate with the existing `signal-scanner` workflow for board filing.
4. Add a CLI tool for Ivan to approve/reject extracted signals.

## Next Steps
- Verify if `whisper` is installed locally.
- Draft `meeting-scanner.py`.
