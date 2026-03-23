# Implementation Spec Template

> Sử dụng template này cho mọi issue cần spec trước khi dev. Copy vào comment trên Paperclip issue.

---

## Implementation Plan — QUA-xxx

### Goal
<!-- 1-2 câu mô tả mục tiêu -->

### Background
<!-- Tại sao cần thay đổi này? Liên kết đến bug report / feature request / GH issue -->

### Approach
<!-- Mô tả kỹ thuật: thuật toán, pattern, thư viện sử dụng -->

### Files Affected
| File | Thay đổi |
|------|----------|
| `path/to/file.ts` | Mô tả thay đổi |

### Scope
**In scope:**
- [ ] ...

**Out of scope:**
- ...

### Definition of Done
- [ ] Acceptance criteria met
- [ ] TypeScript compiles (`npx tsc --noEmit`)
- [ ] Tests pass (`npx vitest run`)
- [ ] No new console warnings/errors
- [ ] PR created with conventional commit

### UX/A11Y Requirements
<!-- Bỏ qua nếu không có UI change -->
- [ ] ARIA labels đúng
- [ ] Keyboard navigation hoạt động
- [ ] Color contrast WCAG 2.1 AA
- [ ] Responsive trên mobile

### Security Considerations
<!-- Có xử lý user input? External data? Auth? -->
- [ ] Input validation tại system boundary
- [ ] Không expose secrets
- [ ] Không có injection vectors

### Risks & Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| ... | High/Medium/Low | ... |

### Estimated Effort
<!-- small (< 1h) / medium (1-4h) / large (4h+) -->

---

*Template version 1.0 — QUA-182*
