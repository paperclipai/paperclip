# maintain-verification-skill attribution

This skill comes from Paperclip's portable pstack fork in
`paperclipai/agent-plugins`, commit
`410257663e0b344df656e604f1601aa1db95f7e4`, under `vendor/pstack/`.
The fork imported pstack 0.15.15 by Lauren Tan (poteto) from
[cursor/plugins](https://github.com/cursor/plugins/tree/ccb5507cec1546dc88135c1139c811e6c59115ba/pstack),
upstream revision `ccb5507cec1546dc88135c1139c811e6c59115ba`.

Paperclip adapts the workflow to the sibling `maps/feature-map/` and
`maps/agent-access-map/` directories and their shared access contract.
It preserves the invocation policy in `agents/openai.yaml`, removes the
Cursor-specific `disable-model-invocation` frontmatter field, and omits the
separate runtime skill dependency because Paperclip supplies execution.
No upstream Cursor built-in skills are redistributed.

The imported resources include `SKILL.md` and `agents/openai.yaml`.
The workflow uses the examples shipped with
[`create-verification-skill`](../create-verification-skill/references/feature-map-example/).

## License

The original license is reproduced verbatim below.

```text
MIT License

Copyright (c) 2026 Lauren Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
