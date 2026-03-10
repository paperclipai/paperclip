FROM node:22-bookworm-slim

RUN apt-get update -qq &&     apt-get install -y -qq --no-install-recommends python3 python3-pip python3-venv ca-certificates curl git &&     rm -rf /var/lib/apt/lists/*

RUN npm install -g acpx

WORKDIR /app
RUN git clone --depth=1 https://github.com/NousResearch/hermes-agent.git /app/hermes-agent
RUN python3 -m pip install --break-system-packages --no-cache-dir /app/hermes-agent

ENV HOME=/home/node
RUN useradd -m -d /home/node -s /bin/bash node 2>/dev/null || true
USER node
WORKDIR /home/node
