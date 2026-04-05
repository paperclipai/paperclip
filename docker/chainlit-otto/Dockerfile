# NUC-116: Chainlit Otto widget server
# Backend: `claude` CLI subprocess (Claude Max OAuth — no API billing)
#
# The `claude` CLI credentials must be mounted at runtime:
#   -v $HOME/.claude:/home/otto/.claude:ro
#
# Required env:
#   CHAINLIT_JWT_SECRET  — shared secret with Paperclip (set in .env)
#
# Optional env:
#   CHAINLIT_AUTH_SECRET — Chainlit's own session signing secret (generated if absent)

FROM python:3.12-slim

# Install system dependencies + Node.js (required by `claude` CLI)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install the `claude` CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create a non-root user for the app
RUN useradd -m -s /bin/bash otto
WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY app.py .
COPY .chainlit/ .chainlit/

# Switch to non-root user
USER otto

EXPOSE 8000

CMD ["chainlit", "run", "app.py", "--host", "0.0.0.0", "--port", "8000"]
