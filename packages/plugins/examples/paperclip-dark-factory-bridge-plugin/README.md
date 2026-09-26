# Paperclip Dark Factory Bridge Plugin POC

Mock Paperclip plugin example for displaying Dark Factory bridge/projection state.

This package is intentionally projection-only:

- It does not modify the Paperclip Task/Issue main model.
- It does not connect to a real Dark Factory runtime.
- It does not read, write, or store secrets/tokens.
- Its namespace database stores only projection/cache/cursor/receipt data.
- Dark Factory Journal remains the truth source.

UI surfaces must continue to show:

> Projection only — Dark Factory Journal remains truth source
