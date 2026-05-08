#!/usr/bin/env python3
import json
import os

# Comprehensive translations for all 7 locales
translations = {
    "de": {  # German
        "not_found": {
            "breadcrumb": "Nicht gefunden",
            "page_not_found": "Seite nicht gefunden",
            "company_not_found": "Unternehmen nicht gefunden",
            "no_company_prefix": "Kein Unternehmen passt zum Präfix \"{{prefix}}\".",
            "route_not_found": "Diese Route existiert nicht.",
            "requested_path": "Angeforderte Pfad",
            "open_dashboard": "Dashboard öffnen",
            "go_home": "Zur Startseite"
        },
        "projects_field": {
            "name": "Name",
            "name_placeholder": "Projektname",
            "description": "Beschreibung",
            "description_placeholder": "Beschreibung hinzufügen...",
            "no_description": "Keine Beschreibung",
            "status": "Status",
            "lead": "Leiter",
            "goals": "Ziele",
            "goal": "Ziel",
            "all_goals_linked": "Alle Ziele verknüpft.",
            "remove_goal_aria": "Ziel {{title}} entfernen",
            "env": "Umgebung",
            "env_hint": "Wird auf alle Läufe für Probleme in diesem Projekt angewendet. Projektwerte überschreiben Agent-Umgebung bei Schlüsselkonflikten.",
            "created": "Erstellt",
            "updated": "Aktualisiert",
            "target_date": "Zieldatum"
        },
        "projects_codebase": {
            "title": "Codebasis",
            "help_aria": "Codebasis-Hilfe",
            "help_tooltip": "Repository identifiziert die Quelle der Wahrheit. Lokaler Ordner ist der Standardort, an dem Agenten Code schreiben.",
            "repo": "Repository",
            "change_repo": "Repository ändern",
            "clear_repo_aria": "Repository löschen",
            "not_set": "Nicht gesetzt.",
            "set_repo": "Repository festlegen",
            "local_folder": "Lokaler Ordner",
            "managed_folder": "Von Paperclip verwalteter Ordner.",
            "change_local_folder": "Lokalen Ordner ändern",
            "set_local_folder": "Lokalen Ordner festlegen",
            "clear_local_folder_aria": "Lokalen Ordner löschen",
            "legacy_workspaces_notice": "Zusätzliche ältere Arbeitsbereichsdatensätze existieren in diesem Projekt. Paperclip verwendet den primären Arbeitsbereich als Codebasis-Ansicht.",
            "no_url": "Keine URL",
            "clear_local_confirm": "Lokalen Ordner aus diesem Arbeitsbereich löschen?",
            "delete_local_confirm": "Lokalen Ordner dieses Arbeitsbereichs löschen?",
            "clear_repo_confirm": "Repository aus diesem Arbeitsbereich löschen?",
            "delete_repo_confirm": "Repository dieses Arbeitsbereichs löschen?"
        },
        "projects_archive": {
            "description_archive": "Archivieren Sie dieses Projekt, um es in der Seitenleiste und Projektselektoren zu verbergen.",
            "description_unarchive": "Entarchivieren Sie dieses Projekt, um es in der Seitenleiste und Projektselektoren wiederherzustellen.",
            "archiving": "Wird archiviert...",
            "unarchiving": "Wird entarchiviert...",
            "confirm_archive_prompt": "\"{{name}}\" archivieren?",
            "confirm_unarchive_prompt": "\"{{name}}\" entarchivieren?",
            "archive_button": "Projekt archivieren",
            "unarchive_button": "Projekt entarchivieren"
        },
        "projects_execution": {
            "title": "Ausführungsarbeitsbereiche",
            "help_aria": "Hilfe zu Ausführungsarbeitsbereichen",
            "help_tooltip": "Projektverantwortete Standards für isolierte Problemüberprüfungen und Verhalten des Ausführungsarbeitsbereichs.",
            "enable_label": "Isolierte Problemüberprüfungen aktivieren",
            "enable_hint": "Ermöglichen Sie Problemen, zwischen der primären Überprüfung des Projekts und einem isolierten Ausführungsarbeitsbereich zu wählen.",
            "enabled": "Aktiviert",
            "disabled": "Deaktiviert",
            "default_isolated_label": "Neue Probleme verwenden standardmäßig isolierte Überprüfung",
            "default_isolated_hint": "Wenn deaktiviert, bleiben neue Probleme in der primären Überprüfung des Projekts, es sei denn, jemand meldet sich ab.",
            "hide_advanced": "Erweiterte Überprüfungseinstellungen ausblenden",
            "show_advanced": "Erweiterte Überprüfungseinstellungen anzeigen",
            "host_managed_label": "Von Host verwaltete Implementierung:",
            "git_worktree": "Git worktree",
            "environment": "Umgebung",
            "no_environment": "Keine Umgebung",
            "base_ref": "Basis-ref",
            "branch_template": "Branch-Vorlage",
            "worktree_parent_dir": "Worktree-Übergeordneter Ordner",
            "provision_command": "Provisioning-Befehl",
            "teardown_command": "Teardown-Befehl",
            "provision_teardown_hint": "Provisioning wird im abgeleiteten Worktree vor der Agent-Ausführung ausgeführt. Teardown wird hier für zukünftige Cleanup-Flows gespeichert."
        }
    },
    "el": {  # Greek
        "not_found": {
            "breadcrumb": "Δεν βρέθηκε",
            "page_not_found": "Η σελίδα δεν βρέθηκε",
            "company_not_found": "Η εταιρεία δεν βρέθηκε",
            "no_company_prefix": "Δεν υπάρχει εταιρεία που ταιριάζει με το πρόθεμα \"{{prefix}}\".",
            "route_not_found": "Αυτή η διαδρομή δεν υπάρχει.",
            "requested_path": "Ζητηθείσα διαδρομή",
            "open_dashboard": "Ανοίξτε τον πίνακα ελέγχου",
            "go_home": "Πήγαινε στο σπίτι"
        },
        "projects_field": {
            "name": "Όνομα",
            "name_placeholder": "Όνομα έργου",
            "description": "Περιγραφή",
            "description_placeholder": "Προσθέστε περιγραφή...",
            "no_description": "Χωρίς περιγραφή",
            "status": "Κατάσταση",
            "lead": "Αρχηγός",
            "goals": "Στόχοι",
            "goal": "Στόχος",
            "all_goals_linked": "Όλοι οι στόχοι συνδέονται.",
            "remove_goal_aria": "Αφαίρεση στόχου {{title}}",
            "env": "Περιβάλλον",
            "env_hint": "Εφαρμόζεται σε όλες τις εκτελέσεις για προβλήματα σε αυτό το έργο. Οι τιμές έργου παρακάμπτουν το περιβάλλον του πράκτορα σε διαφορές κλειδιών.",
            "created": "Δημιουργήθηκε",
            "updated": "Ενημερώθηκε",
            "target_date": "Ημερομηνία στόχου"
        },
        "projects_codebase": {
            "title": "Βάση κώδικα",
            "help_aria": "Βοήθεια βάσης κώδικα",
            "help_tooltip": "Το αποθετήριο προσδιορίζει την πηγή της αλήθειας. Ο τοπικός φάκελος είναι το προεπιλεγμένο μέρος όπου οι πράκτορες γράφουν κώδικα.",
            "repo": "Αποθετήριο",
            "change_repo": "Αλλαγή αποθετηρίου",
            "clear_repo_aria": "Εκκαθάριση αποθετηρίου",
            "not_set": "Δεν έχει οριστεί.",
            "set_repo": "Ορισμός αποθετηρίου",
            "local_folder": "Τοπικός φάκελος",
            "managed_folder": "Φάκελος διαχειρισμένος από το Paperclip.",
            "change_local_folder": "Αλλαγή τοπικού φακέλου",
            "set_local_folder": "Ορισμός τοπικού φακέλου",
            "clear_local_folder_aria": "Εκκαθάριση τοπικού φακέλου",
            "legacy_workspaces_notice": "Υπάρχουν πρόσθετες παλαιές εγγραφές χώρου εργασίας σε αυτό το έργο. Το Paperclip χρησιμοποιεί τον κύριο χώρο εργασίας ως την προβολή βάσης κώδικα.",
            "no_url": "Χωρίς URL",
            "clear_local_confirm": "Εκκαθάριση τοπικού φακέλου από αυτό το χώρο εργασίας;",
            "delete_local_confirm": "Διαγραφή τοπικού φακέλου αυτού του χώρου εργασίας;",
            "clear_repo_confirm": "Εκκαθάριση αποθετηρίου από αυτό το χώρο εργασίας;",
            "delete_repo_confirm": "Διαγραφή αποθετηρίου αυτού του χώρου εργασίας;"
        },
        "projects_archive": {
            "description_archive": "Αρχειοθετήστε αυτό το έργο για να το αποκρύψετε από την πλευρική γραμμή και τους επιλογές έργων.",
            "description_unarchive": "Επαναφέρετε αυτό το έργο στην πλευρική γραμμή και τους επιλογές έργων.",
            "archiving": "Αρχειοθέτηση...",
            "unarchiving": "Αποαρχειοθέτηση...",
            "confirm_archive_prompt": "Αρχειοθέτηση \"{{name}}\";",
            "confirm_unarchive_prompt": "Αποαρχειοθέτηση \"{{name}}\";",
            "archive_button": "Αρχειοθέτηση έργου",
            "unarchive_button": "Αποαρχειοθέτηση έργου"
        },
        "projects_execution": {
            "title": "Χώροι εργασίας εκτέλεσης",
            "help_aria": "Βοήθεια χώρων εργασίας εκτέλεσης",
            "help_tooltip": "Προεπιλογές ιδιοκτησίας έργου για απομονωμένες ελέγχους προβλημάτων και συμπεριφορά χώρου εργασίας εκτέλεσης.",
            "enable_label": "Ενεργοποίηση απομονωμένων ελέγχων προβλημάτων",
            "enable_hint": "Επιτρέψτε στα προβλήματα να επιλέγουν μεταξύ του κύριου ελέγχου του έργου και ενός απομονωμένου χώρου εργασίας εκτέλεσης.",
            "enabled": "Ενεργοποιημένο",
            "disabled": "Απενεργοποιημένο",
            "default_isolated_label": "Νέα προβλήματα χρησιμοποιούν προεπιλογή απομονωμένο έλεγχο",
            "default_isolated_hint": "Εάν απενεργοποιηθεί, τα νέα προβλήματα παραμένουν στον κύριο έλεγχο του έργου εκτός αν κάποιος αποχώρησε.",
            "hide_advanced": "Απόκρυψη σeinstellungen προχωρημένων ελέγχων",
            "show_advanced": "Εμφάνιση σeinstellungen προχωρημένων ελέγχων",
            "host_managed_label": "Υλοποίηση διαχειρισμένη από το κεντρικό σύστημα:",
            "git_worktree": "Git worktree",
            "environment": "Περιβάλλον",
            "no_environment": "Χωρίς περιβάλλον",
            "base_ref": "Βάση ref",
            "branch_template": "Πρότυπο κλάδου",
            "worktree_parent_dir": "Γονικός κατάλογος worktree",
            "provision_command": "Εντολή παροχής",
            "teardown_command": "Εντολή κατάργησης",
            "provision_teardown_hint": "Η παροχή εκτελείται μέσα στο προκύπτον worktree πριν από την εκτέλεση του πράκτορα. Η κατάργηση αποθηκεύεται εδώ για μελλοντικές ροές καθαρισμού."
        }
    },
    "es": {  # Spanish
        "not_found": {
            "breadcrumb": "No encontrado",
            "page_not_found": "Página no encontrada",
            "company_not_found": "Empresa no encontrada",
            "no_company_prefix": "Ninguna empresa coincide con el prefijo \"{{prefix}}\".",
            "route_not_found": "Esta ruta no existe.",
            "requested_path": "Ruta solicitada",
            "open_dashboard": "Abrir panel de control",
            "go_home": "Ir a inicio"
        },
        "projects_field": {
            "name": "Nombre",
            "name_placeholder": "Nombre del proyecto",
            "description": "Descripción",
            "description_placeholder": "Agregar descripción...",
            "no_description": "Sin descripción",
            "status": "Estado",
            "lead": "Líder",
            "goals": "Objetivos",
            "goal": "Objetivo",
            "all_goals_linked": "Todos los objetivos vinculados.",
            "remove_goal_aria": "Eliminar objetivo {{title}}",
            "env": "Entorno",
            "env_hint": "Se aplica a todas las ejecuciones para problemas en este proyecto. Los valores del proyecto anulan el entorno del agente en conflictos de claves.",
            "created": "Creado",
            "updated": "Actualizado",
            "target_date": "Fecha objetivo"
        },
        "projects_codebase": {
            "title": "Base de código",
            "help_aria": "Ayuda de base de código",
            "help_tooltip": "El repositorio identifica la fuente de verdad. La carpeta local es el lugar predeterminado donde los agentes escriben código.",
            "repo": "Repositorio",
            "change_repo": "Cambiar repositorio",
            "clear_repo_aria": "Borrar repositorio",
            "not_set": "No establecido.",
            "set_repo": "Establecer repositorio",
            "local_folder": "Carpeta local",
            "managed_folder": "Carpeta administrada por Paperclip.",
            "change_local_folder": "Cambiar carpeta local",
            "set_local_folder": "Establecer carpeta local",
            "clear_local_folder_aria": "Borrar carpeta local",
            "legacy_workspaces_notice": "Existen registros de espacio de trabajo heredado adicionales en este proyecto. Paperclip utiliza el espacio de trabajo principal como vista de base de código.",
            "no_url": "Sin URL",
            "clear_local_confirm": "¿Borrar carpeta local de este espacio de trabajo?",
            "delete_local_confirm": "¿Eliminar carpeta local de este espacio de trabajo?",
            "clear_repo_confirm": "¿Borrar repositorio de este espacio de trabajo?",
            "delete_repo_confirm": "¿Eliminar repositorio de este espacio de trabajo?"
        },
        "projects_archive": {
            "description_archive": "Archiva este proyecto para ocultarlo de la barra lateral y los selectores de proyectos.",
            "description_unarchive": "Desarchiva este proyecto para restaurarlo en la barra lateral y los selectores de proyectos.",
            "archiving": "Archivando...",
            "unarchiving": "Desarchivando...",
            "confirm_archive_prompt": "¿Archivar \"{{name}}\"?",
            "confirm_unarchive_prompt": "¿Desarchivar \"{{name}}\"?",
            "archive_button": "Archivar proyecto",
            "unarchive_button": "Desarchivar proyecto"
        },
        "projects_execution": {
            "title": "Espacios de trabajo de ejecución",
            "help_aria": "Ayuda de espacios de trabajo de ejecución",
            "help_tooltip": "Valores predeterminados propiedad del proyecto para desprotecciones aisladas de problemas y comportamiento del espacio de trabajo de ejecución.",
            "enable_label": "Habilitar desprotecciones aisladas de problemas",
            "enable_hint": "Permitir que los problemas elijan entre la desprotección principal del proyecto y un espacio de trabajo de ejecución aislado.",
            "enabled": "Habilitado",
            "disabled": "Deshabilitado",
            "default_isolated_label": "Los nuevos problemas usan desprotección aislada de forma predeterminada",
            "default_isolated_hint": "Si se deshabilita, los nuevos problemas permanecen en la desprotección principal del proyecto a menos que alguien opte por no participar.",
            "hide_advanced": "Ocultar configuración avanzada de desprotección",
            "show_advanced": "Mostrar configuración avanzada de desprotección",
            "host_managed_label": "Implementación administrada por host:",
            "git_worktree": "Git worktree",
            "environment": "Entorno",
            "no_environment": "Sin entorno",
            "base_ref": "Referencia base",
            "branch_template": "Plantilla de rama",
            "worktree_parent_dir": "Directorio padre de worktree",
            "provision_command": "Comando de aprovisionamiento",
            "teardown_command": "Comando de limpieza",
            "provision_teardown_hint": "El aprovisionamiento se ejecuta dentro del worktree derivado antes de la ejecución del agente. La limpieza se almacena aquí para futuros flujos de limpieza."
        }
    },
    "pt": {  # Portuguese
        "not_found": {
            "breadcrumb": "Não encontrado",
            "page_not_found": "Página não encontrada",
            "company_not_found": "Empresa não encontrada",
            "no_company_prefix": "Nenhuma empresa corresponde ao prefixo \"{{prefix}}\".",
            "route_not_found": "Esta rota não existe.",
            "requested_path": "Caminho solicitado",
            "open_dashboard": "Abrir painel de controle",
            "go_home": "Ir para casa"
        },
        "projects_field": {
            "name": "Nome",
            "name_placeholder": "Nome do projeto",
            "description": "Descrição",
            "description_placeholder": "Adicionar descrição...",
            "no_description": "Sem descrição",
            "status": "Status",
            "lead": "Líder",
            "goals": "Objetivos",
            "goal": "Objetivo",
            "all_goals_linked": "Todos os objetivos vinculados.",
            "remove_goal_aria": "Remover objetivo {{title}}",
            "env": "Ambiente",
            "env_hint": "Aplicado a todas as execuções para problemas neste projeto. Os valores do projeto substituem o ambiente do agente em conflitos de chaves.",
            "created": "Criado",
            "updated": "Atualizado",
            "target_date": "Data de destino"
        },
        "projects_codebase": {
            "title": "Base de código",
            "help_aria": "Ajuda da base de código",
            "help_tooltip": "O repositório identifica a fonte da verdade. A pasta local é o local padrão onde os agentes escrevem código.",
            "repo": "Repositório",
            "change_repo": "Alterar repositório",
            "clear_repo_aria": "Limpar repositório",
            "not_set": "Não definido.",
            "set_repo": "Definir repositório",
            "local_folder": "Pasta local",
            "managed_folder": "Pasta gerenciada por Paperclip.",
            "change_local_folder": "Alterar pasta local",
            "set_local_folder": "Definir pasta local",
            "clear_local_folder_aria": "Limpar pasta local",
            "legacy_workspaces_notice": "Registros de espaço de trabalho herdado adicional existem neste projeto. O Paperclip usa o espaço de trabalho principal como visualização de base de código.",
            "no_url": "Sem URL",
            "clear_local_confirm": "Limpar pasta local deste espaço de trabalho?",
            "delete_local_confirm": "Excluir pasta local deste espaço de trabalho?",
            "clear_repo_confirm": "Limpar repositório deste espaço de trabalho?",
            "delete_repo_confirm": "Excluir repositório deste espaço de trabalho?"
        },
        "projects_archive": {
            "description_archive": "Arquive este projeto para ocultá-lo da barra lateral e dos seletores de projetos.",
            "description_unarchive": "Desarchive este projeto para restaurá-lo na barra lateral e nos seletores de projetos.",
            "archiving": "Arquivando...",
            "unarchiving": "Desarchivando...",
            "confirm_archive_prompt": "Arquivar \"{{name}}\"?",
            "confirm_unarchive_prompt": "Desarquivar \"{{name}}\"?",
            "archive_button": "Arquivar projeto",
            "unarchive_button": "Desarquivar projeto"
        },
        "projects_execution": {
            "title": "Espaços de trabalho de execução",
            "help_aria": "Ajuda de espaços de trabalho de execução",
            "help_tooltip": "Padrões de propriedade do projeto para checkouts isolados de problemas e comportamento de espaço de trabalho de execução.",
            "enable_label": "Habilitar checkouts isolados de problemas",
            "enable_hint": "Permita que os problemas escolham entre o checkout principal do projeto e um espaço de trabalho de execução isolado.",
            "enabled": "Habilitado",
            "disabled": "Desabilitado",
            "default_isolated_label": "Novos problemas usam checkout isolado por padrão",
            "default_isolated_hint": "Se desabilitado, novos problemas permanecerão no checkout principal do projeto, a menos que alguém opte por não participar.",
            "hide_advanced": "Ocultar configurações avançadas de checkout",
            "show_advanced": "Mostrar configurações avançadas de checkout",
            "host_managed_label": "Implementação gerenciada pelo host:",
            "git_worktree": "Git worktree",
            "environment": "Ambiente",
            "no_environment": "Sem ambiente",
            "base_ref": "Ref base",
            "branch_template": "Modelo de ramificação",
            "worktree_parent_dir": "Diretório pai do worktree",
            "provision_command": "Comando de provisionamento",
            "teardown_command": "Comando de limpeza",
            "provision_teardown_hint": "O provisionamento é executado dentro do worktree derivado antes da execução do agente. A limpeza é armazenada aqui para fluxos de limpeza futuros."
        }
    },
    "ru": {  # Russian
        "not_found": {
            "breadcrumb": "Не найдено",
            "page_not_found": "Страница не найдена",
            "company_not_found": "Компания не найдена",
            "no_company_prefix": "Нет компании, соответствующей префиксу \"{{prefix}}\".",
            "route_not_found": "Этот маршрут не существует.",
            "requested_path": "Запрашиваемый путь",
            "open_dashboard": "Открыть панель управления",
            "go_home": "На главную"
        },
        "projects_field": {
            "name": "Название",
            "name_placeholder": "Название проекта",
            "description": "Описание",
            "description_placeholder": "Добавить описание...",
            "no_description": "Нет описания",
            "status": "Статус",
            "lead": "Руководитель",
            "goals": "Цели",
            "goal": "Цель",
            "all_goals_linked": "Все цели связаны.",
            "remove_goal_aria": "Удалить цель {{title}}",
            "env": "Окружение",
            "env_hint": "Применяется ко всем запускам задач в этом проекте. Значения проекта переопределяют окружение агента при конфликтах ключей.",
            "created": "Создано",
            "updated": "Обновлено",
            "target_date": "Целевая дата"
        },
        "projects_codebase": {
            "title": "Кодовая база",
            "help_aria": "Помощь по кодовой базе",
            "help_tooltip": "Репозиторий определяет источник истины. Локальная папка — это место по умолчанию, где агенты пишут код.",
            "repo": "Репозиторий",
            "change_repo": "Изменить репозиторий",
            "clear_repo_aria": "Очистить репозиторий",
            "not_set": "Не установлено.",
            "set_repo": "Установить репозиторий",
            "local_folder": "Локальная папка",
            "managed_folder": "Папка управляемая Paperclip.",
            "change_local_folder": "Изменить локальную папку",
            "set_local_folder": "Установить локальную папку",
            "clear_local_folder_aria": "Очистить локальную папку",
            "legacy_workspaces_notice": "На этом проекте существуют дополнительные устаревшие записи рабочих пространств. Paperclip использует основное рабочее пространство как представление кодовой базы.",
            "no_url": "Нет URL",
            "clear_local_confirm": "Очистить локальную папку от этого рабочего пространства?",
            "delete_local_confirm": "Удалить локальную папку этого рабочего пространства?",
            "clear_repo_confirm": "Очистить репозиторий от этого рабочего пространства?",
            "delete_repo_confirm": "Удалить репозиторий этого рабочего пространства?"
        },
        "projects_archive": {
            "description_archive": "Архивировать этот проект, чтобы скрыть его в боковой панели и селекторах проектов.",
            "description_unarchive": "Разархивировать этот проект для восстановления в боковой панели и селекторах проектов.",
            "archiving": "Архивирование...",
            "unarchiving": "Разархивирование...",
            "confirm_archive_prompt": "Архивировать \"{{name}}\"?",
            "confirm_unarchive_prompt": "Разархивировать \"{{name}}\"?",
            "archive_button": "Архивировать проект",
            "unarchive_button": "Разархивировать проект"
        },
        "projects_execution": {
            "title": "Рабочие пространства выполнения",
            "help_aria": "Помощь по рабочим пространствам выполнения",
            "help_tooltip": "Значения по умолчанию для изолированных контрольных точек задач и поведения рабочего пространства выполнения.",
            "enable_label": "Включить изолированные контрольные точки задач",
            "enable_hint": "Позвольте задачам выбирать между основной контрольной точкой проекта и изолированным рабочим пространством выполнения.",
            "enabled": "Включено",
            "disabled": "Отключено",
            "default_isolated_label": "Новые задачи по умолчанию используют изолированную контрольную точку",
            "default_isolated_hint": "Если отключено, новые задачи остаются на основной контрольной точке проекта, если кто-то не откажется от этого.",
            "hide_advanced": "Скрыть расширенные параметры контрольной точки",
            "show_advanced": "Показать расширенные параметры контрольной точки",
            "host_managed_label": "Реализация управляемая хостом:",
            "git_worktree": "Git worktree",
            "environment": "Окружение",
            "no_environment": "Нет окружения",
            "base_ref": "Базовый ref",
            "branch_template": "Шаблон ветки",
            "worktree_parent_dir": "Родительская папка worktree",
            "provision_command": "Команда подготовки",
            "teardown_command": "Команда очистки",
            "provision_teardown_hint": "Подготовка выполняется внутри полученного worktree перед выполнением агента. Очистка сохраняется здесь для будущих потоков очистки."
        }
    },
    "uk": {  # Ukrainian
        "not_found": {
            "breadcrumb": "Не знайдено",
            "page_not_found": "Сторінку не знайдено",
            "company_not_found": "Компанію не знайдено",
            "no_company_prefix": "Немає компанії, яка відповідає префіксу \"{{prefix}}\".",
            "route_not_found": "Цей маршрут не існує.",
            "requested_path": "Запитаний шлях",
            "open_dashboard": "Відкрити панель керування",
            "go_home": "На головну"
        },
        "projects_field": {
            "name": "Назва",
            "name_placeholder": "Назва проекту",
            "description": "Опис",
            "description_placeholder": "Додайте опис...",
            "no_description": "Без опису",
            "status": "Статус",
            "lead": "Керівник",
            "goals": "Цілі",
            "goal": "Ціль",
            "all_goals_linked": "Усі цілі пов'язані.",
            "remove_goal_aria": "Видалити ціль {{title}}",
            "env": "Середовище",
            "env_hint": "Застосовується до всіх запусків для проблем у цьому проекті. Значення проекту замінюють середовище агента при конфліктах ключів.",
            "created": "Створено",
            "updated": "Оновлено",
            "target_date": "Цільова дата"
        },
        "projects_codebase": {
            "title": "Кодова база",
            "help_aria": "Довідка з кодової бази",
            "help_tooltip": "Репозиторій визначає джерело істини. Локальна папка — це місце за замовчуванням, де агенти пишуть код.",
            "repo": "Репозиторій",
            "change_repo": "Змінити репозиторій",
            "clear_repo_aria": "Очистити репозиторій",
            "not_set": "Не встановлено.",
            "set_repo": "Установити репозиторій",
            "local_folder": "Локальна папка",
            "managed_folder": "Папка керована Paperclip.",
            "change_local_folder": "Змінити локальну папку",
            "set_local_folder": "Установити локальну папку",
            "clear_local_folder_aria": "Очистити локальну папку",
            "legacy_workspaces_notice": "На цьому проекті існують додаткові застарілі записи робочих просторів. Paperclip використовує основний робочий простір як подання кодової бази.",
            "no_url": "Немає URL",
            "clear_local_confirm": "Очистити локальну папку з цього робочого простору?",
            "delete_local_confirm": "Видалити локальну папку цього робочого простору?",
            "clear_repo_confirm": "Очистити репозиторій з цього робочого простору?",
            "delete_repo_confirm": "Видалити репозиторій цього робочого простору?"
        },
        "projects_archive": {
            "description_archive": "Архівуйте цей проект, щоб приховати його в бічній панелі та селекторах проектів.",
            "description_unarchive": "Розархівуйте цей проект, щоб відновити його в бічній панелі та селекторах проектів.",
            "archiving": "Архівування...",
            "unarchiving": "Розархівування...",
            "confirm_archive_prompt": "Архівувати \"{{name}}\"?",
            "confirm_unarchive_prompt": "Розархівувати \"{{name}}\"?",
            "archive_button": "Архівувати проект",
            "unarchive_button": "Розархівувати проект"
        },
        "projects_execution": {
            "title": "Робочі простори виконання",
            "help_aria": "Довідка з робочих просторів виконання",
            "help_tooltip": "Значення за замовчуванням, принадлежні проекту, для виділених перевірок проблем і поведінки робочого простору виконання.",
            "enable_label": "Включити виділені перевірки проблем",
            "enable_hint": "Дозвольте проблемам вибирати між основною перевіркою проекту та виділеним робочим простором виконання.",
            "enabled": "Включено",
            "disabled": "Вимкнено",
            "default_isolated_label": "Нові проблеми за замовчуванням використовують виділену перевірку",
            "default_isolated_hint": "Якщо вимкнено, нові проблеми залишаються на основній перевірці проекту, якщо хтось не відмовиться.",
            "hide_advanced": "Приховати розширені параметри перевірки",
            "show_advanced": "Показати розширені параметри перевірки",
            "host_managed_label": "Реалізація керована хостом:",
            "git_worktree": "Git worktree",
            "environment": "Середовище",
            "no_environment": "Без середовища",
            "base_ref": "Базовий ref",
            "branch_template": "Шаблон гілки",
            "worktree_parent_dir": "Батьківська папка worktree",
            "provision_command": "Команда підготовки",
            "teardown_command": "Команда очищення",
            "provision_teardown_hint": "Підготовка виконується всередину одержаного worktree перед виконанням агента. Очищення зберігається тут для майбутніх потоків очищення."
        }
    },
    "zh": {  # Simplified Chinese
        "not_found": {
            "breadcrumb": "未找到",
            "page_not_found": "页面未找到",
            "company_not_found": "公司未找到",
            "no_company_prefix": "没有匹配前缀"{{prefix}}"的公司。",
            "route_not_found": "此路由不存在。",
            "requested_path": "请求的路径",
            "open_dashboard": "打开仪表板",
            "go_home": "回家"
        },
        "projects_field": {
            "name": "名称",
            "name_placeholder": "项目名称",
            "description": "描述",
            "description_placeholder": "添加描述...",
            "no_description": "无描述",
            "status": "状态",
            "lead": "负责人",
            "goals": "目标",
            "goal": "目标",
            "all_goals_linked": "所有目标已链接。",
            "remove_goal_aria": "删除目标 {{title}}",
            "env": "环境",
            "env_hint": "应用于此项目中问题的所有运行。项目值在键冲突时覆盖代理环境。",
            "created": "创建于",
            "updated": "更新于",
            "target_date": "目标日期"
        },
        "projects_codebase": {
            "title": "代码库",
            "help_aria": "代码库帮助",
            "help_tooltip": "仓库标识真相来源。本地文件夹是代理编写代码的默认位置。",
            "repo": "仓库",
            "change_repo": "更改仓库",
            "clear_repo_aria": "清除仓库",
            "not_set": "未设置。",
            "set_repo": "设置仓库",
            "local_folder": "本地文件夹",
            "managed_folder": "Paperclip 管理的文件夹。",
            "change_local_folder": "更改本地文件夹",
            "set_local_folder": "设置本地文件夹",
            "clear_local_folder_aria": "清除本地文件夹",
            "legacy_workspaces_notice": "此项目上存在其他旧版工作区记录。Paperclip 将主工作区用作代码库视图。",
            "no_url": "无 URL",
            "clear_local_confirm": "清除此工作区的本地文件夹？",
            "delete_local_confirm": "删除此工作区的本地文件夹？",
            "clear_repo_confirm": "清除此工作区的仓库？",
            "delete_repo_confirm": "删除此工作区的仓库？"
        },
        "projects_archive": {
            "description_archive": "归档此项目以将其从侧边栏和项目选择器中隐藏。",
            "description_unarchive": "取消归档此项目以在侧边栏和项目选择器中恢复它。",
            "archiving": "正在归档...",
            "unarchiving": "正在取消归档...",
            "confirm_archive_prompt": "归档"{{name}}"?",
            "confirm_unarchive_prompt": "取消归档"{{name}}"?",
            "archive_button": "归档项目",
            "unarchive_button": "取消归档项目"
        },
        "projects_execution": {
            "title": "执行工作区",
            "help_aria": "执行工作区帮助",
            "help_tooltip": "项目所有的隔离问题检查和执行工作区行为的默认值。",
            "enable_label": "启用隔离问题检查",
            "enable_hint": "允许问题在项目的主要检查和隔离执行工作区之间选择。",
            "enabled": "已启用",
            "disabled": "已禁用",
            "default_isolated_label": "新问题默认使用隔离检查",
            "default_isolated_hint": "如果禁用，新问题将保留在项目的主要检查上，除非有人选择退出。",
            "hide_advanced": "隐藏高级检查设置",
            "show_advanced": "显示高级检查设置",
            "host_managed_label": "主机管理的实现：",
            "git_worktree": "Git worktree",
            "environment": "环境",
            "no_environment": "无环境",
            "base_ref": "基础 ref",
            "branch_template": "分支模板",
            "worktree_parent_dir": "Worktree 父目录",
            "provision_command": "配置命令",
            "teardown_command": "清理命令",
            "provision_teardown_hint": "配置在代理执行之前在派生的 worktree 内运行。清理存储在此处以供将来的清理流使用。"
        }
    }
}

# Map locale-code to locale names
locale_files = {
    "de": "de",
    "el": "el",
    "es": "es",
    "pt": "pt",
    "ru": "ru",
    "uk": "uk",
    "zh": "zh"
}

def update_locale_file(locale_code, trans_data):
    """Update a single locale file with translations"""
    file_path = f"ui/src/locales/{locale_code}/common.json"

    with open(file_path, 'r', encoding='utf-8') as f:
        content = json.load(f)

    # Update not_found section
    if "not_found" in trans_data:
        content["not_found"].update(trans_data["not_found"])

    # Update projects.field section
    if "projects_field" in trans_data:
        if "projects" not in content:
            content["projects"] = {}
        if "field" not in content["projects"]:
            content["projects"]["field"] = {}
        content["projects"]["field"].update(trans_data["projects_field"])

    # Update projects.codebase section
    if "projects_codebase" in trans_data:
        if "projects" not in content:
            content["projects"] = {}
        if "codebase" not in content["projects"]:
            content["projects"]["codebase"] = {}
        content["projects"]["codebase"].update(trans_data["projects_codebase"])

    # Update projects.archive section
    if "projects_archive" in trans_data:
        if "projects" not in content:
            content["projects"] = {}
        if "archive" not in content["projects"]:
            content["projects"]["archive"] = {}
        content["projects"]["archive"].update(trans_data["projects_archive"])

    # Update projects.execution section
    if "projects_execution" in trans_data:
        if "projects" not in content:
            content["projects"] = {}
        if "execution" not in content["projects"]:
            content["projects"]["execution"] = {}
        content["projects"]["execution"].update(trans_data["projects_execution"])

    with open(file_path, 'w', encoding='utf-8') as f:
        json.dump(content, f, ensure_ascii=False, indent=2)

    print(f"Updated {locale_code} locale file")

# Apply translations to all locales
for locale_code, locale_name in locale_files.items():
    if locale_code in translations:
        update_locale_file(locale_name, translations[locale_code])

print("All translations applied successfully!")
