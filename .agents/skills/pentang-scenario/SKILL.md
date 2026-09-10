---
name: pentang-scenario
description: Use when turning a pentang manual or exploratory flow into a stable deterministic scenario and regression test.
---

# pentang scenario design

Start with the smallest observable path: initialize, inspect backend identity, execute the known transform, run self-test, dispose, and reinitialize. Prefer stable DOM IDs and exact result data over coordinates or screenshots. Keep native IPC logs, JavaScript exceptions, and device screenshots as supporting evidence.

Classify each scenario as one of these layers:

- `tests/api` for protocol, validation, error, and lifecycle behavior.
- `tests/tauri` for packaged desktop WebView and native IPC behavior.
- `docs/verification` for browser delivery, headers, and release-like Web UI behavior.
- device scripts for Android/iOS flows that require OS or hardware facilities.

Exploration may use UI automation to discover selectors or failure states. Once a path is stable, encode it with deterministic assertions and keep the exploratory trace separate. Do not put an LLM or image-recognition loop in a regression test. If a step really needs a human, record the prerequisite and stop with `BLOCKED`; do not pretend that a partial screen observation passed.
