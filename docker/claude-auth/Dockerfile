# syntax=docker/dockerfile:1.20
FROM node:lts-alpine
RUN npm install -g @anthropic-ai/claude-code@latest
RUN apk add --no-cache expect

COPY <<'ENTRYPOINT' /run.sh
#!/bin/sh
node -e "require('http').createServer((_,r)=>r.end('ok')).listen(process.env.PORT||3000)" &
exec expect /auth.exp
ENTRYPOINT

COPY <<'EXPECTSCRIPT' /auth.exp
#!/usr/bin/expect -f
set timeout 300

log_user 1

spawn claude login

# Step through the first-run theme wizard
expect {
    -re {[1-9]\.\s*(Auto|Dark|Light)} {
        send "2\r"
        exp_continue
    }
    -re {https://[^\r\n]+} {
        set url $expect_out(0,string)
        puts "\n\n=========================================="
        puts "OPEN THIS URL IN YOUR BROWSER:"
        puts $url
        puts "==========================================\n"
        exp_continue
    }
    "Logged in" {
        puts "\n\n=== LOGIN SUCCESSFUL - now running setup-token ==="
    }
    "successfully" {
        puts "\n\n=== LOGIN SUCCESSFUL - now running setup-token ==="
    }
    timeout {
        puts "TIMED OUT"
        exit 1
    }
    eof {
        puts "Process ended - check above for URL"
    }
}

# Now mint the long-lived token
spawn claude setup-token

expect {
    -re {sk-ant-[^\r\n]+} {
        set token $expect_out(0,string)
        puts "\n\n=========================================="
        puts "YOUR CLAUDE_CODE_OAUTH_TOKEN:"
        puts $token
        puts "Set this in Railway as CLAUDE_CODE_OAUTH_TOKEN"
        puts "==========================================\n"
        exp_continue
    }
    timeout {
        puts "setup-token timed out"
    }
    eof {}
}

puts "=== Done. Delete this Railway service now. ==="
EXPECTSCRIPT

RUN chmod +x /run.sh /auth.exp
ENV NODE_NO_WARNINGS=1 TERM=xterm-256color
CMD ["/run.sh"]
