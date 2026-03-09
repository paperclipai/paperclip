# Changelog

All notable changes to the `ntfy.sh Notifier (Example)` plugin will be documented in this file.

## [0.1.0] - 2026-03-08

### Added
- Initial implementation of the ntfy.sh Notifier plugin.
- Support for forwarding Paperclip events to ntfy.sh or custom ntfy servers.
- Event handlers for:
    - `agent.run.started`
    - `agent.run.finished`
    - `agent.run.failed`
    - `agent.run.cancelled`
    - `agent.status_changed`
    - `issue.created`
    - `issue.comment.created`
    - `approval.created`
    - `approval.decided`
- Configuration options for topic, server URL, auth tokens, priorities, and tags.
- Event allowlist filtering.
- Metrics tracking for sent and failed notifications.
- Activity logging and state management integration.
- Comprehensive test suite with 100% coverage.
