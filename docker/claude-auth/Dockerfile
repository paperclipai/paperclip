# syntax=docker/dockerfile:1.20
FROM node:lts-alpine
RUN npm install -g @anthropic-ai/claude-code@latest

COPY <<'EOF' /run.sh
#!/bin/sh
# Satisfy Railway's health check so the service shows "Running" and logs appear
node -e "require('http').createServer((_,r)=>r.end('ok')).listen(process.env.PORT||3000,()=>console.log('health ok'))" &

echo "=== claude setup-token starting ==="
echo "=== Watch here for the auth URL, visit it in your browser ==="
echo ""
claude setup-token 2>&1
echo ""
echo "=== Done. Copy the token above then delete this Railway service ==="
sleep infinity
EOF

RUN chmod +x /run.sh
ENV NODE_NO_WARNINGS=1
CMD ["/run.sh"]
