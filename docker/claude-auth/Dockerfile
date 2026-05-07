FROM node:lts-alpine
RUN npm install -g @anthropic-ai/claude-code@latest
COPY run.sh /run.sh
RUN chmod +x /run.sh
# Unbuffered so every line appears in Railway logs immediately
ENV NODE_NO_WARNINGS=1 PYTHONUNBUFFERED=1
CMD ["/bin/sh", "-c", "exec /run.sh"]
