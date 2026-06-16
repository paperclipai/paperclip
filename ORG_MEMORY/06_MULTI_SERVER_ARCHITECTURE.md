# Multi-Server Architecture

## Reason
Paperclip should not run dashboard, agents, Gemini, live polling, and video rendering on one Render instance.

The previous media render test showed that heavy rendering can cause 502/503 server errors. The correct path is to split the system.

## Server Roles

### Render
Role: Paperclip control room.

Runs:
- dashboard
- CEO command center
- agents
- tasks
- approval gate
- Gemini bridge
- remote worker connector

Does not run:
- heavy video rendering
- long ffmpeg jobs
- bulk generation

### Hugging Face Spaces Docker
Role: media factory.

Runs:
- ffmpeg
- voiceover generation
- MP4 creation
- cover creation
- output pack ZIP creation

Endpoints:
- /health
- /create-reel
- /job-status/{jobId}
- /files/{jobId}/{fileName}

### GitHub
Role: permanent brain and source of truth.

Stores:
- code
- brand bible
- SOP
- workflows
- memory notes
- learning history
- prompt versions

### Supabase Later
Role: live operational database.

Stores:
- job queue
- task status
- output metadata
- analytics
- logs

### GitHub Actions
Role: backup batch worker.

Runs:
- bulk rendering
- scheduled generation
- artifact creation

## Correct Flow
Paperclip -> Remote Media Worker -> Output Links -> Paperclip Task -> Human Approval -> GitHub Memory.

## Environment Variables
Paperclip should support:

- MEDIA_WORKER_URL
- MEDIA_WORKER_TOKEN
- PAPERCLIP_MEDIA_RENDER_MODE=remote

## First Target
Move media output from Render local ffmpeg to Hugging Face Spaces Docker worker.
