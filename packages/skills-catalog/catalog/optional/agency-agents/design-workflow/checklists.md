# Design Workflow — Checklists & Review

> This file is referenced by SKILL.md. Read it when reviewing a design or debugging visual issues.

## Self-Check Before Review

Before sending to any reviewer, verify:

1. **Does it look like a real app, or a generic template?**
2. **Squint test** — squint at the screenshot, can you still see the structure?
3. **Comparison test** — does this look as good as the Reference Apps?
4. **Copy check** — is the text specific and helpful?
5. **Personality check** — does it match the Design Personality?

## Critic Review Checklist

### AI Generic Detection
- [ ] No colors outside the project palette
- [ ] No generic gradient blobs
- [ ] Layout has visual variety (not everything centered, same size)
- [ ] Typography has clear hierarchy (3+ distinct sizes/weights)
- [ ] Copy is specific to the project domain

### Design Quality
- [ ] Whitespace is balanced
- [ ] Accent color used sparingly and with purpose
- [ ] Cards/components have variety
- [ ] Hover states exist and look good
- [ ] The design has personality matching design-config

### Consistency
- [ ] Same button styles across all screens
- [ ] Same spacing patterns throughout
- [ ] Same card styles with minor variations
- [ ] Font usage matches design-config

## Troubleshooting: Design vs Implementation Mismatch

| Problem | Cause | Fix |
|---------|-------|-----|
| Colors are wrong | Used Tailwind defaults | Use exact values from theme files |
| Spacing is off | Used random padding | Follow the spacing scale in theme files |
| Fonts look different | Fonts not loaded | Load fonts from design-config |
| Components look generic | No reference to project style | Read theme files and design-config first |
| Mobile is broken | Desktop-first without testing | Always check at all 3 breakpoints |
