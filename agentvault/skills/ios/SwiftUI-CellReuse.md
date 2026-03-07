# SwiftUI Cell Reuse Patterns

**Skill ID:** `swiftui-cell-reuse`
**Version:** 1.0.0
**Quality Gates:** `cell-reuse`, `memory-profile`

---

## Overview

SwiftUI does not have a UIKit-style `dequeueReusableCell` API, but it achieves
efficient view recycling automatically inside `List` and `LazyVStack`. The key
rule is: **let SwiftUI's diffing engine decide what to update, and keep cell
views cheap to initialise**.

---

## Rules

### 1. Always use `List` or `LazyVStack` for scrolling collections

```swift
// GOOD — lazy initialisation; off-screen views are discarded
List(items) { item in
    ItemRow(item: item)
}

LazyVStack(spacing: 8) {
    ForEach(items) { item in
        ItemRow(item: item)
    }
}

// BAD — every view is initialised immediately, regardless of visibility
VStack {
    ForEach(items) { item in
        ItemRow(item: item)
    }
}
```

### 2. Provide stable, unique identifiers

SwiftUI uses `id` to decide whether to reuse or recreate a view.

```swift
// GOOD — stable UUID from the model
struct VideoClip: Identifiable {
    let id: UUID        // assigned once at creation, never changed
    var title: String
    var thumbnailURL: URL
}

// BAD — positional index as id causes full re-render on insertion/deletion
ForEach(0..<items.count, id: \.self) { i in
    ItemRow(item: items[i])
}
```

### 3. Keep cell initialisers free of side effects

Cell views are initialised (and potentially discarded) many times during
scrolling. Heavy work must live in the view model, not in `init` or `body`.

```swift
// GOOD — async work triggered after appear
struct ThumbnailCell: View {
    let clip: VideoClip
    @State private var image: Image?

    var body: some View {
        ZStack {
            if let image { image.resizable().aspectRatio(contentMode: .fill) }
            else { Color.secondary.opacity(0.2) }
        }
        .task(id: clip.id) {         // cancels automatically when cell leaves screen
            image = await ImageCache.shared.thumbnail(for: clip.thumbnailURL)
        }
    }
}

// BAD — synchronous heavy work in body
struct ThumbnailCell: View {
    let clip: VideoClip
    var body: some View {
        let image = UIImage(contentsOfFile: clip.thumbnailURL.path) // blocks main thread
        Image(uiImage: image ?? UIImage())
    }
}
```

### 4. Use `.task(id:)` for per-cell async work

`.task(id:)` is automatically cancelled when the cell scrolls off screen,
preventing stale updates and memory pressure from dangling tasks.

```swift
.task(id: clip.id) {
    await viewModel.loadThumbnail(for: clip)
}
```

### 5. Avoid `@StateObject` inside cells that scroll

`@StateObject` owns its object for the lifetime of the **view identity**. Inside
a `List` this can cause unexpected retention if the stable id changes.

```swift
// GOOD — lift state into the parent view model or use @ObservedObject
struct ItemRow: View {
    @ObservedObject var vm: ItemViewModel   // parent owns the lifetime
    ...
}

// RISKY inside a List — object lives until SwiftUI discards the identity
struct ItemRow: View {
    @StateObject private var vm = ItemViewModel()
    ...
}
```

### 6. Prefer value types (`struct`) for cell data

Structs produce cheap copies and enable precise diffing without pointer
equality checks.

```swift
// GOOD
struct VideoClip: Identifiable, Equatable { ... }

// In cell
struct VideoCell: View {
    let clip: VideoClip   // value copy; SwiftUI skips redraw when Equatable unchanged
    ...
}
```

Mark data models `Equatable` so `.equatable()` modifier or `@Binding` diffing
can short-circuit unnecessary redraws.

---

## Quality Gate: `cell-reuse`

An automated check validates that generated scroll/list code satisfies:

| Check | Pass Condition |
|-------|---------------|
| Uses `List` or `LazyVStack` | At least one lazy container wraps `ForEach` |
| Stable IDs | `ForEach` uses model `.id`, not `\.self` on index |
| No blocking `body` calls | No `UIImage(contentsOfFile:)` or `Data(contentsOf:)` in `body` |
| `.task(id:)` for async | Per-cell async uses `.task(id:)` not `.onAppear` |

---

## Quality Gate: `memory-profile`

| Check | Pass Condition |
|-------|---------------|
| No retain cycles | Closures capturing `self` use `[weak self]` |
| No `@StateObject` in scrolling cells | `@ObservedObject` or plain `let` only |
| Task cancellation | All `Task {}` in cells anchored to `.task(id:)` lifecycle |

---

## References

- [Apple Docs – List](https://developer.apple.com/documentation/swiftui/list)
- [Apple Docs – LazyVStack](https://developer.apple.com/documentation/swiftui/lazyvstack)
- [WWDC22 – SwiftUI Performance](https://developer.apple.com/videos/play/wwdc2022/10062/)
- [WWDC23 – Demystify SwiftUI Performance](https://developer.apple.com/videos/play/wwdc2023/10160/)
