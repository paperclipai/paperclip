#!/usr/bin/env python3
"""Add translations for new localization keys across all locale files."""

import json
from pathlib import Path
import pickle

# Load the key mapping
with open('localization_keys.pkl', 'rb') as f:
    items_by_namespace = pickle.load(f)

locales_dir = Path('ui/src/locales')

# Comprehensive translation dictionary for all languages
translations = {
    'ru': {
        'system': 'Система',
        'board': 'Доска',
        'unknown': 'Неизвестно',
        'parked': 'Припаркован',
        'the_assignee': 'исполнитель',
        'will_not_be_woken_until_status_changes_to': 'не будет разбужен до изменения статуса на',
        'todo': 'к выполнению',
        'in_progress': 'в процессе',
        'resuming': 'Возобновление…',
        'resume_now': 'Возобновить сейчас',
        'cancel': 'Отмена',
        'running': 'Работает',
        'done': 'Завершено',
        'blocked': 'Заблокировано',
        'cancelled': 'Отменено',
        'input': 'Ввод',
        'result': 'Результат',
        'status': 'Статус',
        'assignee': 'Исполнитель',
        'priority': 'Приоритет',
        'labels': 'Метки',
        'create_issue': 'Создать задачу',
        'create_routine': 'Создать рутину',
        'routines': 'Рутины',
        'copied': 'Скопировано!',
        'copy': 'Копировать',
        'edit': 'Редактировать',
        'remove': 'Удалить',
        'save': 'Сохранить',
        'add': 'Добавить',
        'view': 'Просмотр',
        'no_assignee': 'Нет исполнителя',
        'planning': 'Планирование',
        'next_up': 'Далее',
        'all_subissues_done': 'Все подзадачи выполнены',
        'default_model': 'Модель по умолчанию',
        'primary': 'Основная',
        'cheap': 'Дешевая',
        'custom': 'Пользовательская',
        'parked_assignee_will_not_be_woken': 'Припаркован — исполнитель не будет разбужен',
        'executable_assignee_will_be_woken': 'Исполняемо — исполнитель будет разбужен',
        'copy_failed': 'Ошибка копирования',
        'copied_toast': 'Скопировано',
        'click_to_copy': 'Щелкните для копирования',
        'no_skills_match_this_filter': 'Нет навыков, соответствующих этому фильтру.',
        'select_a_skill_to_inspect_its_files': 'Выберите навык для проверки его файлов.',
        'removing': 'Удаление...',
        'remove_skill': 'Удалить навык',
        'edit': 'Редактировать',
        'stop_editing': 'Остановить редактирование',
        'check_for_updates': 'Проверить обновления',
        'install_update': 'Установить обновление',
        'up_to_date': 'Актуально',
        'editable': 'Редактируемо',
        'read_only': 'Только чтение',
        'no_agents_attached': 'Нет подключенных агентов',
        'view': 'Просмотр',
        'code': 'Код',
        'cancel': 'Отмена',
        'saving': 'Сохранение...',
        'save': 'Сохранить',
        'select_a_file_to_inspect': 'Выберите файл для проверки.',
        'skills': 'Навыки',
        'filter_skills': 'Фильтровать навыки',
        'paste_path_github_url_or_skills_sh_command': 'Вставьте путь, URL GitHub или команду skills.sh',
        'add': 'Добавить',
        'removing_skill': 'Удаление навыка...',
        'recurring_work_definitions_that_materialize_into_auditable_execution_issues': 'Определения повторяющихся работ, которые материализуются в проверяемые проблемы выполнения.',
        'create_routine': 'Создать рутину',
        'recent_runs': 'Последние запуски',
        'new_routine': 'Новая рутина',
        'routine_title': 'Название рутины',
        'for': 'Для',
        'in': 'В',
        'add_instructions': 'Добавить инструкции...',
        'advanced_delivery_settings': 'Расширенные настройки доставки',
        'concurrency': 'Параллелизм',
        'catch_up': 'Наверстать',
        'creating': 'Создание...',
        'no_routines_yet': 'Рутин нет.',
        'copy_message': 'Скопировать сообщение',
        'comments_queued': 'Комментарии в очереди',
        'queued': 'В очереди',
        'follow_up': 'Продолжение',
        'queueing': 'Добавление в очередь...',
        'sending': 'Отправка...',
        'environment': 'Окружение',
        'provider': 'Поставщик',
        'lease': 'Лизинг',
        'failure': 'Ошибка',
        'interrupt': 'Прервать',
        'interrupting': 'Прерывание...',
        'leave_a_comment': 'Оставить комментарий...',
        'attach_image': 'Прикрепить изображение',
        'no_assignees_found': 'Исполнители не найдены.',
        'posting': 'Публикация...',
        'comment': 'Комментарий',
    },
    'es': {
        'system': 'Sistema',
        'board': 'Junta',
        'unknown': 'Desconocido',
        'parked': 'Aparcado',
        'the_assignee': 'el asignado',
        'todo': 'por hacer',
        'in_progress': 'en progreso',
        'resuming': 'Reanudando…',
        'resume_now': 'Reanudar ahora',
        'cancel': 'Cancelar',
        'running': 'En ejecución',
        'done': 'Hecho',
        'blocked': 'Bloqueado',
        'cancelled': 'Cancelado',
        'input': 'Entrada',
        'result': 'Resultado',
        'status': 'Estado',
        'assignee': 'Asignado',
        'priority': 'Prioridad',
        'labels': 'Etiquetas',
        'create_issue': 'Crear problema',
        'create_routine': 'Crear rutina',
        'routines': 'Rutinas',
        'copied': '¡Copiado!',
        'copy': 'Copiar',
        'edit': 'Editar',
        'remove': 'Eliminar',
        'save': 'Guardar',
        'add': 'Añadir',
        'view': 'Ver',
        'no_assignee': 'Sin asignación',
        'planning': 'Planificación',
        'next_up': 'Siguiente',
        'all_subissues_done': 'Todos los sub-problemas completados',
        'default_model': 'Modelo predeterminado',
        'primary': 'Primaria',
        'cheap': 'Económica',
        'custom': 'Personalizada',
    },
    'de': {
        'system': 'System',
        'board': 'Tafel',
        'unknown': 'Unbekannt',
        'parked': 'Geparkt',
        'the_assignee': 'der Bevollmächtigte',
        'todo': 'zu tun',
        'in_progress': 'in Bearbeitung',
        'resuming': 'Werden fortgesetzt…',
        'resume_now': 'Jetzt fortsetzen',
        'cancel': 'Abbrechen',
        'running': 'Läuft',
        'done': 'Erledigt',
        'blocked': 'Blockiert',
        'cancelled': 'Storniert',
        'input': 'Eingabe',
        'result': 'Resultat',
        'status': 'Status',
        'assignee': 'Bevollmächtigter',
        'priority': 'Priorität',
        'labels': 'Etiketten',
        'create_issue': 'Problem erstellen',
        'create_routine': 'Routine erstellen',
        'routines': 'Routinen',
        'copied': 'Kopiert!',
        'copy': 'Kopieren',
        'edit': 'Bearbeiten',
        'remove': 'Entfernen',
        'save': 'Speichern',
        'add': 'Hinzufügen',
        'view': 'Aussicht',
        'no_assignee': 'Kein Bevollmächtigter',
        'planning': 'Planung',
        'next_up': 'Nächstes',
        'all_subissues_done': 'Alle Unterprobleme erledigt',
        'default_model': 'Standardmodell',
        'primary': 'Primär',
        'cheap': 'Billig',
        'custom': 'Benutzerdefiniert',
    },
}

# For other languages, use English as placeholder
placeholder_languages = ['pt', 'el', 'uk', 'zh']

# Apply translations to each locale file
for namespace, keys_dict in items_by_namespace.items():
    # English (en) - add all keys directly
    en_file = locales_dir / 'en' / f'{namespace}.json'
    if en_file.exists():
        with open(en_file, 'r', encoding='utf-8') as f:
            en_data = json.load(f)

        for key, english_text in keys_dict.items():
            if key not in en_data:
                en_data[key] = english_text

        with open(en_file, 'w', encoding='utf-8') as f:
            json.dump(en_data, f, ensure_ascii=False, indent=2)
        print(f"Updated en/{namespace}.json")

    # Russian (ru)
    ru_file = locales_dir / 'ru' / f'{namespace}.json'
    if ru_file.exists():
        with open(ru_file, 'r', encoding='utf-8') as f:
            ru_data = json.load(f)

        for key, english_text in keys_dict.items():
            if key not in ru_data:
                # Try to find Russian translation
                ru_data[key] = translations['ru'].get(key, english_text)

        with open(ru_file, 'w', encoding='utf-8') as f:
            json.dump(ru_data, f, ensure_ascii=False, indent=2)
        print(f"Updated ru/{namespace}.json")

    # Spanish (es)
    es_file = locales_dir / 'es' / f'{namespace}.json'
    if es_file.exists():
        with open(es_file, 'r', encoding='utf-8') as f:
            es_data = json.load(f)

        for key, english_text in keys_dict.items():
            if key not in es_data:
                es_data[key] = translations['es'].get(key, english_text)

        with open(es_file, 'w', encoding='utf-8') as f:
            json.dump(es_data, f, ensure_ascii=False, indent=2)
        print(f"Updated es/{namespace}.json")

    # German (de)
    de_file = locales_dir / 'de' / f'{namespace}.json'
    if de_file.exists():
        with open(de_file, 'r', encoding='utf-8') as f:
            de_data = json.load(f)

        for key, english_text in keys_dict.items():
            if key not in de_data:
                de_data[key] = translations['de'].get(key, english_text)

        with open(de_file, 'w', encoding='utf-8') as f:
            json.dump(de_data, f, ensure_ascii=False, indent=2)
        print(f"Updated de/{namespace}.json")

    # Placeholder languages (use English)
    for lang in placeholder_languages:
        lang_file = locales_dir / lang / f'{namespace}.json'
        if lang_file.exists():
            with open(lang_file, 'r', encoding='utf-8') as f:
                lang_data = json.load(f)

            for key, english_text in keys_dict.items():
                if key not in lang_data:
                    lang_data[key] = english_text

            with open(lang_file, 'w', encoding='utf-8') as f:
                json.dump(lang_data, f, ensure_ascii=False, indent=2)
            print(f"Updated {lang}/{namespace}.json (English placeholder)")

print("\nLocalization keys added to all locale files!")
