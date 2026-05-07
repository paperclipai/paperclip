# syntax=docker/dockerfile:1.20
FROM node:lts-alpine
RUN npm install -g @anthropic-ai/claude-code@latest
RUN apk add --no-cache expect

# Pre-seed Claude config so the first-run theme wizard is skipped entirely
RUN mkdir -p /root/.claude && printf '{"theme":"dark","mode":"dark"}\n' > /root/.claude/settings.json

COPY <<'EXPECTSCRIPT' /auth.exp
#!/usr/bin/expect -f
set timeout 300
log_user 1

# Skip any remaining prompts by pressing Enter, then wait for the auth URL
spawn claude login

expect {
    -re {https://claude\.ai/[^\r\n]+} {
        puts "\n\n=========================================="
        puts "OPEN THIS URL IN YOUR BROWSER:"
        puts $expect_out(0,string)
        puts "==========================================\n"
        exp_continue
    }
    -re {Press Enter|press enter|continue} {
        send "\r"
        exp_continue
    }
    -re {>\s*[0-9]} {
        send "\r"
        exp_continue
    }
    "Logged in" { puts "LOGIN OK — running setup-token" }
    "successfully" { puts "LOGIN OK — running setup-token" }
    timeout { puts "TIMED OUT"; exit 1 }
    eof { puts "--- login ended ---" }
}

spawn claude setup-token

expect {
    -re {sk-ant-[^\r\n]+} {
        puts "\n\n=========================================="
        puts "CLAUDE_CODE_OAUTH_TOKEN:"
        puts $expect_out(0,string)
        puts "==========================================\n"
        exp_continue
    }
    -re {Press Enter|press enter} {
        send "\r"
        exp_continue
    }
    timeout { puts "setup-token timed out" }
    eof {}
}

puts "=== Done. Delete this Railway service. ==="
EXPECTSCRIPT

COPY <<'ENTRYPOINT' /run.sh
#!/bin/sh
node -e "require('http').createServer((_,r)=>r.end('ok')).listen(process.env.PORT||3000)" &
exec expect /auth.exp
ENTRYPOINT

RUN chmod +x /run.sh /auth.exp
ENV NODE_NO_WARNINGS=1 TERM=xterm-256color
CMD ["/run.sh"]
