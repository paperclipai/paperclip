# iOS Video Timeline Guild

An example AgentVault Guild that implements a **scrolling video timeline** (think
TikTok-style vertical feed) for iOS. It demonstrates:

- Correct **SwiftUI cell reuse** with `LazyVStack` and stable identifiers.
- **AVPlayer pool** management to prevent white bars, memory pressure, and audio
  session conflicts.
- **App Store privacy** compliance with a complete `PrivacyInfo.xcprivacy`.

---

## Guild Structure

```
ios-video-timeline/
├── agent.json             # Guild orchestrator (loads iOS skills, defines quality gates)
├── ios-coder.json         # Generates SwiftUI + AVFoundation code
├── ios-tester.json        # Writes XCTest/XCUITest; runs iOS Quality Gate
├── privacy-guardian.json  # Audits PrivacyInfo.xcprivacy and privacy policy
└── README.md              # This file
```

---

## Prerequisites

1. **AgentVault CLI** installed (`npm install -g agentvault` or local dev build).
2. **iOS skills** present at `skills/ios/` (run `agentvault skills update --ios` if missing).
3. An `ANTHROPIC_API_KEY` environment variable (used by all three Claude-powered agents).

---

## Quickstart

```bash
# From the AgentVault project root
cd examples/agents/ios-video-timeline

# Spin up the full guild and run through all three agents
agentvault exec agent.json \
  --task "Build a vertical scrolling video feed with 50+ clips.
          Each cell shows a thumbnail, title, and inline AVPlayer.
          Target iOS 16+. Use SwiftUI." \
  --json
```

Or spin up individual agents:

```bash
# Only the coder
agentvault exec ios-coder.json --task "Implement VideoFeedView.swift" --json

# Only the privacy reviewer
agentvault exec privacy-guardian.json \
  --task "Audit the generated code and produce PrivacyInfo.xcprivacy" \
  --json
```

---

## iOS Quality Gate

The tester agent validates every code-generation run against four gates:

| Gate | Checks |
|------|--------|
| `cell-reuse` | `LazyVStack`/`List` only; stable IDs; no blocking body; `.task(id:)` |
| `avplayer-reuse` | Player pool; `replaceCurrentItem`; layer hidden until ready |
| `memory-profile` | `[weak self]`; bounded pool; `.task(id:)` cancellation |
| `privacy-flags` | `PrivacyInfo.xcprivacy`; correct `NSPrivacyTracking`; all types declared |

**Pass threshold:** ≥ 85 % of checks must pass on the first generation attempt.

---

## Skills Used

| Skill file | Purpose |
|---|---|
| `skills/ios/SwiftUI-CellReuse.md` | LazyVStack, stable IDs, `.task(id:)` |
| `skills/ios/AVPlayer-BestPractices.md` | Player pool, white-bar fix |
| `skills/ios/PrivacyPolicy-Template.md` | PrivacyInfo.xcprivacy, NSPrivacyCollectedDataTypes |
| `skills/ios/Xcode-Project-Structure.md` | Feature folder layout, SPM, schemes |

Update skills at any time:

```bash
agentvault skills update --ios
```

---

## Sample Output

The coder agent produces files like:

```
Features/Feed/
├── FeedView.swift          # LazyVStack with VideoCell
├── VideoCell.swift         # Checks out AVPlayer from pool on appear
├── FeedViewModel.swift     # Owns the VideoClip array; drives pagination
└── AVPlayerPool.swift      # Actor-based bounded player pool (capacity: 5)

Supporting Files/
└── PrivacyInfo.xcprivacy   # Generated/validated by privacy-guardian
```

---

## Adapting This Guild

1. Copy the four JSON files into your own project.
2. Edit `agent.json` to point `skillsPath` at your local `skills/ios/` copy.
3. Adjust `systemPrompt` in each agent JSON to reflect your app's specific
   requirements (minimum iOS version, architecture pattern, etc.).
4. Run `agentvault exec agent.json --task "..."`.
