# SINK DINK Media Worker

This worker is separate from the Paperclip control room.

## Purpose
Create media output files outside the main Render app so the dashboard stays stable.

## Routes

- GET /health
- POST /create
- GET /status/{jobId}
- GET /files/{jobId}/{fileName}

## First Deploy Target
Hugging Face Spaces Docker.

## First Test
Open:

/health

Expected:

ok true
