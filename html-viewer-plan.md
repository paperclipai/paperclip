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

### Document Viewer Component (`HtmlBody.tsx`)
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
```
1. User clicks "New Document" → Choose format: Markdown | HTML
2. HTML Editor opens with template selector
3. Real-time preview updates as user types
4. Save creates revision with format="html"
5. View renders sanitized HTML with full styling
```

---

## 2. Backend Storage

### Database Schema (No Changes Required)
Existing schema already supports this:
- `documents.format`: VARCHAR field accepts any format string
- `documents.latestBody`: TEXT stores HTML content
- Document revisions track full history

### Required Type Updates
**File: `packages/shared/src/types/issue.ts`**
```typescript
export type DocumentFormat = "markdown" | "html";
```

**File: `packages/shared/src/validators/issue.ts`**
```typescript
export const ISSUE_DOCUMENT_FORMATS = ["markdown", "html"] as const;
```

### Security Considerations
- HTML content must be sanitized server-side before storage
- CSP headers for rendered HTML documents
- Rate limiting on HTML document creation
- Size limits (same as existing: configurable via `PAPERCLIP_ATTACHMENT_MAX_BYTES`)

---

## 3. API Endpoints

### Existing Endpoints (No Changes Required)
All document endpoints already support generic format handling:
- `GET /api/issues/{issueId}/documents/{key}` - Returns document with format field
- `PUT /api/issues/{issueId}/documents/{key}` - Accepts format in request body
- `GET /api/issues/{issueId}/documents/{key}/revisions` - Lists all revisions

### New Endpoints (Optional Enhancements)
- `POST /api/issues/{issueId}/documents/{key}/validate-html` - Validate HTML structure
- `GET /api/issues/{issueId}/documents/{key}/export` - Export as standalone HTML file
- `POST /api/issues/{issueId}/documents/{key}/convert` - Convert between Markdown ↔ HTML

### Request/Response Examples

**Create HTML Document:**
```json
PUT /api/issues/LLM-55/documents/spec
{
  "title": "Technical Specification",
  "format": "html",
  "body": "<!DOCTYPE html><html>...</html>",
  "baseRevisionId": null
}
```

**Response:**
```json
{
  "id": "uuid",
  "key": "spec",
  "title": "Technical Specification",
  "format": "html",
  "latestBody": "<!DOCTYPE html><html>...</html>",
  "latestRevisionNumber": 1,
  "updatedAt": "2026-04-10T..."
}
```

---

## 4. Implementation Approach

### Phase 1: Core Infrastructure (Week 1)
1. **Update Shared Types**
   - Add "html" to DocumentFormat type and validators
   - Add format icons and labels

2. **Backend Validation**
   - Implement HTML sanitization service
   - Add security middleware for HTML content
   - Update document service to validate HTML format

3. **Database Migration (if needed)**
   - Verify existing schema compatibility
   - Add any missing indexes for format queries

### Phase 2: Frontend Components (Week 2)
1. **Create HtmlBody Component**
   - Integrate DOMPurify for sanitization
   - Implement iframe sandboxing option
   - Add responsive container styles
   - Support fullscreen toggle

2. **Create HtmlEditor Component**
   - Integrate Monaco Editor with HTML mode
   - Implement split-pane edit/preview layout
   - Add template selector dropdown
   - Syntax validation and error highlighting

3. **Update Document Section**
   - Modify `IssueDocumentsSection.tsx` to render based on format
   - Add format badge indicators
   - Update revision history display

### Phase 3: Polish & Integration (Week 3)
1. **Testing**
   - Unit tests for HtmlBody sanitization
   - Integration tests for document CRUD
   - Security audit for XSS prevention
   - Cross-browser testing

2. **Documentation**
   - Update API documentation
   - Create user guide for HTML documents
   - Add example templates

3. **Performance Optimization**
   - Lazy loading for large HTML documents
   - Debounced preview updates in editor
   - Caching for sanitized HTML

---

## 5. Milestones & Deliverables

### Milestone 1: Foundation (End of Week 1)
- ✅ Type definitions updated
- ✅ Backend validation implemented
- ✅ API accepts and stores HTML documents
- ✅ Security layer active

**Deliverables:**
- Updated shared types package
- Sanitization service tests passing
- API endpoints validated

### Milestone 2: Frontend MVP (End of Week 2)
- ✅ HtmlBody component renders sanitized HTML
- ✅ HtmlEditor with syntax highlighting
- ✅ Document list shows format badges
- ✅ Basic templates available

**Deliverables:**
- HtmlBody.tsx component
- HtmlEditor.tsx component
- Updated IssueDocumentsSection.tsx
- 3-5 starter templates

### Milestone 3: Production Ready (End of Week 3)
- ✅ Comprehensive test coverage
- ✅ Documentation complete
- ✅ Performance optimized
- ✅ Security audited

**Deliverables:**
- Test suite with 80%+ coverage
- User documentation
- Security audit report
- Performance benchmarks

---

## 6. Dependencies & Technical Considerations

### Required Dependencies

**Frontend:**
- `dompurify` (^3.0.0) - HTML sanitization
- `@monaco-editor/react` (^4.6.0) - Code editor (already used elsewhere in codebase)
- `react-split-pane` (optional) - Resizable panes for editor

**Backend:**
- `isomorphic-dompurify` (^2.0.0) - Server-side HTML sanitization
- Existing validation framework already in place

### Security Considerations

1. **XSS Prevention**
   - All HTML must pass through DOMPurify
   - Remove script tags, event handlers, javascript: URLs
   - Whitelist safe HTML elements and attributes
   - CSP headers preventing inline scripts

2. **Content Security Policy**
   ```
   Content-Security-Policy: default-src 'self'; 
                          style-src 'self' 'unsafe-inline'; 
                          img-src 'self' data: blob:;
   ```

3. **Iframe Sandboxing (Optional)**
   - Sandboxed iframes for complete isolation
   - Allow-scripts disabled by default
   - Configurable per-tenant

### Browser Compatibility
- Modern evergreen browsers (Chrome, Firefox, Safari, Edge)
- ES2020+ features acceptable
- Graceful degradation for older browsers

### Accessibility
- Screen reader support for HTML content
- Keyboard navigation for editor
- ARIA labels for interactive elements
- Color contrast compliance

### Performance Targets
- Document load: < 200ms for typical HTML (<100KB)
- Editor responsiveness: < 16ms keystroke latency
- Sanitization: < 50ms for 100KB HTML
- Bundle size impact: < 100KB gzipped

---

## 7. Rollout Strategy

### Testing Phases
1. **Alpha**: Internal team testing (1 week)
2. **Beta**: Select customers with opt-in (2 weeks)
3. **General Availability**: Feature flag enabled by default

### Migration Path
- Existing Markdown documents unchanged
- Gradual adoption encouraged via templates
- Future: Optional auto-conversion tools

### Monitoring
- Track document creation by format
- Monitor sanitization performance
- Error rates and security events
- User engagement metrics

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
- `ui/src/components/HtmlBody.tsx`
- `ui/src/components/HtmlEditor.tsx`
- `ui/src/components/HtmlTemplates.ts`
- `server/src/services/html-sanitizer.ts`

### Modified Files
- `packages/shared/src/types/issue.ts` - Add "html" to DocumentFormat
- `packages/shared/src/validators/issue.ts` - Add "html" to ISSUE_DOCUMENT_FORMATS
- `ui/src/components/IssueDocumentsSection.tsx` - Conditional rendering by format
- `server/src/services/documents.ts` - Add HTML validation (optional)

### No Changes Required
- Database schema (already flexible)
- Core API endpoints (already generic)
- Document revision system (format-agnostic)
