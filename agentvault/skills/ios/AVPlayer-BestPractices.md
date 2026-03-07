# AVPlayer Lifecycle & Reuse Best Practices

**Skill ID:** `avplayer-best-practices`
**Version:** 1.0.0
**Quality Gates:** `avplayer-reuse`, `memory-profile`

---

## Overview

`AVPlayer` is expensive to create and teardown. In a scrolling video feed
(timeline, reel, story strip) you must **reuse** player instances rather than
creating a new one per cell. Failure to do so causes: excessive memory use,
audio session conflicts, dropped frames on scroll, and "white bar" artefacts
where the video layer is not yet sized.

---

## The White Bar Problem

A "white bar" typically appears when:
1. An `AVPlayerLayer` is attached to a cell before `readyToPlay` fires, leaving
   a blank/white rectangle.
2. The layer's `frame` is set before Auto Layout has run its final pass.
3. A new `AVPlayer` is allocated mid-scroll, and the first keyframe hasn't
   decoded yet.

**Fix:** wait for `.readyToPlay` KVO before revealing the player layer, and size
the layer in `layoutSubviews` / `viewDidLayoutSubviews`, not in `init`.

---

## Rules

### 1. Use a Player Pool

Never allocate `AVPlayer` inside a cell's `init` or SwiftUI view body.
Maintain a fixed-size pool (typically 3–5 players) and check-out/check-in
on scroll.

```swift
actor AVPlayerPool {
    static let shared = AVPlayerPool(capacity: 5)

    private let capacity: Int
    private var available: [AVPlayer] = []
    private var inUse: [ObjectIdentifier: AVPlayer] = [:]

    init(capacity: Int) {
        self.capacity = capacity
        available = (0..<capacity).map { _ in AVPlayer() }
    }

    func checkout(for owner: AnyObject) -> AVPlayer {
        let player: AVPlayer
        if let idle = available.popLast() {
            player = idle
        } else {
            // Evict least-recently-used or create a new one as fallback
            player = AVPlayer()
        }
        inUse[ObjectIdentifier(owner)] = player
        return player
    }

    func checkin(for owner: AnyObject) {
        let key = ObjectIdentifier(owner)
        guard let player = inUse.removeValue(forKey: key) else { return }
        player.pause()
        player.replaceCurrentItem(with: nil)  // release the item's resources
        available.append(player)
    }
}
```

### 2. Replace the Item, Not the Player

When a cell is reused, swap the `AVPlayerItem`, not the `AVPlayer`.

```swift
// GOOD — reconfigure the existing player
func configure(with url: URL) {
    let item = AVPlayerItem(url: url)
    player.replaceCurrentItem(with: item)
}

// BAD — creates a new player every time
func configure(with url: URL) {
    player = AVPlayer(url: url)          // leaks old player
    playerLayer.player = player
}
```

### 3. Observe `status` Before Showing the Layer

```swift
private var statusObservation: NSKeyValueObservation?

func attach(player: AVPlayer, to containerView: UIView) {
    playerLayer.player = player
    playerLayer.isHidden = true          // hide until ready

    statusObservation = player.currentItem?.observe(\.status) { [weak self] item, _ in
        guard let self else { return }
        if item.status == .readyToPlay {
            DispatchQueue.main.async {
                self.playerLayer.isHidden = false
            }
        }
    }
}
```

In SwiftUI, use `.onReceive` with a publisher:

```swift
.onReceive(player.publisher(for: \.timeControlStatus)) { status in
    isPlayerReady = (status == .playing || status == .paused)
}
```

### 4. Size the Layer in `layoutSubviews`

```swift
override func layoutSubviews() {
    super.layoutSubviews()
    playerLayer.frame = videoContainerView.bounds   // always up-to-date
}
```

For SwiftUI, use a `GeometryReader` or a `UIViewRepresentable` that overrides
`layoutSubviews` to set the frame.

### 5. Pause Players Not in Viewport

Use `UIScrollViewDelegate` or a scroll-position publisher to pause any player
that is more than one cell outside the visible rect.

```swift
func scrollViewDidScroll(_ scrollView: UIScrollView) {
    for (id, player) in activePlayers {
        let frame = frameForItem(id: id)
        let isVisible = scrollView.bounds.intersects(frame)
        if !isVisible { player.pause() }
    }
}
```

### 6. Tear Down Cleanly

Always cancel KVO and check the player back in on `prepareForReuse` or
SwiftUI `onDisappear`.

```swift
// UIKit
override func prepareForReuse() {
    super.prepareForReuse()
    statusObservation?.invalidate()
    statusObservation = nil
    if let player { AVPlayerPool.shared.checkin(for: self) }
    playerLayer.player = nil
    playerLayer.isHidden = true
}

// SwiftUI
.onDisappear {
    Task { await AVPlayerPool.shared.checkin(for: token) }
}
```

### 7. Audio Session

Configure the audio session once at app launch, not per player:

```swift
// AppDelegate / @main
try AVAudioSession.sharedInstance().setCategory(
    .playback,
    mode: .moviePlayback,
    options: [.mixWithOthers]            // or .duckOthers if you want focus
)
try AVAudioSession.sharedInstance().setActive(true)
```

### 8. Background Entitlement

Add `UIBackgroundModes: audio` to `Info.plist` only if continuous background
playback is a deliberate product feature — the App Store reviewer will check
that it is justified.

---

## Quality Gate: `avplayer-reuse`

| Check | Pass Condition |
|-------|---------------|
| No `AVPlayer(url:)` in cell body | Players are obtained from a pool or parent VM |
| `replaceCurrentItem` used for reuse | No `player = AVPlayer(...)` in configure methods |
| Layer hidden until ready | `playerLayer.isHidden = true` before `readyToPlay` |
| Layer frame set in layout pass | `playerLayer.frame` assigned in `layoutSubviews` or equivalent |
| `prepareForReuse` / `onDisappear` cleanup | KVO invalidated; player checked in |

---

## Quality Gate: `memory-profile`

| Check | Pass Condition |
|-------|---------------|
| No retain cycles | KVO observers stored as `NSKeyValueObservation` (auto-invalidated) |
| No strong capture of `self` in closures | `[weak self]` guard in all player callbacks |
| Player pool bounded | Pool capacity ≤ 8; no unbounded growth |

---

## References

- [Apple Docs – AVPlayer](https://developer.apple.com/documentation/avfoundation/avplayer)
- [Apple Docs – AVPlayerLayer](https://developer.apple.com/documentation/avfoundation/avplayerlayer)
- [WWDC 2019 – Delivering Intuitive Media Playback with AVKit](https://developer.apple.com/videos/play/wwdc2019/503/)
- [WWDC 2022 – Discover Metal enhancements for A15 Bionic](https://developer.apple.com/videos/play/wwdc2022/10103/)
- Technical Note TN2242 – Troubleshooting AVFoundation performance
