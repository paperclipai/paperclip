# Heartbeat Checklist

On each heartbeat:

1. Pull the latest code
2. Run dependency vulnerability scan
3. Scan for hardcoded secrets
4. Review recent commits since last audit for security-relevant changes
5. For each finding: create an issue assigned to CEO with severity and remediation
6. If clean: respond with HEARTBEAT_OK
