# QA / UX / A11Y Review Checklist

> Sử dụng checklist này khi review PR hoặc issue ở phase QA. Copy vào comment trên issue.

---

## QA Review — QUA-xxx

**PR:** #xxx
**Reviewer:** [name]
**Date:** YYYY-MM-DD
**Verdict:** ✅ APPROVED / ❌ CHANGES REQUESTED

---

### 1. Code Correctness
- [ ] Logic matches spec và acceptance criteria
- [ ] Edge cases được handle
- [ ] Error handling hợp lý (không thừa, không thiếu)
- [ ] Không có dead code hoặc commented-out blocks
- [ ] Follows existing codebase patterns

### 2. TypeScript & Build
- [ ] `npx tsc --noEmit` pass (no new errors)
- [ ] No `any` types (dùng `unknown` + type guards)
- [ ] Import paths correct

### 3. Tests
- [ ] `npx vitest run` pass (no regressions)
- [ ] New behavior có test coverage
- [ ] Test names mô tả rõ expected behavior

### 4. Security
- [ ] Không có secrets/credentials trong code
- [ ] Không có XSS/injection vectors
- [ ] Input validation tại system boundaries
- [ ] Không có OWASP top-10 violations

### 5. Performance
- [ ] Không có N+1 queries
- [ ] Không có memory leaks (event listeners, intervals cleaned up)
- [ ] Không có unnecessary re-renders (React)
- [ ] Bundle size không tăng đáng kể

---

## UX Review (cho UI changes)

### 6. Visual & Layout
- [ ] UI match với design spec / mockup
- [ ] Responsive trên desktop, tablet, mobile
- [ ] Loading states hiển thị đúng
- [ ] Error states hiển thị đúng
- [ ] Empty states hiển thị đúng

### 7. Interaction
- [ ] Click/tap targets đủ lớn (min 44x44px)
- [ ] Hover/focus states rõ ràng
- [ ] Transitions mượt (không janky)
- [ ] Form validation feedback rõ ràng

---

## A11Y Review (WCAG 2.1 AA)

### 8. Semantic HTML
- [ ] Heading hierarchy đúng (h1 > h2 > h3)
- [ ] Landmark roles sử dụng đúng (main, nav, aside)
- [ ] Lists dùng `<ul>/<ol>/<li>`, không dùng div
- [ ] Tables có `<thead>`, `<th>`, `scope`

### 9. ARIA
- [ ] Interactive elements có `aria-label` hoặc visible label
- [ ] Icon buttons có `aria-label` mô tả action
- [ ] Dynamic content có `aria-live` regions
- [ ] Modal/dialog có `role="dialog"` + `aria-modal`
- [ ] Expandable sections có `aria-expanded`

### 10. Keyboard
- [ ] Tất cả interactive elements focusable bằng Tab
- [ ] Focus order logic (top-to-bottom, left-to-right)
- [ ] Focus trap trong modals/dialogs
- [ ] `focus-visible` styles rõ ràng
- [ ] Escape đóng modals/popovers

### 11. Color & Contrast
- [ ] Text contrast ratio ≥ 4.5:1 (normal text)
- [ ] Large text contrast ratio ≥ 3:1
- [ ] UI component contrast ratio ≥ 3:1
- [ ] Thông tin không chỉ truyền đạt qua màu sắc

### 12. Screen Reader
- [ ] Alt text cho images có ý nghĩa
- [ ] Decorative images có `aria-hidden="true"` hoặc `alt=""`
- [ ] Form inputs có associated labels
- [ ] Error messages linked to inputs (`aria-describedby`)

---

### Findings
<!-- Ghi lại bất kỳ issue nào tìm thấy -->

| # | Severity | Description | File:Line |
|---|----------|-------------|-----------|
| 1 | ... | ... | ... |

### Sign-off
- Reviewer: _______________
- Date: _______________
- Verdict: _______________

---

*Template version 1.0 — QUA-182*
