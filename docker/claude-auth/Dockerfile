# syntax=docker/dockerfile:1.20
FROM node:lts-alpine
RUN npm install -g @anthropic-ai/claude-code@latest

COPY <<'EOF' /run.sh
#!/bin/sh
node -e "require('http').createServer((_,r)=>r.end('ok')).listen(process.env.PORT||3000)" &

echo "=== claude version ==="
claude --version 2>&1
echo ""

echo "=== attempting claude login (will print auth URL) ==="
# Use script(1) to allocate a pseudo-TTY so claude doesn't bail in headless
script -q -c "claude login" /dev/null 2>&1
echo "exit: $?"
echo ""

echo "=== attempting claude setup-token ==="
script -q -c "claude setup-token" /dev/null 2>&1
echo "exit: $?"

echo "=== Done. Copy token above then delete this service ==="
sleep infinity
EOF

RUN chmod +x /run.sh
RUN apk add --no-cache util-linux
ENV NODE_NO_WARNINGS=1 TERM=xterm-256color
CMD ["/run.sh"]
