# @paperclipai/ui

## Unreleased

### Patch Changes

- Documented the company plugin settings UI and the company-filtered plugin contribution flow used by Company Settings and plugin slot discovery.
- Documented launcher runtime behavior, including `/api/plugins/ui-contributions` launcher discovery, cached launcher activation, and host-validated overlay bounds handling.

## 0.2.10

### Minor Changes

- **Instance-wide Settings Layout**:
  - Introduced a new `InstanceSettings` page at `/settings` to house global configuration options.
  - Moved Plugin Management (`/settings/plugins`) into the new instance-wide settings layout.
  - Updated the sidebar to clearly distinguish between "Company Settings" (per-company) and "Instance Settings" (global).
  - Aligned breadcrumbs and navigation across all plugin-related pages to provide a consistent user experience within the settings context.

## 0.2.9

### Major Changes

- **Refactored `JsonSchemaForm`**:
  - Modularized the component into specialized sub-components (`BooleanField`, `EnumField`, `SecretField`, `NumberField`, `StringField`, `ArrayField`, `ObjectField`).
  - Improved performance using `React.memo` and `useCallback` for recursive rendering.
  - Enhanced type safety across the form component and its helpers.
  - Fixed issues with root-level scalar schemas rendering incorrectly.
  - Added full unit test coverage for JSON Schema helpers and features.

### Patch Changes

- **Testing Infrastructure**:
  - Added React 19 `act` compatibility shim and `matchMedia` mock in `ui/src/test-setup.ts`.
  - Configured Vitest to use the new test setup and resolved module not found errors for `@vitejs/plugin-react`.
  - Fixed flaky tests in `InstanceSettings.test.tsx` and `Layout.test.tsx` by improving mock precision and coverage.
- Updated dependencies
  - @paperclipai/shared@0.2.9
