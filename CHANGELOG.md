# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- Platform-wide agent burn guard (`feat/myhive-board`): token budget policies auto-armed on company/agent create, per-run token ceiling and turn floor, anti-loop circuit breaker (wake-rate + consecutive same-issue detector), Guardrails settings UI, and 8 embedded-postgres tests proving each guard trips correctly.
