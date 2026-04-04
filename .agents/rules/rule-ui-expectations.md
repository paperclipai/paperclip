# Rule: UI Expectations

Paperclip's UI must feel premium, responsive, and provide clear feedback for all operations.

- **Activation**: `Always On`

## Guidelines

- **Premium Design**: Use the established design system (Tailwind or CSS modules) with smooth transitions, modern typography, and a cohesive color palette.
- **Error Handling**: Every API error must be caught and displayed to the user via a friendly notification or empty-state handler—never leave the UI in a "stuck" state.
- **Loading States**: Use skeletons or subtle loaders for all async operations to maintain a perceived speed.
- **Responsiveness**: Ensure the board and administrative UIs are functional across desktop and tablet viewport sizes.
- **Action Confirmation**: Destructive actions (like deleting a company or purging logs) require an explicit confirmation modal.
