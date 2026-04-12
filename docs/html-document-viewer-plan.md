# HTML Document Viewer Support - Technical Plan

## Overview

Enable Paperclip to store, display, and render HTML documents (with embedded CSS) created by agents. This extends the existing document system beyond markdown to support richer formatting, diagrams, and interactive visualizations.

---

## 1. Problem Statement

Currently, Paperclip only supports markdown documents (`format: "markdown"`). While markdown is excellent for text-heavy documents, it lacks:
- Rich styling and layout capabilities
- Interactive diagrams and flowcharts
- Advanced visual presentation
- CSS-based formatting and theming

HTML documents allow agents to create richer research outputs, architecture diagrams, and visual specifications.

---

## 2. Goals

1. **Extend document format support** to include HTML alongside markdown
2. **Secure HTML rendering** via iframe sandboxing and CSP
3. **Maintain backward compatibility** with existing markdown documents
4. **Consistent API** - reuse existing document endpoints with format param
5. **Rich viewer UI** - proper HTML rendering with isolation
6. **Sanitization** - strip dangerous tags/scripts while preserving styling

---

## 3. Non-Goals

- JavaScript execution in HTML documents (sanitized out)
- External resource loading (images must be data URIs or blocked)
- Form submissions or external links
- Server-side rendering of HTML

---

## 4. Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Agent/MCP     │────▶│   Server API    │────▶│   Database      │
│                 │     │                 │     │                 │
│ paperclipUpsert │     │ PUT /issues/:id │     │ documents table │
│ IssueDocument   │     │ /documents/:key │     │ format: html    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
┌─────────────────┐     ┌─────────────────┐            │
│   User/Board    │◀───▶│   UI React App  │◀───────────┘
│                 │     │                 │     documents
│ View HTML docs  │     │ HtmlViewer      │     .format check
└─────────────────┘     └─────────────────┘
                              │
                        ┌─────▼─────┐
                        │  iframe   │
                        │  sandbox  │
                        └───────────┘
```

---

## 5. Implementation Details

### 5.1 Database Changes

**No schema changes required.** The `documents.format` field already exists and supports extending formats.

Update the validator to accept `"html"`:

**File:** `packages/shared/src/validators/issue.ts`
```typescript
// Change line 185
export const ISSUE_DOCUMENT_FORMATS = ["markdown", "html"] as const;
```

### 5.2 Shared Types & Validators

**File:** `packages/shared/src/types/issue.ts` (lines 64-90)
- No changes needed - `format` is already typed as string

**File:** `packages/shared/src/validators/issue.ts`
- Update `ISSUE_DOCUMENT_FORMATS` array
- Max body size considerations: HTML can be larger due to CSS. Current 524KB limit should suffice for now.

### 5.3 MCP Tools

**File:** `packages/mcp-server/src/tools.ts` (around line 338)

The existing `paperclipUpsertIssueDocument` tool needs to accept `format: "html"`. Update the schema:

```typescript
// In tool definition, allow format to be html
format: z.enum(["markdown", "html"]).default("markdown"),
```

### 5.4 Server Service Layer

**File:** `server/src/services/issues.ts`

Document service methods already handle format field. Minimal changes needed:

1. **Document listing** - no change needed
2. **Document retrieval** - no change needed  
3. **Document upsert** - validate format enum

Add format validation in `upsertIssueDocument`:

```typescript
const VALID_FORMATS = ["markdown", "html"];
if (!VALID_FORMATS.includes(input.format)) {
  throw unprocessable(`Invalid document format: ${input.format}`);
}
```

### 5.5 API Routes

**File:** `server/src/routes/issues.ts` (lines 608-650)

No changes needed - routes already pass format through. Just ensure validation schema accepts "html".

### 5.6 HTML Sanitization Service (NEW)

**Create:** `server/src/services/html-sanitizer.ts`

Purpose: Clean HTML documents before storage and before serving.

```typescript
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

const window = new JSDOM("").window;
const DOMPurify = createDOMPurify(window);

export interface SanitizeOptions {
  allowStyles?: boolean;  // true for agent docs, preserves inline CSS
  maxLength?: number;
}

export function sanitizeHtml(
  html: string,
  options: SanitizeOptions = {}
): { sanitized: string; warnings: string[] } {
  const warnings: string[] = [];
  
  const config = {
    ALLOWED_TAGS: [
      "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
      "strong", "b", "em", "i", "u", "strike", "del", "s",
      "blockquote", "q", "cite",
      "ul", "ol", "li", "dl", "dt", "dd",
      "a", "abbr", "acronym", "address",
      "img", "figure", "figcaption",
      "table", "thead", "tbody", "tfoot", "tr", "td", "th",
      "div", "span", "header", "footer", "main", "section", "article", "aside", "nav",
      "pre", "code", "kbd", "samp", "var",
      "details", "summary",
      "mark", "small", "sub", "sup", "time",
      "svg"  // For diagrams
    ],
    ALLOWED_ATTR: [
      "href", "title", "alt", "src", "width", "height",
      "class", "id",
      "style",  // Allows inline CSS
      "target", // But we'll rewrite _blank
      "colspan", "rowspan",
      "data-*", // Custom data attributes
      "xmlns", "viewBox", "fill", "stroke" // SVG
    ],
    FORBIDDEN_ATTR: ["onclick", "onload", "onerror", "onmouseover"],
    ALLOW_DATA_ATTR: true,
  };

  const sanitized = DOMPurify.sanitize(html, config);
  
  // Track what was removed
  const dirty = DOMPurify.removed;
  if (dirty.length > 0) {
    warnings.push(`Removed ${dirty.length} unsafe elements/attributes`);
  }

  return { sanitized, warnings };
}
```

**Install dependency:**
```bash
cd server && npm install dompurify jsdom
```

### 5.7 UI Components

#### 5.7.1 HTML Viewer Component (NEW)

**Create:** `ui/src/components/HtmlViewer.tsx`

```typescript
import { useMemo } from "react";
import { cn } from "../lib/utils";

interface HtmlViewerProps {
  html: string;
  className?: string;
  title?: string;
}

export function HtmlViewer({ html, className, title }: HtmlViewerProps) {
  // Wrap in sandboxed iframe for security
  const srcDoc = useMemo(() => {
    const sanitized = html; // Already sanitized server-side
    
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    /* Reset and base styles */
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #e1e4ed;
      background: #0f1117;
      margin: 0;
      padding: 24px;
      font-size: 14px;
    }
    
    /* Typography */
    h1, h2, h3, h4, h5, h6 {
      color: #a29bfe;
      margin-top: 24px;
      margin-bottom: 12px;
    }
    h1 { font-size: 28px; border-bottom: 1px solid #2a2d3e; padding-bottom: 8px; }
    h2 { font-size: 22px; }
    h3 { font-size: 18px; }
    
    p { margin: 0 0 12px 0; }
    
    a { color: #74b9ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    
    code {
      background: #1c1f2e;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
    }
    
    pre {
      background: #1c1f2e;
      padding: 16px;
      border-radius: 8px;
      overflow-x: auto;
      border: 1px solid #2a2d3e;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
    }
    th, td {
      padding: 8px 12px;
      border: 1px solid #2a2d3e;
      text-align: left;
    }
    th {
      background: #161922;
      font-weight: 600;
    }
    
    blockquote {
      border-left: 3px solid #6c5ce7;
      margin: 16px 0;
      padding-left: 16px;
      color: #8b8fa3;
    }
    
    img { max-width: 100%; height: auto; }
  </style>
</head>
<body>${sanitized}</body>
</html>
    `.trim();
  }, [html]);

  return (
    <div className={cn("rounded-lg border border-border overflow-hidden", className)}>
      {title && (
        <div className="px-4 py-2 bg-secondary border-b border-border">
          <span className="text-xs font-medium text-muted-foreground">{title}</span>
          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 border border-orange-500/30">HTML</span>
        </div>
      )}
      <iframe
        srcDoc={srcDoc}
        className="w-full min-h-[400px] bg-transparent"
        sandbox="allow-same-origin"
        title={title || "HTML Document"}
      />
    </div>
  );
}
```

#### 5.7.2 Update Document Section

**Modify:** `ui/src/components/IssueDocumentsSection.tsx` (around line 71-73)

```typescript
function renderBody(body: string, format: string, className?: string) {
  if (format === "html") {
    return <HtmlViewer html={body} className={className} />;
  }
  return <MarkdownBody className={className}>{body}</MarkdownBody>;
}
```

Update calls to `renderBody` to pass format parameter.

#### 5.7.3 Document Editor Enhancements

**Modify:** `ui/src/components/IssueDocumentsSection.tsx` (around lines 35-42)

Add format field to draft state:

```typescript
type DraftState = {
  key: string;
  title: string;
  body: string;
  format: "markdown" | "html";
  baseRevisionId: string | null;
  isNew: boolean;
};
```

Add format selector UI in the document editor panel.

### 5.8 Security Considerations

1. **Server-side sanitization** - All HTML is cleaned before storage using DOMPurify
2. **Iframe sandboxing** - HTML renders in sandboxed iframe with `allow-same-origin` only
3. **CSP headers** - Content served with strict CSP preventing inline scripts
4. **No external resources** - Images must use data URIs or be blocked
5. **Link rewriting** - All links open in new tabs with `rel="noopener noreferrer"`

### 5.9 Migration Strategy

No migration needed - this is additive. Existing markdown documents continue working unchanged.

---

## 6. Milestones

### Milestone 1: Backend Support (2 days)
- [ ] Update `ISSUE_DOCUMENT_FORMATS` validator
- [ ] Create HTML sanitizer service with DOMPurify
- [ ] Integrate sanitization into document upsert
- [ ] Add unit tests for sanitizer

### Milestone 2: MCP Tool Updates (1 day)
- [ ] Update MCP tool schemas to accept format parameter
- [ ] Test document creation via MCP

### Milestone 3: UI Viewer Component (2 days)
- [ ] Create `HtmlViewer.tsx` component with iframe sandboxing
- [ ] Add dark-themed default CSS
- [ ] Integrate into `IssueDocumentsSection`
- [ ] Add format indicator badges

### Milestone 4: Document Editor (1 day)
- [ ] Add format selector to draft state
- [ ] Show format indicator for existing documents
- [ ] Handle format switching

### Milestone 5: Testing & Polish (2 days)
- [ ] Integration tests for HTML document flow
- [ ] Security review of sanitization rules
- [ ] Test with sample HTML documents from agents
- [ ] Documentation update

**Total Estimated Time:** 8 days

---

## 7. Testing Strategy

### Unit Tests

**File:** `server/src/services/html-sanitizer.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "./html-sanitizer";

describe("sanitizeHtml", () => {
  it("allows basic HTML structure", () => {
    const html = "<div><h1>Title</h1><p>Content</p></div>";
    const result = sanitizeHtml(html);
    expect(result.sanitized).toContain("<h1>");
    expect(result.warnings).toHaveLength(0);
  });

  it("removes script tags", () => {
    const html = '<p>Safe</p><script>alert("xss")</script>';
    const result = sanitizeHtml(html);
    expect(result.sanitized).not.toContain("<script>");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("preserves inline styles", () => {
    const html = '<p style="color: red;">Styled</p>';
    const result = sanitizeHtml(html);
    expect(result.sanitized).toContain('style="');
  });

  it("handles SVG elements", () => {
    const html = '<svg><circle cx="50" cy="50" r="40"/></svg>';
    const result = sanitizeHtml(html);
    expect(result.sanitized).toContain("<svg>");
  });
});
```

### Integration Tests

Test full flow:
1. Agent creates HTML document via MCP
2. Document stores correctly with format="html"
3. UI renders in sandboxed iframe
4. Revisions work correctly

---

## 8. Dependencies

**New Production Dependencies:**
- `dompurify` (^3.x) - Server-side HTML sanitization
- `jsdom` (^24.x) - DOM environment for DOMPurify server-side
- `@types/dompurify` - TypeScript definitions

**No UI dependencies needed** - uses native iframe.

---

## 9. Open Questions

1. **Size limits**: Should HTML documents have higher size limits than markdown? Inline CSS/images can inflate size.
   - Recommendation: Keep 524KB limit for now, monitor usage.

2. **Image handling**: Should we allow data URI images? 
   - Recommendation: Yes, allow data URIs for embedded diagrams.

3. **Print/PDF export**: Do we need to support exporting HTML docs?
   - Recommendation: Future enhancement, iframe print works natively.

4. **Mobile viewing**: Responsive design in iframe?
   - Recommendation: Yes, include viewport meta tag in wrapper.

---

## 10. Files Modified

| File | Change |
|------|--------|
| `packages/shared/src/validators/issue.ts` | Add "html" to ISSUE_DOCUMENT_FORMATS |
| `packages/mcp-server/src/tools.ts` | Update tool schema for format param |
| `server/src/services/html-sanitizer.ts` | **NEW** - HTML sanitization service |
| `server/src/services/issues.ts` | Integrate sanitization, validate format |
| `ui/src/components/HtmlViewer.tsx` | **NEW** - HTML viewer component |
| `ui/src/components/IssueDocumentsSection.tsx` | Integrate viewer, add format handling |
| `server/package.json` | Add dompurify, jsdom dependencies |

---

## 11. Success Criteria

- [ ] Agents can create HTML documents via MCP tools
- [ ] HTML documents render securely in sandboxed iframes
- [ ] Malicious scripts are stripped server-side
- [ ] Existing markdown documents unaffected
- [ ] Dark theme applied consistently
- [ ] Revisions work for HTML documents
- [ ] All tests pass

---

*Plan created for [LLM-55](/LLM/issues/LLM-55)*
