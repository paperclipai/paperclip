# @paperclipai/plugin-telegram-task-manager-example

Reference Telegram connector plugin for managing Paperclip tasks from a single chat-driven dashboard.

## What It Demonstrates

- Telegram bot integration with inline-button navigation around a single editable dashboard message
- organization selection inside the Telegram UI instead of a fixed `companyId` setting
- multilingual bot UX driven by plugin settings (`ru`, `en`, `de`)
- task creation, assignment changes, comment flows, and notifications from a chat workflow
- persistent plugin state for selected organization, chat binding, and task context
- agent tools for sending Telegram messages and creating tasks programmatically

## Runtime Behavior

- The plugin keeps one dashboard message and edits it in place for navigation.
- `/reset` or the home-screen reset button recreates that dashboard message lower in the chat.
- If no organization has been selected before, the plugin automatically picks the first available organization.
- When the plugin language changes in settings, new Telegram renders use the new language without a manual plugin restart.
- Legacy config keys such as `companyId` are sanitized automatically so the stored config continues to match the current schema.

## Configuration

Settings exposed by the plugin:

- `language`: bot interface language (`ru`, `en`, `de`)
- `telegramBotToken`: Telegram bot token from `@BotFather`
- `telegramChatId`: optional fixed notification chat; if empty, the first authorized `/start` chat is used
- `allowedTelegramUserId`: optional Telegram user ID restriction

## Bot Commands

- `/start` or `/menu`: open the main menu
- `/reset`: recreate the dashboard message lower in the chat
- `/agents`: show the agents list
- `/tasks`: show tasks for the selected agent
- `/newtask`: create a task for the selected agent
- `/task <id-or-identifier>`: open a task
- `/comment <text>`: add a comment to the selected task
- `/status`: show connection status
- `/help`: show usage help

## Tools

### `send-telegram-message`

Sends a message to the linked Telegram chat.

### `create-task-from-telegram`

Creates a Paperclip task and can notify Telegram about it.

## Notes

This plugin is a repo-local example package intended to demonstrate a realistic chat-based connector workflow.
It depends on a live Telegram bot token and an authenticated Paperclip instance.

## Local Install (Dev)

From the repo root:

```bash
pnpm --filter @paperclipai/plugin-telegram-task-manager-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-telegram-task-manager-example
```

## Development

```bash
pnpm --filter @paperclipai/plugin-telegram-task-manager-example typecheck
pnpm --filter @paperclipai/plugin-telegram-task-manager-example build
```
