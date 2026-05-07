FROM node:lts-alpine
RUN npm install -g @anthropic-ai/claude-code@latest
# Force unbuffered output so the auth URL and token appear in Railway logs immediately
ENV NODE_NO_WARNINGS=1
CMD ["claude", "setup-token"]
