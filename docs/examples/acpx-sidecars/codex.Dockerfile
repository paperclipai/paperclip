FROM node:22-bookworm-slim

RUN apt-get update -qq &&     apt-get install -y -qq --no-install-recommends python3 ca-certificates curl git &&     rm -rf /var/lib/apt/lists/*

RUN npm install -g acpx @openai/codex

ENV HOME=/home/node
RUN useradd -m -d /home/node -s /bin/bash node 2>/dev/null || true
USER node
WORKDIR /home/node
