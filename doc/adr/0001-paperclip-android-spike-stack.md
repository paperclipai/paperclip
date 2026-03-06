# ADR 0001: Android Spike Stack Selection

## Status

Accepted (for V0 spike on March 5, 2026)

## Context

We need a fast Android client spike for Paperclip that can:

- Run on emulator and real Android device
- Reuse existing TypeScript experience from the Paperclip stack
- Authenticate to existing Paperclip API
- Deliver a working read-only issue inbox quickly

Alternatives considered:

1. Expo React Native
2. Bare React Native CLI
3. Kotlin native app
4. Flutter

## Decision

Use **Expo React Native (TypeScript)** for the initial Android spike.

## Rationale

- **Fastest setup**: project scaffolding and runtime tooling in minutes.
- **TypeScript alignment**: matches current team stack and lowers context-switch.
- **Device coverage**: works on emulator and physical Android through Expo Go.
- **Future path**: can be ejected/prebuilt later if native modules become necessary.

## Trade-offs

- Not fully native-first: Expo adds abstraction and dependency on Expo runtime.
- Auth/token handling in this spike is intentionally simple and not production-grade.
- Some advanced native integrations may later require prebuild/eject decisions.

## Consequences

- We can iterate quickly on workflow screens (inbox, issue detail, approvals).
- Next milestone should define production auth (device-bound token lifecycle) before write actions are added.
