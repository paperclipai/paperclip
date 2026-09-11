export type SupportedLanguage = "ru" | "en" | "de";

type Params = Record<string, string | number>;

const DICTIONARY = {
  home: { ru: "🏠 Домой", en: "🏠 Home", de: "🏠 Start" },
  organizations: { ru: "🏢 Организации", en: "🏢 Organizations", de: "🏢 Organisationen" },
  agents: { ru: "🤖 Агенты", en: "🤖 Agents", de: "🤖 Agenten" },
  recent_tasks: { ru: "🕘 Последние задачи", en: "🕘 Recent tasks", de: "🕘 Letzte Aufgaben" },
  status: { ru: "ℹ️ Статус", en: "ℹ️ Status", de: "ℹ️ Status" },
  help: { ru: "❓ Помощь", en: "❓ Help", de: "❓ Hilfe" },
  reset_screen: { ru: "♻️ Сбросить экран", en: "♻️ Reset screen", de: "♻️ Ansicht neu aufbauen" },
  new_task: { ru: "➕ Новая задача", en: "➕ New task", de: "➕ Neue Aufgabe" },
  back_to_agents: { ru: "🤖 К агентам", en: "🤖 Back to agents", de: "🤖 Zurück zu Agenten" },
  back_to_agents_list: { ru: "🤖 К списку агентов", en: "🤖 Back to agents", de: "🤖 Zur Agentenliste" },
  back_to_agent_tasks: { ru: "🤖 К задачам агента", en: "🤖 Back to agent tasks", de: "🤖 Zu Agentenaufgaben" },
  back_to_task: { ru: "📋 К задаче", en: "📋 Back to task", de: "📋 Zur Aufgabe" },
  back_to_list: { ru: "⬅️ Назад к списку", en: "⬅️ Back to list", de: "⬅️ Zurück zur Liste" },
  add_comment: { ru: "💬 Добавить комментарий", en: "💬 Add comment", de: "💬 Kommentar hinzufügen" },
  comment: { ru: "💬 Комментарий", en: "💬 Comment", de: "💬 Kommentar" },
  comments: { ru: "🧵 Комментарии", en: "🧵 Comments", de: "🧵 Kommentare" },
  reassign: { ru: "🤖 Сменить агента", en: "🤖 Reassign", de: "🤖 Neu zuweisen" },
  refresh: { ru: "🔄 Обновить", en: "🔄 Refresh", de: "🔄 Aktualisieren" },
  no_project: { ru: "➖ Без проекта", en: "➖ No project", de: "➖ Kein Projekt" },
  task_not_found_short: { ru: "<b>Задача не найдена</b>", en: "<b>Task not found</b>", de: "<b>Aufgabe nicht gefunden</b>" },
  agent_not_found_notice: {
    ru: "Агент не найден. Я открыл список агентов.",
    en: "Agent not found. I opened the agents list.",
    de: "Agent nicht gefunden. Ich habe die Agentenliste geöffnet.",
  },
  project_not_found_notice: {
    ru: "Проект не найден. Выберите другой проект.",
    en: "Project not found. Choose another project.",
    de: "Projekt nicht gefunden. Wählen Sie ein anderes Projekt.",
  },
  task_creation_canceled: {
    ru: "Создание задачи отменено.",
    en: "Task creation was canceled.",
    de: "Die Aufgabenerstellung wurde abgebrochen.",
  },
  select_agent_first_notice: {
    ru: "Сначала выберите агента. Я открыл список агентов.",
    en: "Select an agent first. I opened the agents list.",
    de: "Wählen Sie zuerst einen Agenten. Ich habe die Agentenliste geöffnet.",
  },
  open_task_first_notice: {
    ru: "Сначала откройте задачу. Я показал последние задачи.",
    en: "Open a task first. I showed the recent tasks list.",
    de: "Öffnen Sie zuerst eine Aufgabe. Ich habe die Liste der letzten Aufgaben angezeigt.",
  },
  select_task_first_notice: {
    ru: "Сначала выберите задачу. Я открыл последние задачи.",
    en: "Select a task first. I opened the recent tasks list.",
    de: "Wählen Sie zuerst eine Aufgabe. Ich habe die Liste der letzten Aufgaben geöffnet.",
  },
  no_available_organizations: {
    ru: "❌ В Paperclip не найдено ни одной доступной организации.",
    en: "❌ No available organizations were found in Paperclip.",
    de: "❌ In Paperclip wurden keine verfügbaren Organisationen gefunden.",
  },
  unauthorized_user: {
    ru: "❌ Этот Telegram user id не авторизован для работы с ботом.",
    en: "❌ This Telegram user ID is not authorized to use the bot.",
    de: "❌ Diese Telegram-Benutzer-ID ist für den Bot nicht autorisiert.",
  },
  access_denied: { ru: "❌ Доступ запрещён", en: "❌ Access denied", de: "❌ Zugriff verweigert" },
  screen_recreated: { ru: "Экран пересоздан", en: "Screen recreated", de: "Ansicht neu erstellt" },
  unknown_action: { ru: "Неизвестное действие", en: "Unknown action", de: "Unbekannte Aktion" },
  callback_error: {
    ru: "❌ Ошибка обработки команды",
    en: "❌ Failed to process the command",
    de: "❌ Befehl konnte nicht verarbeitet werden",
  },
  reply_to_add_comment: {
    ru: "Ответьте на сообщение бота, чтобы добавить комментарий.",
    en: "Reply to the bot message to add a comment.",
    de: "Antworten Sie auf die Bot-Nachricht, um einen Kommentar hinzuzufügen.",
  },
  open_task: { ru: "📋 Открыть задачу", en: "📋 Open task", de: "📋 Aufgabe öffnen" },
  was_label: { ru: "Было", en: "Was", de: "War" },
  now_label: { ru: "Стало", en: "Now", de: "Jetzt" },
  blocked_notification_heading: {
    ru: "⛔ <b>Задача перешла в Blocked</b>",
    en: "⛔ <b>Task moved to Blocked</b>",
    de: "⛔ <b>Aufgabe wurde auf Blocked gesetzt</b>",
  },
  generic_agent: { ru: "Агент", en: "Agent", de: "Agent" },
  generic_user: { ru: "Пользователь", en: "User", de: "Benutzer" },
  generic_author: { ru: "Автор", en: "Author", de: "Autor" },
  unassigned: { ru: "не назначен", en: "unassigned", de: "nicht zugewiesen" },
  not_selected: { ru: "не выбрана", en: "not selected", de: "nicht ausgewählt" },
  assignee_not_selected: { ru: "не выбран", en: "not selected", de: "nicht ausgewählt" },
  could_not_resolve: { ru: "не удалось определить", en: "could not be resolved", de: "konnte nicht ermittelt werden" },
  not_configured: { ru: "не настроена", en: "not selected", de: "nicht ausgewählt" },
  notifications_enabled: { ru: "подключены", en: "enabled", de: "aktiviert" },
  notifications_linked: { ru: "чат привязан", en: "chat linked", de: "Chat verknüpft" },
  notifications_not_configured: { ru: "не настроены", en: "not configured", de: "nicht konfiguriert" },
  access_restricted: {
    ru: "ограничен одним Telegram-пользователем",
    en: "restricted to one Telegram user",
    de: "auf einen Telegram-Benutzer beschränkt",
  },
  access_unrestricted: { ru: "без ограничения", en: "unrestricted", de: "uneingeschränkt" },
  organization_label: { ru: "Компания", en: "Organization", de: "Organisation" },
  notifications_label: { ru: "Уведомления", en: "Notifications", de: "Benachrichtigungen" },
  agent_label: { ru: "Агент", en: "Agent", de: "Agent" },
  task_label: { ru: "Задача", en: "Task", de: "Aufgabe" },
  access_label: { ru: "Доступ", en: "Access", de: "Zugriff" },
  selected_agent_tasks: {
    ru: "📂 Задачи выбранного агента",
    en: "📂 Selected agent tasks",
    de: "📂 Aufgaben des gewählten Agenten",
  },
  open_current_task: {
    ru: "📋 Открыть текущую задачу",
    en: "📋 Open current task",
    de: "📋 Aktuelle Aufgabe öffnen",
  },
  organizations_title: { ru: "<b>Организации</b>", en: "<b>Organizations</b>", de: "<b>Organisationen</b>" },
  organizations_empty: {
    ru: "<b>Организации</b>\n\nНет доступных организаций.",
    en: "<b>Organizations</b>\n\nNo organizations are available.",
    de: "<b>Organisationen</b>\n\nKeine Organisationen verfügbar.",
  },
  organizations_choose: {
    ru: "Выберите организацию для работы в Telegram.",
    en: "Choose the organization to use in Telegram.",
    de: "Wählen Sie die Organisation für Telegram aus.",
  },
  status_title: { ru: "<b>Статус подключения</b>", en: "<b>Connection status</b>", de: "<b>Verbindungsstatus</b>" },
  help_text: {
    ru: `<b>Как пользоваться ботом</b>

• Используйте inline-кнопки внутри сообщения, а не reply-клавиатуру.
• <b>Агенты</b> открывают список исполнителей с пагинацией.
• <b>Последние задачи</b> дают быстрый вход без предварительного выбора агента.
• В карточке задачи есть <b>Комментарии</b>, <b>Комментарий</b>, <b>Обновить</b> и возврат назад.
• Новую задачу можно создать из экрана агента или через <b>/newtask</b>: сначала проект, затем 1 строка — заголовок, ниже — описание.
• Для комментария бот отправит <b>ForceReply</b>-запрос: просто ответьте на него.

<b>Команды</b>
<code>/start</code> или <code>/menu</code> — главное меню
<code>/reset</code> — пересоздать сообщение интерфейса ниже в чате
<code>/agents</code> — список агентов
<code>/tasks</code> — задачи выбранного агента
<code>/newtask</code> — создать задачу для выбранного агента
<code>/task &lt;ID&gt;</code> — открыть задачу
<code>/comment &lt;текст&gt;</code> — добавить комментарий к выбранной задаче`,
    en: `<b>How to use the bot</b>

• Use inline buttons inside the message instead of reply keyboards.
• <b>Agents</b> opens the assignee list with pagination.
• <b>Recent tasks</b> gives quick access without selecting an agent first.
• The task card contains <b>Comments</b>, <b>Comment</b>, <b>Refresh</b>, and a back action.
• You can create a new task from the agent screen or with <b>/newtask</b>: first choose a project, then send the title on line 1 and the description below.
• For comments the bot sends a <b>ForceReply</b> prompt: just reply to it.

<b>Commands</b>
<code>/start</code> or <code>/menu</code> — main menu
<code>/reset</code> — recreate the interface message lower in the chat
<code>/agents</code> — agents list
<code>/tasks</code> — tasks for the selected agent
<code>/newtask</code> — create a task for the selected agent
<code>/task &lt;ID&gt;</code> — open a task
<code>/comment &lt;text&gt;</code> — add a comment to the selected task`,
    de: `<b>So verwenden Sie den Bot</b>

• Verwenden Sie Inline-Schaltflächen in der Nachricht statt Reply-Keyboards.
• <b>Agenten</b> öffnet die Liste der Zuständigen mit Seitennavigation.
• <b>Letzte Aufgaben</b> bietet schnellen Zugriff ohne vorherige Agentenauswahl.
• Die Aufgabenkarte enthält <b>Kommentare</b>, <b>Kommentar</b>, <b>Aktualisieren</b> und eine Zurück-Aktion.
• Eine neue Aufgabe kann im Agentenbildschirm oder über <b>/newtask</b> erstellt werden: zuerst Projekt wählen, dann Titel in Zeile 1 und Beschreibung darunter senden.
• Für Kommentare sendet der Bot eine <b>ForceReply</b>-Nachricht: antworten Sie einfach darauf.

<b>Befehle</b>
<code>/start</code> oder <code>/menu</code> — Hauptmenü
<code>/reset</code> — Oberflächen-Nachricht unten im Chat neu erstellen
<code>/agents</code> — Agentenliste
<code>/tasks</code> — Aufgaben des ausgewählten Agenten
<code>/newtask</code> — Aufgabe für den ausgewählten Agenten erstellen
<code>/task &lt;ID&gt;</code> — Aufgabe öffnen
<code>/comment &lt;Text&gt;</code> — Kommentar zur ausgewählten Aufgabe hinzufügen`,
  },
  agents_empty: {
    ru: "<b>Агенты</b>\n\nВ выбранной компании пока нет доступных агентов.",
    en: "<b>Agents</b>\n\nNo agents are available in the selected organization yet.",
    de: "<b>Agenten</b>\n\nIn der gewählten Organisation sind noch keine Agenten verfügbar.",
  },
  agents_title: { ru: "<b>Выбор агента</b>", en: "<b>Select an agent</b>", de: "<b>Agent auswählen</b>" },
  choose_agent: {
    ru: "Выберите агента кнопками ниже.",
    en: "Choose an agent using the buttons below.",
    de: "Wählen Sie unten einen Agenten aus.",
  },
  recent_tasks_empty: {
    ru: "<b>Последние задачи</b>\n\nПока нет задач, которые можно показать.",
    en: "<b>Recent tasks</b>\n\nThere are no tasks to show yet.",
    de: "<b>Letzte Aufgaben</b>\n\nEs gibt noch keine Aufgaben zum Anzeigen.",
  },
  recent_tasks_title: { ru: "<b>Последние задачи</b>", en: "<b>Recent tasks</b>", de: "<b>Letzte Aufgaben</b>" },
  recent_tasks_sorting: {
    ru: "Сортировка: по времени последнего комментария.",
    en: "Sorted by most recent comment activity.",
    de: "Sortiert nach letzter Kommentaraktivität.",
  },
  agent_tasks_empty_title: { ru: "<b>Задачи агента</b>", en: "<b>Agent tasks</b>", de: "<b>Agentenaufgaben</b>" },
  agent_tasks_empty_body: {
    ru: "У этого агента пока нет задач.",
    en: "This agent has no tasks yet.",
    de: "Dieser Agent hat noch keine Aufgaben.",
  },
  new_task_for: { ru: "<b>Новая задача для: {agent}</b>", en: "<b>New task for: {agent}</b>", de: "<b>Neue Aufgabe für: {agent}</b>" },
  choose_project: {
    ru: "Выберите проект для задачи.",
    en: "Choose a project for the task.",
    de: "Wählen Sie ein Projekt für die Aufgabe.",
  },
  can_create_without_project: {
    ru: "Можно создать задачу без проекта.",
    en: "You can create the task without a project.",
    de: "Die Aufgabe kann ohne Projekt erstellt werden.",
  },
  no_active_projects: {
    ru: "Активных проектов не найдено.",
    en: "No active projects found.",
    de: "Keine aktiven Projekte gefunden.",
  },
  task_text_already_captured: {
    ru: "Текст задачи уже получен. После выбора проекта задача будет создана сразу.",
    en: "The task text has already been captured. After you choose a project, the task will be created immediately.",
    de: "Der Aufgabentext wurde bereits erfasst. Nach der Projektauswahl wird die Aufgabe sofort erstellt.",
  },
  reassign_issue_not_found: {
    ru: "<b>Задача не найдена</b>\n\nНевозможно выбрать нового агента для этой задачи.",
    en: "<b>Task not found</b>\n\nCannot choose a new agent for this task.",
    de: "<b>Aufgabe nicht gefunden</b>\n\nFür diese Aufgabe kann kein neuer Agent gewählt werden.",
  },
  reassign_agents_empty: {
    ru: "<b>Агенты</b>\n\nВ выбранной компании пока нет доступных агентов.",
    en: "<b>Agents</b>\n\nNo agents are available in the selected organization yet.",
    de: "<b>Agenten</b>\n\nIn der gewählten Organisation sind noch keine Agenten verfügbar.",
  },
  reassign_title: { ru: "<b>Сменить агента</b>", en: "<b>Reassign agent</b>", de: "<b>Agent neu zuweisen</b>" },
  current_assignee: { ru: "Текущий исполнитель", en: "Current assignee", de: "Aktueller Bearbeiter" },
  choose_new_agent: {
    ru: "Выберите нового агента кнопками ниже.",
    en: "Choose a new agent using the buttons below.",
    de: "Wählen Sie unten einen neuen Agenten aus.",
  },
  task_not_found_context_changed: {
    ru: "<b>Задача не найдена</b>\n\nВозможно, она уже была удалена или у вас изменился контекст компании.",
    en: "<b>Task not found</b>\n\nIt may have been deleted or your organization context changed.",
    de: "<b>Aufgabe nicht gefunden</b>\n\nMöglicherweise wurde sie gelöscht oder Ihr Organisationskontext hat sich geändert.",
  },
  assignee_label: { ru: "Исполнитель", en: "Assignee", de: "Bearbeiter" },
  project_label: { ru: "Проект", en: "Project", de: "Projekt" },
  no_project_value: { ru: "без проекта", en: "no project", de: "kein Projekt" },
  project_not_found_value: { ru: "проект не найден", en: "project not found", de: "Projekt nicht gefunden" },
  status_label: { ru: "Статус", en: "Status", de: "Status" },
  priority_label: { ru: "Приоритет", en: "Priority", de: "Priorität" },
  comments_count_label: { ru: "Комментариев", en: "Comments", de: "Kommentare" },
  description_heading: { ru: "<b>Описание</b>", en: "<b>Description</b>", de: "<b>Beschreibung</b>" },
  task_comment_hint: {
    ru: "Используйте кнопку <b>Комментарий</b> или команду <code>/comment &lt;текст&gt;</code>.",
    en: "Use the <b>Comment</b> button or the <code>/comment &lt;text&gt;</code> command.",
    de: "Verwenden Sie die Schaltfläche <b>Kommentar</b> oder den Befehl <code>/comment &lt;Text&gt;</code>.",
  },
  comments_issue_not_found: {
    ru: "<b>Задача не найдена</b>\n\nНевозможно открыть комментарии для этой задачи.",
    en: "<b>Task not found</b>\n\nCannot open comments for this task.",
    de: "<b>Aufgabe nicht gefunden</b>\n\nKommentare für diese Aufgabe können nicht geöffnet werden.",
  },
  comments_heading: { ru: "<b>Комментарии</b>", en: "<b>Comments</b>", de: "<b>Kommentare</b>" },
  comments_empty: {
    ru: "У этой задачи пока нет комментариев.",
    en: "This task has no comments yet.",
    de: "Diese Aufgabe hat noch keine Kommentare.",
  },
  comment_heading: { ru: "<b>Комментарий</b>", en: "<b>Comment</b>", de: "<b>Kommentar</b>" },
  empty_comment: { ru: "Комментарий пуст", en: "Empty comment", de: "Leerer Kommentar" },
  comment_task_not_found: { ru: "Задача не найдена.", en: "Task not found.", de: "Aufgabe nicht gefunden." },
  comment_reply_prompt: {
    ru: "💬 Ответьте на это сообщение, чтобы добавить комментарий к <b>{task}</b>.",
    en: "💬 Reply to this message to add a comment to <b>{task}</b>.",
    de: "💬 Antworten Sie auf diese Nachricht, um einen Kommentar zu <b>{task}</b> hinzuzufügen.",
  },
  create_task_reply_prompt: {
    ru: `➕ Ответьте на это сообщение, чтобы создать задачу для <b>{agent}</b>.
<b>Проект:</b> {project}

1 строка — заголовок.
Со 2 строки — описание.`,
    en: `➕ Reply to this message to create a task for <b>{agent}</b>.
<b>Project:</b> {project}

Line 1 is the title.
Line 2+ is the description.`,
    de: `➕ Antworten Sie auf diese Nachricht, um eine Aufgabe für <b>{agent}</b> zu erstellen.
<b>Projekt:</b> {project}

Zeile 1 ist der Titel.
Ab Zeile 2 folgt die Beschreibung.`,
  },
  waiting_new_task: {
    ru: `<b>Ожидаю ввод новой задачи для: {agent}</b>
<b>Проект:</b> {project}

Ответьте на сообщение бота.
1 строка станет заголовком, всё ниже пойдёт в описание.`,
    en: `<b>Waiting for a new task for: {agent}</b>
<b>Project:</b> {project}

Reply to the bot message.
Line 1 becomes the title, everything below becomes the description.`,
    de: `<b>Warte auf eine neue Aufgabe für: {agent}</b>
<b>Projekt:</b> {project}

Antworten Sie auf die Bot-Nachricht.
Zeile 1 wird zum Titel, alles darunter zur Beschreibung.`,
  },
  cancel_input: { ru: "✖️ Отменить ввод", en: "✖️ Cancel input", de: "✖️ Eingabe abbrechen" },
  invalid_task_draft: {
    ru: "❌ В первой строке должен быть заголовок задачи. Со второй строки можно добавить описание.",
    en: "❌ The first line must be the task title. You can add the description starting from the second line.",
    de: "❌ In der ersten Zeile muss der Aufgabentitel stehen. Ab der zweiten Zeile kann die Beschreibung folgen.",
  },
  create_task_failed: {
    ru: "❌ Не удалось создать задачу. Попробуйте ещё раз через экран агента.",
    en: "❌ Failed to create the task. Try again from the agent screen.",
    de: "❌ Aufgabe konnte nicht erstellt werden. Versuchen Sie es erneut über den Agentenbildschirm.",
  },
  create_task_error_short: { ru: "❌ Ошибка создания задачи.", en: "❌ Task creation error.", de: "❌ Fehler beim Erstellen der Aufgabe." },
  comment_api_failed: {
    ru: "Не удалось отправить комментарий через board API. Проверьте локальную авторизацию Paperclip и попробуйте снова.",
    en: "Failed to send the comment through the board API. Check local Paperclip authorization and try again.",
    de: "Der Kommentar konnte nicht über die Board-API gesendet werden. Prüfen Sie die lokale Paperclip-Autorisierung und versuchen Sie es erneut.",
  },
  comment_failed: {
    ru: "❌ Не удалось добавить комментарий. Попробуйте ещё раз через карточку задачи.",
    en: "❌ Failed to add the comment. Try again from the task card.",
    de: "❌ Kommentar konnte nicht hinzugefügt werden. Versuchen Sie es erneut über die Aufgabenkarte.",
  },
  load_task_error: { ru: "❌ Ошибка получения задачи.", en: "❌ Failed to load the task.", de: "❌ Aufgabe konnte nicht geladen werden." },
  add_comment_error: { ru: "❌ Ошибка добавления комментария.", en: "❌ Failed to add the comment.", de: "❌ Fehler beim Hinzufügen des Kommentars." },
  chat_linked_notice: {
    ru: "Чат привязан. Если chat id не задан в настройках, теперь этот чат используется для уведомлений.",
    en: "Chat linked. If chat ID is not set in settings, this chat is now used for notifications.",
    de: "Chat verknüpft. Wenn keine Chat-ID in den Einstellungen angegeben ist, wird dieser Chat jetzt für Benachrichtigungen verwendet.",
  },
  new_task_input_canceled: { ru: "Ввод новой задачи отменён.", en: "New task input canceled.", de: "Neue Aufgabeneingabe abgebrochen." },
  project_selected_reply: {
    ru: "Проект выбран. Ответьте на сообщение бота.",
    en: "Project selected. Reply to the bot message.",
    de: "Projekt ausgewählt. Antworten Sie auf die Bot-Nachricht.",
  },
  no_project_selected_reply: {
    ru: "Задача будет создана без проекта. Ответьте на сообщение бота.",
    en: "The task will be created without a project. Reply to the bot message.",
    de: "Die Aufgabe wird ohne Projekt erstellt. Antworten Sie auf die Bot-Nachricht.",
  },
  organization_switched_toast: { ru: "Организация переключена", en: "Organization switched", de: "Organisation gewechselt" },
  organization_already_selected_toast: { ru: "Организация уже выбрана", en: "Organization already selected", de: "Organisation bereits ausgewählt" },
  open_task_first_short: { ru: "Сначала откройте задачу.", en: "Open a task first.", de: "Öffnen Sie zuerst eine Aufgabe." },
  agent_not_found_choose_other: {
    ru: "Агент не найден. Выберите другого агента.",
    en: "Agent not found. Choose another agent.",
    de: "Agent nicht gefunden. Wählen Sie einen anderen Agenten.",
  },
  bot_initialized_yes: { ru: "да", en: "yes", de: "ja" },
  bot_initialized_no: { ru: "нет", en: "no", de: "nein" },
} as const;

export type TranslationKey = keyof typeof DICTIONARY;

export function t(language: SupportedLanguage, key: TranslationKey, params?: Params): string {
  const template = DICTIONARY[key][language];
  if (!params) {
    return template;
  }

  return Object.entries(params).reduce((result, [name, value]) => {
    return result.replaceAll(`{${name}}`, String(value));
  }, template);
}

export function normalizeLanguage(value: unknown): SupportedLanguage | undefined {
  return value === "en" || value === "ru" || value === "de" ? value : undefined;
}

export function getBotCommands(language: SupportedLanguage) {
  if (language === "de") {
    return [
      { command: "start", description: "Hauptmenü öffnen" },
      { command: "menu", description: "Zum Hauptmenü zurückkehren" },
      { command: "reset", description: "Nachricht mit Oberfläche neu erstellen" },
      { command: "agents", description: "Agentenliste anzeigen" },
      { command: "tasks", description: "Aufgaben des ausgewählten Agenten anzeigen" },
      { command: "newtask", description: "Aufgabe für den ausgewählten Agenten erstellen" },
      { command: "task", description: "Aufgabe per ID oder Kennung öffnen" },
      { command: "comment", description: "Kommentar zur ausgewählten Aufgabe hinzufügen" },
      { command: "status", description: "Verbindungsstatus anzeigen" },
      { command: "help", description: "Hilfe anzeigen" },
    ];
  }

  if (language === "en") {
    return [
      { command: "start", description: "Open the main menu" },
      { command: "menu", description: "Return to the main menu" },
      { command: "reset", description: "Recreate the interface message" },
      { command: "agents", description: "Show the agents list" },
      { command: "tasks", description: "Show tasks for the selected agent" },
      { command: "newtask", description: "Create a task for the selected agent" },
      { command: "task", description: "Open a task by ID or identifier" },
      { command: "comment", description: "Add a comment to the selected task" },
      { command: "status", description: "Show connection status" },
      { command: "help", description: "Show help" },
    ];
  }

  return [
    { command: "start", description: "Открыть главное меню" },
    { command: "menu", description: "Вернуться в главное меню" },
    { command: "reset", description: "Пересоздать сообщение с интерфейсом" },
    { command: "agents", description: "Показать список агентов" },
    { command: "tasks", description: "Показать задачи выбранного агента" },
    { command: "newtask", description: "Создать задачу для выбранного агента" },
    { command: "task", description: "Открыть задачу по ID или идентификатору" },
    { command: "comment", description: "Добавить комментарий к выбранной задаче" },
    { command: "status", description: "Показать статус подключения" },
    { command: "help", description: "Показать справку" },
  ];
}

const STATUS_LABELS: Record<SupportedLanguage, Record<string, string>> = {
  ru: {
    todo: "todo",
    open: "open",
    backlog: "backlog",
    in_progress: "in progress",
    blocked: "blocked",
    done: "done",
    closed: "closed",
    canceled: "canceled",
    cancelled: "cancelled",
    in_review: "in review",
    unknown: "неизвестно",
  },
  en: {
    todo: "todo",
    open: "open",
    backlog: "backlog",
    in_progress: "in progress",
    blocked: "blocked",
    done: "done",
    closed: "closed",
    canceled: "canceled",
    cancelled: "cancelled",
    in_review: "in review",
    unknown: "unknown",
  },
  de: {
    todo: "todo",
    open: "open",
    backlog: "backlog",
    in_progress: "in Bearbeitung",
    blocked: "blockiert",
    done: "erledigt",
    closed: "geschlossen",
    canceled: "abgebrochen",
    cancelled: "abgebrochen",
    in_review: "in Prüfung",
    unknown: "unbekannt",
  },
};

const PRIORITY_LABELS: Record<SupportedLanguage, Record<string, string>> = {
  ru: {
    critical: "критический",
    high: "высокий",
    medium: "средний",
    low: "низкий",
    unset: "не задан",
  },
  en: {
    critical: "critical",
    high: "high",
    medium: "medium",
    low: "low",
    unset: "not set",
  },
  de: {
    critical: "kritisch",
    high: "hoch",
    medium: "mittel",
    low: "niedrig",
    unset: "nicht gesetzt",
  },
};

export function getIssueTitle(title: string, language: SupportedLanguage): string {
  if (title.trim()) {
    return title.trim();
  }

  if (language === "de") {
    return "Aufgabe ohne Titel";
  }

  return language === "ru" ? "Задача без названия" : "Untitled task";
}

export function formatIssueReferenceText(
  identifier: string | undefined,
  title: string,
  language: SupportedLanguage,
  truncate: (input: string, maxLength: number) => string,
): string {
  if (identifier) {
    if (language === "de") {
      return `Aufgabe ${identifier}`;
    }

    return language === "ru" ? `задача ${identifier}` : `task ${identifier}`;
  }

  const safeTitle = truncate(getIssueTitle(title, language), 60);
  if (language === "de") {
    return `Aufgabe "${safeTitle}"`;
  }

  return language === "ru" ? `задача «${safeTitle}»` : `task "${safeTitle}"`;
}

export function formatUserDisplayLabel(
  userId: string,
  currentUserId: string | undefined,
  language: SupportedLanguage,
): string {
  if (currentUserId && userId === currentUserId) {
    return language === "ru" ? "Вы" : language === "de" ? "Sie" : "You";
  }

  return language === "ru" ? "Пользователь" : language === "de" ? "Benutzer" : "User";
}

export function formatStatus(status: string | undefined, language: SupportedLanguage): string {
  if (!status) {
    return STATUS_LABELS[language].unknown;
  }

  return STATUS_LABELS[language][status] ?? status.replaceAll("_", " ");
}

export function formatPriority(priority: string | undefined, language: SupportedLanguage): string {
  if (!priority) {
    return PRIORITY_LABELS[language].unset;
  }

  return PRIORITY_LABELS[language][priority] ?? priority;
}

export function formatCommentTimestamp(timestamp: Date | string | undefined, language: SupportedLanguage): string {
  if (!timestamp) {
    return language === "ru" ? "время неизвестно" : language === "de" ? "Zeit unbekannt" : "time unknown";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return String(timestamp);
  }

  const locale = language === "ru" ? "ru-RU" : language === "de" ? "de-DE" : "en-US";
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function projectSortLocale(language: SupportedLanguage): string {
  return language === "ru" ? "ru" : language === "de" ? "de" : "en";
}

export function formatPageSummary(
  language: SupportedLanguage,
  start: number,
  end: number,
  total: number,
): string {
  if (language === "ru") {
    return `Показаны ${start}-${end} из ${total}.`;
  }
  if (language === "de") {
    return `${start}-${end} von ${total} angezeigt.`;
  }
  return `Showing ${start}-${end} of ${total}.`;
}

export function formatResetNotice(language: SupportedLanguage): string {
  if (language === "ru") {
    return "Экран интерфейса пересоздан и перенесён вниз чата.";
  }
  if (language === "de") {
    return "Die Benutzeroberfläche wurde neu erstellt und im Chat nach unten verschoben.";
  }
  return "The interface screen was recreated and moved to the bottom of the chat.";
}

export function formatAgentTasksHeading(language: SupportedLanguage, agentName: string): string {
  if (language === "ru") {
    return `<b>Задачи агента: ${agentName}</b>`;
  }
  if (language === "de") {
    return `<b>Aufgaben von ${agentName}</b>`;
  }
  return `<b>Agent tasks: ${agentName}</b>`;
}

export function formatBotInitializedLine(language: SupportedLanguage, initialized: boolean): string {
  return `<b>Bot initialized:</b> ${initialized ? t(language, "bot_initialized_yes") : t(language, "bot_initialized_no")}`;
}

export function formatCommentPageSummary(language: SupportedLanguage, index: number, total: number): string {
  if (language === "ru") {
    return `Показан комментарий ${index} из ${total}. Новые сверху.`;
  }
  if (language === "de") {
    return `Kommentar ${index} von ${total}. Neueste zuerst.`;
  }
  return `Showing comment ${index} of ${total}. Newest first.`;
}

export function formatTaskAlreadyAssignedNotice(language: SupportedLanguage, agentName: string): string {
  if (language === "ru") {
    return `Задача уже назначена на ${agentName}.`;
  }
  if (language === "de") {
    return `Die Aufgabe ist bereits ${agentName} zugewiesen.`;
  }
  return `The task is already assigned to ${agentName}.`;
}

export function formatTaskReassignedNotice(language: SupportedLanguage, agentName: string): string {
  if (language === "ru") {
    return `Задача переназначена на ${agentName}.`;
  }
  if (language === "de") {
    return `Die Aufgabe wurde ${agentName} neu zugewiesen.`;
  }
  return `Task reassigned to ${agentName}.`;
}

export function formatTaskCreatedNotice(
  language: SupportedLanguage,
  issueRef: string,
  agentName: string,
  projectName?: string,
): string {
  if (language === "ru") {
    return projectName
      ? `Создана ${issueRef} для ${agentName}. Проект: ${projectName}.`
      : `Создана ${issueRef} для ${agentName}.`;
  }
  if (language === "de") {
    return projectName
      ? `${issueRef} wurde für ${agentName} erstellt. Projekt: ${projectName}.`
      : `${issueRef} wurde für ${agentName} erstellt.`;
  }
  return projectName
    ? `Created ${issueRef} for ${agentName}. Project: ${projectName}.`
    : `Created ${issueRef} for ${agentName}.`;
}

export function formatCommentAddedNotice(
  language: SupportedLanguage,
  issueRef: string,
  reopened: boolean,
): string {
  if (language === "ru") {
    return reopened
      ? `Комментарий добавлен к ${issueRef}, задача переоткрыта.`
      : `Комментарий добавлен к ${issueRef}.`;
  }
  if (language === "de") {
    return reopened
      ? `Kommentar zu ${issueRef} hinzugefügt. Die Aufgabe wurde wieder geöffnet.`
      : `Kommentar zu ${issueRef} hinzugefügt.`;
  }
  return reopened
    ? `Comment added to ${issueRef}. The task was reopened.`
    : `Comment added to ${issueRef}.`;
}

export function formatTaskNotFoundByReference(language: SupportedLanguage, reference: string): string {
  if (language === "ru") {
    return `Задача ${reference} не найдена. Я открыл последние задачи.`;
  }
  if (language === "de") {
    return `Aufgabe ${reference} wurde nicht gefunden. Ich habe die Liste der letzten Aufgaben geöffnet.`;
  }
  return `Task ${reference} was not found. I opened the recent tasks list.`;
}

export function formatCompanySwitchedNotice(language: SupportedLanguage, companyName?: string | null): string {
  if (language === "ru") {
    return `Организация переключена на ${companyName ?? "выбранную"}`;
  }
  if (language === "de") {
    return `Organisation gewechselt zu ${companyName ?? "der ausgewählten"}`;
  }
  return `Organization switched to ${companyName ?? "the selected one"}`;
}

export function formatCompanyAlreadySelectedNotice(language: SupportedLanguage, companyName?: string | null): string {
  if (language === "ru") {
    return `Организация ${companyName ?? "уже выбрана"}`;
  }
  if (language === "de") {
    return `Organisation ${companyName ?? "ist bereits ausgewählt"}`;
  }
  return `Organization ${companyName ?? "is already selected"}`;
}

export function formatTaskCreatedNotification(language: SupportedLanguage, issueLine: string, status: string): string {
  if (language === "ru") {
    return `📋 Новая задача\n${issueLine}\nСтатус: ${status}`;
  }
  if (language === "de") {
    return `📋 Neue Aufgabe\n${issueLine}\nStatus: ${status}`;
  }
  return `📋 New task\n${issueLine}\nStatus: ${status}`;
}

export function formatNewCommentNotification(language: SupportedLanguage, issueLine: string): string {
  if (language === "ru") {
    return `💬 Новый комментарий\n${issueLine}`;
  }
  if (language === "de") {
    return `💬 Neuer Kommentar\n${issueLine}`;
  }
  return `💬 New comment\n${issueLine}`;
}

export function formatCommentsButton(language: SupportedLanguage, count: number): string {
  if (count <= 0) {
    return t(language, "comments");
  }
  return `${t(language, "comments")} (${count})`;
}
