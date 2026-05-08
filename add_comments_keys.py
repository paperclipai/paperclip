#!/usr/bin/env python3
"""Add missing comments namespace keys to all locale files."""

import json
from pathlib import Path

# New keys to add to comments namespace
NEW_KEYS = {
    "en": {
        "comment_input_placeholder": "Leave a comment...",
        "attach_image": "Attach image",
        "no_assignee": "No assignee",
        "search_assignees": "Search assignees...",
        "no_assignees_found": "No assignees found.",
        "comment_button": "Comment",
        "posting": "Posting...",
    },
    "ru": {
        "comment_input_placeholder": "Оставить комментарий...",
        "attach_image": "Прикрепить изображение",
        "no_assignee": "Нет исполнителя",
        "search_assignees": "Поиск исполнителей...",
        "no_assignees_found": "Исполнители не найдены.",
        "comment_button": "Комментарий",
        "posting": "Отправка...",
    },
    "de": {
        "comment_input_placeholder": "Einen Kommentar hinterlassen...",
        "attach_image": "Bild anhängen",
        "no_assignee": "Kein Beauftrager",
        "search_assignees": "Bevollmächtigte durchsuchen...",
        "no_assignees_found": "Keine Bevollmächtigten gefunden.",
        "comment_button": "Kommentar",
        "posting": "Wird gesendet...",
    },
    "es": {
        "comment_input_placeholder": "Dejar un comentario...",
        "attach_image": "Adjuntar imagen",
        "no_assignee": "Sin asignado",
        "search_assignees": "Buscar asignados...",
        "no_assignees_found": "No se encontraron asignados.",
        "comment_button": "Comentario",
        "posting": "Publicando...",
    },
    "pt": {
        "comment_input_placeholder": "Deixar um comentário...",
        "attach_image": "Anexar imagem",
        "no_assignee": "Sem assignado",
        "search_assignees": "Procurar assignados...",
        "no_assignees_found": "Nenhum assignado encontrado.",
        "comment_button": "Comentário",
        "posting": "Publicando...",
    },
    "el": {
        "comment_input_placeholder": "Αφήστε ένα σχόλιο...",
        "attach_image": "Επισύναψη εικόνας",
        "no_assignee": "Χωρίς ανάθετο",
        "search_assignees": "Αναζήτηση αναθέτων...",
        "no_assignees_found": "Δεν βρέθησαν αναθέτες.",
        "comment_button": "Σχόλιο",
        "posting": "Αποστολή...",
    },
    "uk": {
        "comment_input_placeholder": "Залишити коментар...",
        "attach_image": "Прикріпити зображення",
        "no_assignee": "Немає виконавця",
        "search_assignees": "Пошук виконавців...",
        "no_assignees_found": "Виконавців не знайдено.",
        "comment_button": "Коментар",
        "posting": "Відправлення...",
    },
    "zh": {
        "comment_input_placeholder": "留下评论...",
        "attach_image": "附加图像",
        "no_assignee": "无分配人",
        "search_assignees": "搜索分配人...",
        "no_assignees_found": "未找到分配人。",
        "comment_button": "评论",
        "posting": "发布中...",
    },
}

locales_dir = Path("ui/src/locales")

for lang_code, new_keys in NEW_KEYS.items():
    comments_file = locales_dir / lang_code / "comments.json"

    if not comments_file.exists():
        print(f"Warning: {comments_file} does not exist")
        continue

    with open(comments_file, "r", encoding="utf-8-sig") as f:
        data = json.load(f)

    # Add new keys at top level
    for key, value in new_keys.items():
        if key not in data:
            data[key] = value
            print(f"Added {lang_code}/comments.json: {key}")
        else:
            print(f"Skipped {lang_code}/comments.json: {key} (already exists)")

    with open(comments_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"Updated {comments_file}\n")

print("Comments translation keys update complete!")
