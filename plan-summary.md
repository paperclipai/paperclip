# HTML Document Viewer Support - Implementation Plan

## Overview
Enable Paperclip to support HTML documents alongside the existing Markdown format, allowing agents to create rich HTML documents with CSS styling, diagrams, and interactive elements directly within the Paperclip environment.

## Motivation
- LLMs understand HTML deeply and can generate sophisticated UI layouts
- HTML enables richer visual elements: flow diagrams, styled layouts, interactive components
- Better for research outputs, visual documentation, and complex reports
- Complements existing Markdown support for formal documentation

---

## 1. UI/UX Requirements

### Document Viewer Component (HtmlBody.tsx)
- **Safe HTML Rendering**: Sanitized HTML display using DOMPurify
- **CSS Support**: Inline styles and scoped stylesheets
- **Responsive Design**: Mobile-friendly rendering
- **Iframe Sandboxing**: Optional sandboxed iframe for untrusted content
- **Fullscreen Mode**: Expand/collapse for detailed viewing
- **Print Support**: Optimized print stylesheets

### Document Editor
- **Code Editor**: Monaco or CodeMirror for HTML editing with syntax highlighting
- **Live Preview**: Side-by-side edit/preview mode
- **Template Library**: Pre-built templates for common document types (reports, diagrams, specs)
- **Asset Integration**: Drag-and-drop image/asset insertion with proper URL handling

### Document List Enhancement
- **Format Indicators**: Visual badges showing document format (HTML vs Markdown)
- **Preview Thumbnails**: Optional thumbnail previews for HTML documents
- **Export Options**: Download as standalone HTML file

### User Experience Flow
1. User clicks "New Document" -> Choose format: Markdown | HTML
2. HTML Editor opens with template selector
3. Real-time preview updates as user types
4. Save creates revision with format="html"
5. View renders sanitized HTML with full styling

---

## 2. Backend Storage

### Database Schema (No Changes Required)
Existing schema already supports this:
- documents.format: VARCHAR field accepts any format string
- documents.latestBody: TEXT stores HTML content
- Document revisions track full history

### Required Type Updates
**File: packages/shared/src/types/issue.ts**
```typescript
export type DocumentFormat = "markdown" | "html";
```

**File: packages/shared/src/validators/issue.ts**
```typescript
export const ISSUE_DOCUMENT_FORMATS = ["markdown", "html"] as const;
```

### Security Considerations
- HTML content must be sanitized server-side before storage
- CSP headers for rendered HTML documents
- Rate limiting on HTML document creation
- Size limits (same as existing: configurable via PAPERCLIP_ATTACHMENT_MAX_BYTES)

---

## 3. API Endpoints

### Existing Endpoints (No Changes Required)
All document endpoints already support generic format handling:
- GET /api/issues/{issueId}/documents/{key} - Returns document with format field
- PUT /api/issues/{issueId}/documents/{key} - Accepts format in request body
- GET /api/issues/{issueId}/documents/{key}/revisions - Lists all revisions

### New Endpoints (Optional Enhancements)
- POST /api/issues/{issueId}/documents/{key}/validate-html - Validate HTML structure
- GET /api/issues/{issueId}/documents/{key}/export - Export as standalone HTML file
- POST /api/issues/{issueId}/documents/{key}/convert - Convert between Markdown <-> HTML

---

## 4. Implementation Approach

### Phase 1: Core Infrastructure (Week 1)
1. Update Shared Types - Add "html" to DocumentFormat type and validators
2. Backend Validation - Implement HTML sanitization service, add security middleware
3. Database Migration (if needed) - Verify existing schema compatibility

### Phase 2: Frontend Components (Week 2)
1. Create HtmlBody Component - DOMPurify integration, iframe sandboxing, responsive styles
2. Create HtmlEditor Component - Monaco Editor integration, split-pane layout, templates
3. Update Document Section - Format-based conditional rendering, format badges

### Phase 3: Polish & Integration (Week 3)
1. Testing - Unit tests, security audit, cross-browser testing
2. Documentation - API docs, user guide, example templates
3. Performance Optimization - Lazy loading, debounced previews, caching

---

## 5. Milestones & Deliverables

### Milestone 1: Foundation (End of Week 1)
- Type definitions updated
- Backend validation implemented
- API accepts and stores HTML documents
- Security layer active

### Milestone 2: Frontend MVP (End of Week 2)
- HtmlBody component renders sanitized HTML
- HtmlEditor with syntax highlighting
- Document list shows format badges
- Basic templates available

### Milestone 3: Production Ready (End of Week 3)
- Comprehensive test coverage (80%+)
- Documentation complete
- Performance optimized
- Security audited

---

## 6. Dependencies & Technical Considerations

### Required Dependencies

**Frontend:**
- dompurify (^3.0.0) - HTML sanitization
- @monaco-editor/react (^4.6.0) - Code editor (already used elsewhere in codebase)
- react-split-pane (optional) - Resizable panes for editor

**Backend:**
- isomorphic-dompurify (^2.0.0) - Server-side HTML sanitization

### Security Considerations

1. XSS Prevention - All HTML must pass through DOMPurify, remove scripts/event handlers
2. Content Security Policy - Strict CSP headers preventing inline scripts
3. Iframe Sandboxing - Sandboxed iframes for complete isolation (configurable per-tenant)

### Browser Compatibility
- Modern evergreen browsers (Chrome, Firefox, Safari, Edge)
- ES2020+ features acceptable

### Performance Targets
- Document load: < 200ms for typical HTML (<100KB)
- Editor responsiveness: < 16ms keystroke latency
- Sanitization: < 50ms for 100KB HTML
- Bundle size impact: < 100KB gzipped

---

## 7. Rollout Strategy

### Testing Phases
1. Alpha: Internal team testing (1 week)
2. Beta: Select customers with opt-in (2 weeks)
3. General Availability: Feature flag enabled by default

### Migration Path
- Existing Markdown documents unchanged
- Gradual adoption encouraged via templates
- Future: Optional auto-conversion tools

---

## 8. Open Questions

1. Should we support external CSS file references or only inline styles?
2. Do we need collaborative editing for HTML (like Google Docs)?
3. Should HTML documents support embedded scripts (charts, etc.)?
4. What template library should we ship with initially?
5. Do we need PDF export capability for HTML documents?

---

## Appendix: File Modifications Summary

### New Files
- ui/src/components/HtmlBody.tsx
- ui/src/components/HtmlEditor.tsx
- ui/src/components/HtmlTemplates.ts
- server/src/services/html-sanitizer.ts

### Modified Files
- packages/shared/src/types/issue.ts - Add "html" to DocumentFormat
- packages/shared/src/validators/issue.ts - Add "html" to ISSUE_DOCUMENT_FORMATS
- ui/src/components/IssueDocumentsSection.tsx - Conditional rendering by format
- server/src/services/documents.ts - Add HTML validation (optional)

### No Changes Required
- Database schema (already flexible)
- Core API endpoints (already generic)
- Document revision system (format-agnostic)
