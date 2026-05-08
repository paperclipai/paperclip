// One-time script: fill common.json gaps for de (234 keys)
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
      result[key] = deepMerge(typeof result[key] === 'object' && result[key] !== null ? result[key] : {}, source[key]);
    } else if (!(key in result)) {
      result[key] = source[key];
    }
  }
  return result;
}

function fill(locale, filename, patch) {
  const path = join(__dirname, locale, filename);
  const existing = JSON.parse(readFileSync(path, 'utf8'));
  const merged = deepMerge(existing, patch);
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  console.log(`✓ ${locale}/${filename}`);
}

const DE_PATCH = {
  status_labels: {
    running: "Läuft",
    succeeded: "Erfolgreich",
    failed: "Fehlgeschlagen",
    errored: "Fehlerhaft",
    queued: "In Warteschlange",
    timed_out: "Zeitüberschreitung",
    skipped: "Übersprungen",
    completed: "Abgeschlossen",
    pending: "Ausstehend",
    active: "Aktiv",
    paused: "Pausiert",
    idle: "Inaktiv",
    terminated: "Beendet",
    archived: "Archiviert",
    cleanup_failed: "Bereinigung fehlgeschlagen"
  },
  projects: {
    danger_zone: "Gefahrenzone",
    add_project: "Projekt hinzufügen",
    no_projects: "Noch keine Projekte.",
    select_company_for_projects: "Wählen Sie ein Unternehmen, um Projekte anzuzeigen.",
    statuses: {
      backlog: "Rückstand",
      planned: "Geplant",
      in_progress: "In Bearbeitung",
      completed: "Abgeschlossen",
      cancelled: "Abgebrochen"
    },
    save_indicator: {
      saving: "Wird gespeichert",
      saved: "Gespeichert",
      failed: "Fehlgeschlagen"
    },
    field: {
      name: "Name",
      name_placeholder: "Projektname",
      description: "Beschreibung",
      description_placeholder: "Beschreibung hinzufügen...",
      no_description: "Keine Beschreibung",
      status: "Status",
      lead: "Verantwortlicher",
      goals: "Ziele",
      goal: "Ziel",
      all_goals_linked: "Alle Ziele sind bereits verknüpft.",
      remove_goal_aria: "Ziel {{title}} entfernen",
      env: "Env",
      env_hint: "Gilt für alle Aufgabenausführungen in diesem Projekt. Projektwerte überschreiben das Env des Agenten bei Schlüsselkonflikten.",
      created: "Erstellt",
      updated: "Aktualisiert",
      target_date: "Zieldatum"
    },
    errors: {
      select_company_for_secrets: "Wählen Sie ein Unternehmen, um Geheimnisse zu erstellen",
      local_folder_absolute: "Der lokale Ordner muss ein vollständiger absoluter Pfad sein.",
      repo_url_invalid: "Verwenden Sie eine gültige GitHub- oder GitHub Enterprise-Repository-URL.",
      workspace_save_failed: "Arbeitsbereich konnte nicht gespeichert werden.",
      workspace_delete_failed: "Arbeitsbereich konnte nicht gelöscht werden.",
      workspace_update_failed: "Arbeitsbereich konnte nicht aktualisiert werden."
    },
    codebase: {
      title: "Codebase",
      help_aria: "Hilfe zur Codebase",
      help_tooltip: "Das Repository ist die Quelle der Wahrheit. Der lokale Ordner ist der Standardort, in den Agenten Code schreiben.",
      repo: "Repository",
      change_repo: "Repository ändern",
      clear_repo_aria: "Repository löschen",
      not_set: "Nicht gesetzt.",
      set_repo: "Repository festlegen",
      local_folder: "Lokaler Ordner",
      managed_folder: "Von Paperclip verwalteter Ordner.",
      change_local_folder: "Lokalen Ordner ändern",
      set_local_folder: "Lokalen Ordner festlegen",
      clear_local_folder_aria: "Lokalen Ordner löschen",
      legacy_workspaces_notice: "Dieses Projekt hat zusätzliche veraltete Workspace-Einträge. Paperclip verwendet den primären Workspace als Darstellung der Codebase.",
      no_url: "Keine URL",
      clear_local_confirm: "Lokalen Ordner aus diesem Workspace entfernen?",
      delete_local_confirm: "Lokalen Ordner dieses Workspace löschen?",
      clear_repo_confirm: "Repository aus diesem Workspace entfernen?",
      delete_repo_confirm: "Repository dieses Workspace löschen?"
    },
    archive: {
      description_archive: "Archivieren Sie das Projekt, um es aus der Seitenleiste und Projektauswahlfeldern auszublenden.",
      description_unarchive: "Stellen Sie das Projekt wieder her, um es in der Seitenleiste und Projektauswahlfeldern anzuzeigen.",
      archiving: "Wird archiviert...",
      unarchiving: "Wird wiederhergestellt...",
      confirm_archive_prompt: "\"{{name}}\" archivieren?",
      confirm_unarchive_prompt: "\"{{name}}\" wiederherstellen?",
      archive_button: "Projekt archivieren",
      unarchive_button: "Projekt wiederherstellen"
    },
    execution: {
      title: "Ausführungs-Arbeitsbereiche",
      help_aria: "Hilfe zu Ausführungs-Arbeitsbereichen",
      help_tooltip: "Standard-Projekteinstellungen für isolierte Aufgaben-Checkouts und das Verhalten von Ausführungs-Workspaces.",
      enable_label: "Isolierte Aufgaben-Checkouts aktivieren",
      enable_hint: "Ermöglicht Aufgaben die Auswahl zwischen dem primären Projekt-Checkout und einem isolierten Ausführungs-Workspace.",
      enabled: "Aktiviert",
      disabled: "Deaktiviert",
      default_isolated_label: "Neue Aufgaben verwenden standardmäßig einen isolierten Checkout",
      default_isolated_hint: "Wenn deaktiviert, bleiben neue Aufgaben beim primären Projekt-Checkout, bis jemand dies explizit aktiviert.",
      hide_advanced: "Erweiterte Checkout-Einstellungen ausblenden",
      show_advanced: "Erweiterte Checkout-Einstellungen anzeigen",
      host_managed_label: "Host-seitige Implementierung:",
      git_worktree: "Git-Worktree",
      environment: "Umgebung",
      no_environment: "Keine Umgebung",
      base_ref: "Basis-Ref",
      branch_template: "Branch-Vorlage",
      worktree_parent_dir: "Übergeordnetes Worktree-Verzeichnis",
      provision_command: "Bereitstellungsbefehl",
      teardown_command: "Abbaubefehl",
      provision_teardown_hint: "Die Bereitstellung läuft im abgeleiteten Worktree vor der Agentenausführung. Der Abbau wird hier für zukünftige Bereinigungsszenarien gespeichert."
    }
  },
  new_project: {
    title: "Neues Projekt",
    no_company_error: "Kein Unternehmen ausgewählt",
    local_folder_fallback_name: "Lokaler Ordner",
    github_repo_fallback_name: "GitHub-Repository",
    local_folder_absolute_error: "Der lokale Ordner muss ein vollständiger absoluter Pfad sein.",
    repo_url_invalid_error: "Verwenden Sie eine gültige GitHub- oder GitHub Enterprise-Repository-URL.",
    name_placeholder: "Projektname",
    description_placeholder: "Beschreibung hinzufügen...",
    repo_url_label: "Repository-URL",
    optional: "optional",
    repo_url_tooltip: "Verknüpfen Sie ein GitHub-Repository, damit Agenten Code für dieses Projekt klonen, lesen und pushen können.",
    local_folder_label: "Lokaler Ordner",
    local_folder_tooltip: "Geben Sie einen absoluten Pfad auf dieser Maschine an, in den lokale Agenten Dateien für dieses Projekt lesen und schreiben werden.",
    remove_goal_aria: "Ziel {{title}} entfernen",
    add_goal: "+ Ziel",
    goal: "Ziel",
    no_goal: "Kein Ziel",
    all_goals_selected: "Alle Ziele wurden bereits ausgewählt.",
    target_date_placeholder: "Zieldatum",
    create_failed: "Projekt konnte nicht erstellt werden.",
    creating: "Wird erstellt…",
    create: "Projekt erstellen"
  },
  workspace: {
    summary: {
      updated_label: "Aktualisiert {{time}}",
      services_count: "{{running}} von {{total}} Diensten",
      stop_services: "Dienste stoppen",
      start_services: "Dienste starten",
      retry_close: "Schließen erneut versuchen",
      close_workspace: "Workspace schließen",
      branch: "Branch",
      branch_copied: "Branch kopiert",
      copy_branch_aria: "Branch kopieren",
      path: "Pfad",
      path_copied: "Pfad kopiert",
      copy_path_aria: "Pfad kopieren",
      service: "Dienst",
      linked_issues: "Verknüpfte Aufgaben",
      more_count: "+ {{count}} weitere"
    },
    detail: {
      intro: "Konfigurieren Sie den konkreten Workspace, den Paperclip an dieses Projekt bindet. Diese Werte bestimmen das Checkout-Verhalten für jeden Space, Standard-Laufzeit-Dienste für untergeordnete Ausführungs-Workspaces und ermöglichen die Überschreibung von Einrichtungs- oder Bereinigungsbefehlen, wenn ein Space eine besondere Behandlung benötigt.",
      primary_badge: "Dies ist der primäre Codebase-Workspace des Projekts.",
      save_failed: "Workspace konnte nicht gespeichert werden.",
      update_failed: "Workspace konnte nicht aktualisiert werden.",
      control_failed: "Workspace-Befehle konnten nicht gesteuert werden.",
      job_completed: "Workspace-Job abgeschlossen.",
      service_stopped: "Workspace-Dienst gestoppt. Aufgabenausführung nicht pausiert.",
      service_restarted: "Workspace-Dienst neu gestartet. Aufgabenausführung nicht pausiert.",
      service_started: "Workspace-Dienst gestartet.",
      error_remote_requires_ref: "Remote verwaltete Workspaces benötigen eine Remote-Workspace-Ref oder eine Repository-URL.",
      error_requires_path_or_repo: "Der Workspace benötigt mindestens einen lokalen Pfad oder eine Repository-URL.",
      error_path_must_be_absolute: "Der lokale Workspace-Pfad muss absolut sein.",
      field: {
        workspace_name: "Workspace-Name",
        visibility: "Sichtbarkeit",
        source_type: "Quellentyp",
        local_path: "Lokaler Pfad",
        repo_url: "Repository-URL",
        repo_ref: "Repository-Ref",
        default_ref: "Standard-Ref",
        shared_workspace_key: "Freigegebener Workspace-Schlüssel",
        remote_provider: "Remote-Anbieter",
        remote_workspace_ref: "Remote-Workspace-Ref",
        setup_command: "Einrichtungsbefehl",
        cleanup_command: "Bereinigungsbefehl",
        commands_json: "Workspace-Befehle JSON"
      },
      visibility: {
        default: "Standard",
        advanced: "Erweitert"
      },
      source_type: {
        local_path: {
          label: "Lokaler Git-Checkout",
          description: "Ein lokaler Pfad, den Paperclip direkt verwenden kann."
        },
        non_git_path: {
          label: "Lokaler Nicht-Git-Pfad",
          description: "Ein lokaler Ordner ohne Git-Semantik."
        },
        git_repo: {
          label: "Remote-Git-Repository",
          description: "Eine Repository-URL mit optionalen Refs und lokalem Checkout."
        },
        remote_managed: {
          label: "Remote verwalteter Workspace",
          description: "Ein gehosteter Workspace, der durch eine externe Referenz verfolgt wird."
        }
      },
      hint: {
        setup_command: "Wird ausgeführt, wenn dieser Workspace seine eigene Initialisierung benötigt",
        cleanup_command: "Wird vor dem Abbau des Ausführungs-Workspaces auf Projektebene ausgeführt",
        commands_json: "Ausführungs-Workspaces erben diese Konfiguration, wenn sie sie nicht überschreiben. Legacy-`services`-Arrays funktionieren weiterhin, aber `commands` unterstützt sowohl Dienste als auch Jobs."
      },
      advanced_json_summary: "Erweitertes Laufzeit-JSON",
      advanced_json_desc: "Paperclip leitet Dienste und Jobs aus diesem JSON ab. Bearbeiten Sie zuerst benannte Befehle; verwenden Sie rohes JSON für erweiterte Lebenszyklus-, Port-, Bereitschafts- oder Umgebungseinstellungen.",
      facts_kicker: "Workspace-Informationen",
      facts_title: "Aktueller Status",
      row: {
        project: "Projekt",
        workspace_id: "Workspace-ID",
        local_path: "Lokaler Pfad",
        repo: "Repository",
        default_ref: "Standard-Ref",
        updated: "Aktualisiert"
      },
      value_none: "Keine",
      commands_kicker: "Workspace-Befehle",
      commands_desc: "Dauerlaufende Dienste bleiben hier überwacht und einmalige Jobs werden auf Abruf gegen diesen Workspace ausgeführt. Ausführungs-Workspaces erben diese Konfiguration, wenn sie sie nicht überschreiben.",
      no_services_started: "Für diesen Workspace wurden noch keine Dienste gestartet.",
      no_command_config: "Für diesen Workspace ist noch keine Befehlskonfiguration definiert.",
      no_jobs: "Für diesen Workspace sind keine einmaligen Jobs konfiguriert.",
      disabled_hint: "Projekt-Workspaces benötigen ein Arbeitsverzeichnis für lokale Befehle, und Dienste benötigen auch eine Laufzeitkonfiguration."
    },
    error_runtime_must_be_object: "Workspace-Befehle JSON muss ein JSON-Objekt sein.",
    error_invalid_json: "Ungültiges JSON.",
    error_repo_url_invalid: "Repository-URL muss eine gültige URL sein.",
    error_failed_to_save: "Ausführungs-Workspace konnte nicht gespeichert werden.",
    error_control_workspace_commands: "Workspace-Befehle konnten nicht gesteuert werden.",
    error_build_update: "Workspace-Update konnte nicht vorbereitet werden."
  },
  messages: {
    failed_load_routines: "Routinen konnten nicht geladen werden.",
    failed_load_operations: "Workspace-Operationen konnten nicht geladen werden."
  },
  workspace_close: {
    title_close_workspace: "Workspace schließen",
    title_retry_close: "Schließen erneut versuchen",
    toast_workspace_closed: "Workspace geschlossen",
    toast_workspace_close_retried: "Schließen des Workspace wiederholt",
    toast_failed_to_close: "Workspace konnte nicht geschlossen werden",
    unknown_error: "Unbekannter Fehler",
    archive_prefix: "Archivieren",
    archive_suffix: "und zugehörige Artefakte bereinigen. Paperclip bewahrt den Workspace-Eintrag und den Aufgabenverlauf auf, entfernt ihn jedoch aus aktiven Ansichten.",
    checking_safe_to_close: "Wir prüfen, ob dieser Workspace sicher geschlossen werden kann...",
    failed_to_inspect: "Bereinigungsbereitschaft des Workspace konnte nicht geprüft werden.",
    state_blocked: "Schließen blockiert",
    state_with_warnings: "Schließen mit Warnungen erlaubt",
    state_ready: "Bereit zum Schließen",
    shared_workspace_note: "Dies ist eine freigegebene Workspace-Sitzung. Das Archivieren entfernt diesen Sitzungseintrag, bewahrt aber den primären Projekt-Workspace.",
    own_checkout_path_note: "Dieser Ausführungs-Workspace hat einen eigenen Checkout-Pfad und kann unabhängig archiviert werden.",
    primary_workspace_note: "Dieser Ausführungs-Workspace zeigt derzeit auf den primären Projekt-Workspace-Pfad.",
    disposable_note: "Dieser Workspace ist einmalig und kann archiviert werden.",
    blocking_issues: "Blockierende Aufgaben",
    blocking_reasons: "Blockierungsgründe",
    warnings: "Warnungen",
    git_status: "Git-Status",
    branch: "Branch",
    base_ref: "Basis-Ref",
    not_set: "Nicht gesetzt",
    merged_into_base: "In Basis zusammengeführt",
    yes_label: "Ja",
    no_label: "Nein",
    unknown: "Unbekannt",
    ahead_behind: "Voraus / Zurück",
    dirty_tracked_files: "Geänderte verfolgte Dateien",
    untracked_files: "Nicht verfolgte Dateien",
    other_linked_issues: "Andere verknüpfte Aufgaben",
    attached_runtime_services: "Angehängte Laufzeit-Dienste",
    no_additional_details: "Keine weiteren Details",
    cleanup_actions: "Bereinigungsaktionen",
    previously_failed_note: "Die Bereinigung dieses Workspace ist zuvor fehlgeschlagen. Ein erneutes Schließen startet den Bereinigungsprozess neu und aktualisiert den Status, wenn er erfolgreich abgeschlossen wird.",
    already_archived: "Dieser Workspace ist bereits archiviert.",
    repo_root: "Repository-Wurzel",
    workspace_path: "Workspace-Pfad",
    last_checked: "Zuletzt geprüft {{time}}"
  }
};

fill('de', 'common.json', DE_PATCH);
console.log('de/common.json done.');
