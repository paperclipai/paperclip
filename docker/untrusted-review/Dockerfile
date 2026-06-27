ARG HERMES_AGENT_IMAGE=nousresearch/hermes-agent:v2026.6.19
FROM ${HERMES_AGENT_IMAGE} AS hermes_runtime

FROM node:lts-trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    fd-find \
    gh \
    git \
    jq \
    less \
    openssh-client \
    procps \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd

RUN corepack enable \
  && npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest

RUN useradd --create-home --shell /bin/bash reviewer

# Hermes runtime from pinned image
COPY --from=hermes_runtime /opt/hermes /opt/hermes
COPY --from=hermes_runtime /usr/local/bin/uv /usr/local/bin/uv
COPY --from=hermes_runtime /usr/local/bin/uvx /usr/local/bin/uvx
RUN ln -s /opt/hermes/.venv/bin/hermes /usr/local/bin/hermes \
  && ln -s /opt/hermes/.venv/bin/hermes-agent /usr/local/bin/hermes-agent \
  && ln -s /opt/hermes/.venv/bin/hermes-acp /usr/local/bin/hermes-acp \
  && mkdir -p /home/reviewer/.hermes \
  && chown -R reviewer:reviewer /opt/hermes /home/reviewer/.hermes \
  && hermes --version

ENV HOME=/home/reviewer \
  CODEX_HOME=/home/reviewer/.codex \
  CLAUDE_HOME=/home/reviewer/.claude \
  HERMES_HOME=/home/reviewer/.hermes \
  PAPERCLIP_HOME=/home/reviewer/.paperclip-review \
  PNPM_HOME=/home/reviewer/.local/share/pnpm \
  PATH=/home/reviewer/.local/share/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /work

COPY --chown=reviewer:reviewer docker/untrusted-review/bin/review-checkout-pr /usr/local/bin/review-checkout-pr

RUN chmod +x /usr/local/bin/review-checkout-pr \
  && mkdir -p /work \
  && chown -R reviewer:reviewer /work

USER reviewer

EXPOSE 3100 5173

CMD ["bash", "-l"]
