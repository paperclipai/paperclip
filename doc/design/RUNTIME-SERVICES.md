# Runtime service interface

Services should answer three questions in order: what is running, whether it needs attention, and how to open or control it.

The company inventory uses one list. Each row keeps the name, state and lifetime together. Preview and start/stop controls sit beside that summary. Restart, logs and URL copying remain available in the actions menu. The task properties pane uses the same ordering at a smaller size, so a preview does not displace the task's other properties.

The service detail page gives the preview a primary action. Runtime settings use labeled rows with concise summaries. Lifetime, environment and task attachment editors open in place. Sharing and storage follow as separate sections. Storage measurement methodology is a disclosure; retention deadlines, dependency blockers and failures stay visible. Data deletion remains a separate, explicit review with its existing confirmation and retry behavior.

Use the existing semantic tokens and primitives. Status changes and editor entry use the app's motion-duration token and respect reduced motion. Copy feedback clears after a short interval. Requests retain their existing optimistic feedback, operation locks and recovery actions.

## Review in Storybook

The **Runtime Services** section contains the production pages inside the app shell, with stateful simulated API data. The 61 existing stories remain. **Task and properties → Service actions** adds the compact keyboard-accessible actions menu. Review the inventory, running service, task properties, mobile, light theme, editor, lost-response and deletion stories together.

These stories verify the UI with local fixtures. They do not provision Daytona, exercise Cloud routing or prove hosted preview isolation.
