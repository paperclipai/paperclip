# Remote Media Worker Plan

Purpose: keep Paperclip as a control room and move media file creation to a second service.

## Why
The Render app should manage agents, tasks, approvals and result links. Heavy media jobs should not run inside the main Paperclip server.

## Worker Role
The worker creates the output files and returns links/status to Paperclip.

## Basic API
- GET /health
- POST /create
- GET /status/{jobId}
- GET /files/{jobId}/{fileName}

## Input
- topic
- tone
- duration
- brandRules
- mediaPack
- requestId

## Output
- jobId
- status
- files
- errorNote

## First Target
Use Hugging Face Spaces Docker for the worker.
