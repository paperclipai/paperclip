# MiniMax Local Test Probe Hotfix — 2026-06-12

The MiniMax Local adapter runtime was already verified by heartbeat canaries, but the UI Test button could fail when MiniMax-M3 returned a reasoning-only `<think>` response to the tiny `Reply with exactly: OK` probe.

This hotfix keeps credential and HTTP errors as failures, but treats a successful MiniMax HTTP completion as a passing environment test even when the probe text is not exactly `OK`.

Reason:
- The Test button is an environment and credential check.
- MiniMax-M3 may emit hidden-reasoning markup on tiny probes.
- Runtime heartbeat execution strips `<think>` blocks and was already proven with successful MiniMax Local runs.
