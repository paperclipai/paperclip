# Test-only image for M2 Task 26's end-to-end test on kind.
#
# Scope reduction: this image stands in for `paperclipai/agent-runtime-claude`
# during the integration test. It runs a busybox shell script that calls the
# fake Anthropic server (see fake-anthropic.ts) and echoes the response. This
# proves the FULL orchestrator + Job lifecycle + log streaming path without
# needing a real claude-code CLI.
#
# Real claude-code integration is covered by Task 26.5 / M3 follow-up.
FROM busybox:1.36

# busybox's wget supports https only when built with TLS — we POST plain HTTP
# to the host's fake server so this is fine.
COPY fake-agent.sh /usr/local/bin/paperclip-agent-shim
RUN chmod +x /usr/local/bin/paperclip-agent-shim

# Match the runAsNonRoot / runAsUser=1000 PSS Restricted constraints that
# buildBusyboxTestJob (and the real Job builder) enforce.
USER 1000:1000
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/paperclip-agent-shim"]
