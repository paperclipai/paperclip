# Python Bridge Layout

This directory reserves the Python side of `paperclip-bench` for ecosystems and evaluator stacks that already expect Python entrypoints.

- `bridge/`: future wrappers around the TypeScript runner and evaluator APIs
- `evaluators/`: Python-native evaluator adapters when a benchmark ecosystem already ships there
- `datasets/`: dataset preparation helpers that are easier to keep in Python
