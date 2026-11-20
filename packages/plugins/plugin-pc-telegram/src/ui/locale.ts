// The board stores the locale in localStorage. documentElement.lang stays "en".
const LOCALE_STORAGE_KEY = "paperclip.locale";

const RU: Record<string, string> = {
  "Connect Telegram": "Подключить Telegram",
  "Connect a personal Telegram account with QR login. Incoming direct messages become issues. Assign the answering agent on the connection; changing it does not require a new login.":
    "Подключите личный аккаунт Telegram по QR. Входящие личные сообщения становятся задачами. Отвечающего агента выбирают на подключении; чтобы сменить его, входить заново не нужно.",
  "Set Telegram api_id and api_hash in plugin settings before scanning a QR code.":
    "Сначала создайте секреты api_id и api_hash кнопкой «+» в полях ниже и нажмите «Сохранить конфигурацию». Значения берутся на my.telegram.org/apps. После сохранения нажмите «Подключить Telegram».",
  "Plugin config is missing apiId. Set Telegram api_id and api_hash in plugin settings.":
    "api_id ещё не сохранён. Создайте секреты api_id и api_hash кнопкой «+» в полях ниже и нажмите «Сохранить конфигурацию». Значения берутся на my.telegram.org/apps.",
  "Plugin config is missing apiHash. Set Telegram api_id and api_hash in plugin settings.":
    "api_hash ещё не сохранён. Создайте секреты api_id и api_hash кнопкой «+» в полях ниже и нажмите «Сохранить конфигурацию». Значения берутся на my.telegram.org/apps.",
  "Telegram login QR code": "QR-код входа в Telegram",
  "The code refreshes on its own. Scan the image on screen now.":
    "Код обновляется сам. Сканируйте картинку, которая на экране сейчас.",
  "In Telegram open Settings, then Devices, then Link Desktop Device. The camera in a chat does not open this code.":
    "В Telegram откройте Настройки → Устройства → Подключить устройство. Камера в чате этот код не открывает.",
  "Cloud password": "Облачный пароль",
  "Cloud password was not accepted.": "Облачный пароль не подошёл.",
  "Cloud password timed out.": "Время ввода облачного пароля вышло.",
  "Telegram login cancelled.": "Вход в Telegram отменён.",
  "Telegram login failed.": "Вход в Telegram не выполнен.",
  "Missing or unknown invocation scope": "Не задана или неизвестна область вызова.",
  "Activation failed: Missing or unknown invocation scope": "Активация не выполнена: не задана или неизвестна область вызова.",
  "Telegram session was empty after login.": "После входа сессия Telegram пустая.",
  "Telegram did not return the signed-in user.": "Telegram не вернул вошедшего пользователя.",
  "Continue": "Продолжить",
  "Cancel": "Отменить",
  "Starting…": "Запуск…",
  "Connected accounts": "Подключённые аккаунты",
  "Loading accounts…": "Загрузка аккаунтов…",
  "No Telegram accounts connected yet.": "Аккаунты Telegram ещё не подключены.",
  "Live": "Сейчас",
  "Offline": "Не в сети",
  "Paused": "На паузе",
  "Incoming mode: dialog = task": "Входящие: диалог = задача",
  "Answering agent": "Отвечающий агент",
  "No agent": "Агента нет",
  "Search agents": "Найти агента",
  "No agents": "Агентов нет",
  "Local cache": "Локальный кеш",
  "Dialogs and avatars are stored on this server and shown before Telegram answers.":
    "Диалоги и аватары лежат на этом сервере и показываются до ответа Telegram.",
  "Cache is on": "Кеш включён",
  "Cache is off": "Кеш выключен",
  "Turn cache off": "Выключить кеш",
  "Turn cache on": "Включить кеш",
  "Loading cache…": "Загрузка кеша…",
  Used: "Занято",
  Dialogs: "Диалоги",
  Avatars: "Аватары",
  Limit: "Лимит",
  "Clear avatars": "Очистить аватары",
  "Clear dialogs": "Очистить диалоги",
  "Clear cache": "Очистить кеш",
  "Unknown cache scope.": "Неизвестная область кеша.",
  "Resume inbound": "Возобновить входящие",
  "Pause inbound": "Поставить входящие на паузу",
  "Accept private chats from anyone": "Принимать личные чаты от кого угодно",
  "Allowed user ids": "Разрешённые id пользователей",
  "One id per word. Other private chats stay closed.": "По одному id через пробел. Остальные личные чаты закрыты.",
  "Something went wrong.": "Что-то пошло не так.",
  "No chats": "Нет чатов",
  "Retry": "Повторить",
  "Load older chats": "Показать более ранние чаты",
  Telegram: "Telegram",
  "Choose a chat": "Выберите чат",
  "Select a chat": "Выберите чат",
  Search: "Поиск",
  Today: "Сегодня",
  Yesterday: "Вчера",
  Back: "Назад",
  "No messages": "Сообщений нет",
  "The Telegram account is offline. Showing messages already saved on the task.": "Аккаунт Telegram не в сети. Показаны сообщения, которые уже лежат на задаче.",
  "Message": "Сообщение",
  "Forwarded": "Переслано",
  Send: "Отправить",
  Task: "Задача",
  You: "Вы",
  Photo: "Фото",
  File: "Файл",
  "Voice message": "Голосовое",
  Video: "Видео",
  Sticker: "Стикер",
  Location: "Геолокация",
  "User Info": "Информация",
  Close: "Закрыть",
  Phone: "Телефон",
  Username: "Имя пользователя",
  Bio: "О себе",
  Channel: "Канал",
  "Shared groups": "Общие группы",
  Reply: "Ответить",
  Copy: "Копировать",
  Pin: "Закрепить",
  Unpin: "Открепить",
  Forward: "Переслать",
  Select: "Выбрать",
  Delete: "Удалить",
  "Delete for me": "Удалить у меня",
  "Delete for everyone": "Удалить у всех",
  "More reactions": "Ещё реакции",
  "Message id is required.": "Нужен идентификатор сообщения.",
  "Unknown message action.": "Неизвестное действие.",
  "Reaction is unavailable.": "Такой реакции нет.",
  "Telegram reactions are unavailable.": "Реакции Telegram сейчас недоступны.",
  "Telegram pin is unavailable.": "Закрепление сейчас недоступно.",
  "Telegram delete is unavailable.": "Удаление сейчас недоступно.",
  "Telegram forward is unavailable.": "Пересылка сейчас недоступна.",
  online: "в сети",
  "last seen recently": "был(а) недавно",
  "last seen within a week": "был(а) на этой неделе",
  "last seen within a month": "был(а) в этом месяце",
  "last seen a long time ago": "был(а) давно",
  "Message text is required.": "Нужен текст сообщения.",
  "Message text is too long.": "Сообщение слишком длинное.",
  "This issue is not a Telegram dialog.": "Это не диалог Telegram.",
  "That Telegram account is not connected.": "Этот аккаунт Telegram не подключён.",
  "That Telegram account is not live in the plugin worker.": "Этот аккаунт Telegram сейчас не в сети.",
  "This text is a Paperclip operator note. Send one short plain customer reply with telegram_send_text. Do not include task ids, task links, task status, or the phrase «Ответил в Telegram».": "Это служебная заметка. Клиенту нужно короткое обычное сообщение без номеров задач, ссылок и фразы «Ответил в Telegram».",
};

function readUiLocale(): string {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return "";
    return storage.getItem(LOCALE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function isRuLocale(): boolean {
  return readUiLocale().toLowerCase().split("-")[0] === "ru";
}

export function uiText(text: string): string {
  if (!isRuLocale()) return text;
  return RU[text] ?? text;
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return uiText(error.message);
  }
  return error instanceof Error ? uiText(error.message) : uiText("Something went wrong.");
}
