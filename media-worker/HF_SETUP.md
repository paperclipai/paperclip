# Hugging Face Space Setup

Use this folder for the media service test.

## Files to place in the Space root

- app.py
- requirements.txt
- Dockerfile.hf as Dockerfile

## Space settings

- SDK: Docker
- Port: 7860

## First test

Open:

/health

Expected:

ok true

## Create test

POST to:

/create

Body:

{
  "topic": "SINK DINK India test",
  "tone": "respectful Hinglish",
  "durationSec": 25
}

## Result

The first version creates text files only. Real video render will be added after deployment test passes.
