#!/usr/bin/env python3
"""Add comprehensive Russian translations for ZAI-302."""

import json
from pathlib import Path

# Russian translations for 180+ missing keys
russian_translations = {
    # Issues namespace - IssueBlockedNotice, IssueChatThread, etc.
    'the_linked_issue': 'связанная задача',
    'the_linked_issues': 'связанные задачи',
    'this_issue_still_needs_a_next_step': 'Эта задача всё ещё нуждается в следующем шаге.',
    'a_run_finished_successfully_but_this_issue_is_still_open_in': 'Запуск завершился успешно, но задача всё ещё открыта в',
    'with_no_clear_owner_for_the_next_action': 'без чёткого владельца для следующего действия.',
    'mark_it_done_or_cancelled': 'Отметьте как выполнено или отменено.',
    'send_it_for_review_or_ask_for_input': 'Отправьте на проверку или запросите входные данные.',
    'mark_it_blocked_with_a_blocker_owner': 'Отметьте как заблокированное с владельцем блокировки.',
    'delegate_follow_up_work_or_queue_a_continuation': 'Делегируйте работу или поставьте в очередь продолжение.',
    'run': 'запуск',
    'corrective_wake_queued_for': 'Исправляющее пробуждение поставлено в очередь на',
    'detected_progress': 'Обнаружен прогресс:',
    'work_on_this_issue_is_blocked_by_label': 'Работа над задачей заблокирована {label}...',
    'work_on_this_issue_is_blocked_until_it_is_moved_back_to_todo': 'Работа над задачей заблокирована до переноса обратно в очередь выполнения.',
    'stalled_in_review': 'Застопорена на проверке',
    'ultimately_waiting_on': 'В конечном итоге ожидание',
    'blocked_by_parked_work': 'Блокирована припаркованной работой',
    'ran_n_command': 'выполнено {{count}} команд(ы)',
    'ran_command_one': 'выполнена 1 команда',
    'ran_command_other': 'выполнено {{count}} команд',
    'called_n_tool': 'вызвано {{count}} инструмент(ов)',
    'called_tool_one': 'вызван 1 инструмент',
    'called_tool_other': 'вызвано {{count}} инструментов',
    'working': 'Работает',
    'worked': 'Работало',
    'for_elapsed': 'на {{elapsed}}',
    '_deferred_wake': '⏸ Отложенное пробуждение',
    'queued': 'В очереди',
    'follow_up': 'Продолжение',
    'stop_run': 'Остановить запуск',
    'stopping': 'Остановка...',
    'agent': 'Агент',
    'copy_message': 'Скопировать сообщение',
    'copy': 'Копировать',
    'input': 'Ввод',
    'result': 'Результат',

    # More issue keys
    'updated_this_task': 'обновил эту задачу',
    'hide_confirmation': 'Скрыть подтверждение',
    'expired_confirmation': 'Истёкшее подтверждение',
    'requested_follow_up': 'запросил продолжение',
    'status_label': 'Статус',
    'assignee_label': 'Исполнитель',
    'monitor_scheduled': 'Мониторинг запланирован',
    'next_check': 'Следующая проверка',
    'attempt': 'Попытка',
    'checking': 'Проверка...',
    'check_now': 'Проверить сейчас',
    'copied': 'Скопировано!',
    'click_to_copy': 'Нажмите для копирования',
    'remove_blocker': 'Удалить блокировщик',
    'remove_blocker_q': 'Удалить блокировщик?',
    'cancel': 'Отмена',
    'none': 'Нет',
    'cheap_model': 'Дешевая модель',
    'primary_model': 'Основная модель',
    'model_lane': 'Уровень модели',
    'primary': 'Основная',
    'cheap': 'Дешевая',
    'custom': 'Пользовательская',
    'default_model': 'Модель по умолчанию',
    'search_models': 'Поиск моделей...',
    'no_models_found': 'Модели не найдены.',
    'thinking_effort': 'Усилие мышления',
    'enable_chrome': 'Включить Chrome (--chrome)',
    'clear_adapter_options': 'Очистить параметры адаптера',
    'what_should_the_agent_recheck': 'Что агент должен перепроверить?',
    'external_service': 'Внешний сервис',
    'schedule': 'Расписание',
    'clear': 'Очистить',
    'assignee': 'Исполнитель',
    'priority': 'Приоритет',
    'labels': 'Метки',
    'add_sub_issue': 'Добавить подзадачу',
    'planning': 'Планирование',
    'backlog': 'Невыполненные задачи',
    'todo': 'К выполнению',
    'in_progress': 'В процессе',
    'in_review': 'На проверке',
    'done': 'Завершено',
    'blocked': 'Заблокировано',
    'cancelled': 'Отменено',
    'next_up': 'Далее',
    'waiting_on_blockers': 'Ожидание блокировщиков',
    'no_active_sub_issues': 'Нет активных подзадач',
    'all_sub_issues_done': 'Все подзадачи выполнены',
    'no_actionable_sub_issues': 'Нет выполняемых подзадач',
    'new_issue': 'Новая задача',
    'create_issue': 'Создать задачу',
    'new_sub_issue': 'Новая подзадача',
    'create_sub_issue': 'Создать подзадачу',
    'for': 'Для',
    'in': 'В',
    'no_assignee': 'Без исполнителя',
    'search_assignees': 'Поиск исполнителей...',
    'no_assignees_found': 'Исполнители не найдены.',
    'search_projects': 'Поиск проектов...',
    'no_projects_found': 'Проекты не найдены.',
    'add_reviewer_or_approver': 'Добавить проверяющего или утверждающего',
    'reviewer': 'Проверяющий',
    'approver': 'Утверждающий',
    'sub_issue_of': 'Подзадача',
    'execution_workspace': 'Рабочее пространство выполнения',
    'choose_existing_workspace': 'Выберите существующее рабочее пространство',
    'parked_assignee_will_not_be_woken': 'Припаркована — исполнитель не будет разбужен',
    'executable_assignee_will_be_woken': 'Исполняемо — исполнитель будет разбужен',
    'project_default': 'По умолчанию проекта',
    'new_isolated_workspace': 'Новое изолированное рабочее пространство',
    'reuse_existing_workspace': 'Повторное использование существующего рабочего пространства',
    'issue_title': 'Заголовок задачи',
    'add_description': 'Добавить описание...',
    'add_label': 'Добавить метку',
    'search_labels': 'Поиск меток...',
    'creating': 'Создание...',
    'parked': 'Припаркована',
    'will_not_be_woken_until_status_changes_to': 'не будет разбужена до изменения статуса на',
    'resuming': 'Возобновление…',
    'resume_now': 'Возобновить сейчас',
    'productivity_review': 'Обзор продуктивности:',
    'productivity_review_open': 'Обзор продуктивности открыт',
    'mark_as_read': 'Отметить как прочитанное',
    'dismiss_from_inbox': 'Убрать из входящих',
    'continuation_scheduled': 'Продолжение запланировано',
    'retry_scheduled': 'Повторная попытка запланирована',
    'automatic_continuation': 'Автоматическое продолжение',
    'automatic_retry': 'Автоматическая повторная попытка',
    'due_now': 'Срок истёк',
    'pending_schedule': 'Ожидающее расписание',
    'pulls_continuation_forward_immediately': 'Немедленно переносит продолжение вперёд',
    'pulls_retry_forward_immediately': 'Немедленно переносит повторную попытку вперёд',
    'replaces_run': 'Заменяет запуск',
    'last_attempt_failed': 'Последняя попытка не удалась: {{error}}. Paperclip будет повторять попытки автоматически.',
    'retrying': 'Повторная попытка…',
    'already_promoted': 'Уже повышен',
    'promoted': 'Повышен',
    'retry_now': 'Повторить сейчас',
    'promoting_scheduled_retry': 'Повышение запланированной повторной попытки',
    'already_promoted_run_starting': 'Уже повышен — запуск начинается',
    'promoted_run_starting': 'Повышен — запуск начинается',
    'couldnt_retry_now': 'Не удалось повторить сейчас',
    'try_again': 'Попробовать снова',
    'no_issues_match_filters': 'Нет задач, соответствующих текущим фильтрам или поиску.',
    'loading_more_issues': 'Загрузка дополнительных задач...',
    'rendering_n_of_m': 'Отображение {{shown}} из {{total}} задач',
    'scroll_to_load_more': 'Прокрутите для загрузки дополнительных задач',
    'comments_still_wake_the_assignee_for_questions_or_triage_leave_this_parked_only_if_the_work_is_intentionally_on_hold': 'Комментарии всё ещё пробуждают исполнителя для вопросов или сортировки. Оставьте припаркованной только если работа намеренно приостановлена.',

    # Comments namespace
    'copy_failed': 'Ошибка копирования',
    'copy_comment_as_markdown': 'Скопировать комментарий как markdown',
    'environment': 'Окружение',
    'provider': 'Поставщик',
    'lease': 'Лизинг',
    'failure': 'Ошибка',
    'queued_comments': 'Комментарии в очереди ({{count}})',
    'interrupting': 'Прерывание...',
    'interrupt': 'Прервать',
    'leave_a_comment': 'Оставить комментарий...',
    'attach_image': 'Прикрепить изображение',
    'posting': 'Публикация...',
    'comment': 'Комментарий',
}

def apply_translations():
    """Apply Russian translations to issues.json and comments.json."""
    locales_dir = Path('ui/src/locales')

    # Update issues.json
    ru_issues_path = locales_dir / 'ru' / 'issues.json'
    with open(ru_issues_path, 'r', encoding='utf-8') as f:
        ru_issues = json.load(f)

    # Update comments.json
    ru_comments_path = locales_dir / 'ru' / 'comments.json'
    with open(ru_comments_path, 'r', encoding='utf-8') as f:
        ru_comments = json.load(f)

    # Apply translations
    updated_count = 0
    for key, translation in russian_translations.items():
        # Try issues first
        if key in ru_issues and ru_issues[key] == ru_issues.get(key, 'MISSING'):
            # Check if it's still English or missing
            if key not in ru_issues or ru_issues[key] in ('', key):
                ru_issues[key] = translation
                updated_count += 1

        # Try comments
        if key in ru_comments and ru_comments[key] == ru_comments.get(key, 'MISSING'):
            if key not in ru_comments or ru_comments[key] in ('', key):
                ru_comments[key] = translation
                updated_count += 1

    # Write back
    with open(ru_issues_path, 'w', encoding='utf-8') as f:
        json.dump(ru_issues, f, ensure_ascii=False, indent=2)

    with open(ru_comments_path, 'w', encoding='utf-8') as f:
        json.dump(ru_comments, f, ensure_ascii=False, indent=2)

    print(f"Added {updated_count} Russian translations")

if __name__ == '__main__':
    apply_translations()
