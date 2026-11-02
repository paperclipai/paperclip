# Historical chat-adapter wireframes

All generated wireframe images and their HTML gallery are excluded from the PR.
The final 67 v8 SVGs and gallery remain recoverable in the
[pre-removal archive](https://github.com/paperclipai/paperclip/tree/63c8b5d8d0671d9f0676a8f4b0d0ac52d0353884/doc/plans/chat-adapters).
The 455 generated v1-v7 SVGs were removed earlier; their exact contents remain
available in the [pre-prune archive commit](https://github.com/paperclipai/paperclip/tree/1c4a45f0ef7d627aa98e4f3ae3116d4507386d1a/doc/plans/chat-adapters).
Written plans, implementation, tests, and production provider icons remain.

The superseded [v2 design note](https://github.com/paperclipai/paperclip/blob/e72a504800c0945993736574fb3cb3bf81dd5157/doc/plans/chat-adapters/2026-09-04-chat-adapters-ui-surfaces-v2.md), [v3 design note](https://github.com/paperclipai/paperclip/blob/9668530e14d42f715fa5778c5e14bfe0fed2a018/doc/plans/chat-adapters/2026-09-04-chat-adapters-ui-surfaces-v3.md) and [v4 design note](https://github.com/paperclipai/paperclip/blob/9668530e14d42f715fa5778c5e14bfe0fed2a018/doc/plans/chat-adapters/2026-09-04-chat-adapters-ui-surfaces-v4.md) are also archived in Git history. This retains their exact decisions while keeping the combined implementation and upstream compatibility fixes within the 500-file review limit. Current designs and live qualification records remain in the working tree; the historical regeneration inputs remain in the archive below.

The retained generators are an ordered chain, not standalone snapshot builders; in particular, the v8 generator reads v7 outputs. For historical regeneration, use a scratch checkout of the pre-prune archive commit above so all snapshot notes and outputs are present. Run `node generate-wireframes.mjs` for v1 independently; then run `node generate-wireframes-v2.mjs`, `node generate-provider-wireframes.mjs`, and `node generate-wireframes-v3.mjs` through `node generate-wireframes-v8.mjs` in numeric order. These scripts also overwrite viewer/specification files such as `index.html`, so do not run them in a working tree with documentation changes you intend to keep.

The superseded [v5 design note](https://github.com/paperclipai/paperclip/blob/c52e98c9be57683004040ce59f037091bd4e54d9/doc/plans/chat-adapters/2026-09-04-chat-adapters-ui-surfaces-v5.md) also remains available in Git history. Its separate setup audit stays in the working tree. The v6 surface note and minimum-setup specification remain here too; v6 was restored byte-for-byte when the CI-owned lockfile delta was removed. Archiving only v5 makes room for the pinned Discord WebSocket shutdown fix without splitting this review or dropping implementation/tests.
