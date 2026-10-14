# Repository imports

Run the UI Storybook, then open **Agents and reusable capabilities → Skills and Skill Studio → Skills → Repository packages**. These stories use the production pages and components with scoped API fixtures; they do not download GitHub repositories or invoke agents.

- **01–03**: normal repository import and shared-file inspection. Every skill is visible and selected; package files start collapsed.
- **04–05**: omitted files, collapsed and expanded warnings; import stays available.
- **06–07**: missing references and instructions that need setup.
- **08**: warnings remain on the saved source.
- **09**: mobile selection and the visible import footer.

The Playwright walkthroughs live in `tests/storybook-visual/repository-skill-packages.spec.ts`. Database tests cover persisted warnings and runtime file delivery.
