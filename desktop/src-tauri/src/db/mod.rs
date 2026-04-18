use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::str::FromStr;
use tauri::Manager;

pub struct DbPool(pub SqlitePool);

fn get_db_path() -> PathBuf {
    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.archonos.app");
    std::fs::create_dir_all(&data_dir).expect("Failed to create app data directory");
    data_dir.join("archonos.db")
}

pub async fn init_db(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let db_path = get_db_path();
    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());

    let options = SqliteConnectOptions::from_str(&db_url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    // Run migrations
    run_migrations(&pool).await?;

    app.manage(DbPool(pool));

    Ok(())
}

async fn run_migrations(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    // V001: Initial settings table
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await?;

    // V002: Companies
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS companies (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            issue_prefix TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'active',
            settings TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await?;

    // V002: Agents
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS agents (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL REFERENCES companies(id),
            name TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'general',
            title TEXT,
            icon TEXT,
            status TEXT NOT NULL DEFAULT 'idle',
            reports_to TEXT REFERENCES agents(id),
            capabilities TEXT DEFAULT '{}',
            adapter_type TEXT NOT NULL DEFAULT 'process',
            adapter_config TEXT NOT NULL DEFAULT '{}',
            runtime_config TEXT NOT NULL DEFAULT '{}',
            budget_monthly_cents INTEGER NOT NULL DEFAULT 0,
            spent_monthly_cents INTEGER NOT NULL DEFAULT 0,
            pause_reason TEXT,
            paused_at TEXT,
            permissions TEXT NOT NULL DEFAULT '{}',
            last_heartbeat_at TEXT,
            metadata TEXT DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_agents_company_status ON agents(company_id, status)")
        .execute(pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_agents_company_reports ON agents(company_id, reports_to)")
        .execute(pool)
        .await?;

    // V002: Heartbeat runs
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS heartbeat_runs (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            agent_id TEXT NOT NULL REFERENCES agents(id),
            invocation_source TEXT NOT NULL DEFAULT 'on_demand',
            trigger_detail TEXT,
            status TEXT NOT NULL DEFAULT 'queued',
            started_at TEXT,
            finished_at TEXT,
            error TEXT,
            error_code TEXT,
            exit_code INTEGER,
            signal TEXT,
            usage_json TEXT DEFAULT '{}',
            result_json TEXT DEFAULT '{}',
            stdout_excerpt TEXT,
            stderr_excerpt TEXT,
            context_snapshot TEXT DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_runs_company_agent ON heartbeat_runs(company_id, agent_id, started_at)",
    )
    .execute(pool)
    .await?;

    // V002: Agent runtime state
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS agent_runtime_state (
            agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agents(id),
            company_id TEXT NOT NULL,
            adapter_type TEXT,
            session_id TEXT,
            state_json TEXT DEFAULT '{}',
            last_run_id TEXT,
            last_run_status TEXT,
            total_input_tokens INTEGER DEFAULT 0,
            total_output_tokens INTEGER DEFAULT 0,
            total_cost_cents INTEGER DEFAULT 0,
            last_error TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await?;

    // V002: Agent config revisions
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS agent_config_revisions (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            agent_id TEXT NOT NULL REFERENCES agents(id),
            source TEXT NOT NULL DEFAULT 'patch',
            changed_keys TEXT DEFAULT '[]',
            before_config TEXT DEFAULT '{}',
            after_config TEXT DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await?;

    // V002: Activity log
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS activity_log (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            actor_type TEXT NOT NULL,
            actor_id TEXT,
            action TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT,
            detail TEXT DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_activity_company ON activity_log(company_id, created_at)")
        .execute(pool)
        .await?;

    // ═══ V003: Projects, Issues, Goals, Approvals, Costs ═══

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            goal_id TEXT,
            name TEXT NOT NULL,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'backlog',
            color TEXT,
            target_date TEXT,
            lead_agent_id TEXT REFERENCES agents(id),
            archived_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS project_workspaces (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            project_id TEXT NOT NULL REFERENCES projects(id),
            name TEXT NOT NULL,
            source_type TEXT NOT NULL DEFAULT 'local_path',
            cwd TEXT,
            repo_url TEXT,
            repo_ref TEXT,
            is_primary INTEGER NOT NULL DEFAULT 0,
            metadata TEXT DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS issues (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            project_id TEXT REFERENCES projects(id),
            goal_id TEXT,
            parent_id TEXT REFERENCES issues(id),
            issue_number INTEGER NOT NULL,
            identifier TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'backlog',
            priority TEXT NOT NULL DEFAULT 'medium',
            assignee_agent_id TEXT REFERENCES agents(id),
            origin_kind TEXT,
            billing_code TEXT,
            execution_state TEXT DEFAULT '{}',
            execution_policy TEXT DEFAULT '{}',
            started_at TEXT,
            completed_at TEXT,
            cancelled_at TEXT,
            hidden_at TEXT,
            created_by_agent_id TEXT,
            created_by_user_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_issues_company_status ON issues(company_id, status)")
        .execute(pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues(company_id, assignee_agent_id, status)")
        .execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS issue_comments (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            issue_id TEXT NOT NULL REFERENCES issues(id),
            author_agent_id TEXT,
            author_user_id TEXT,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS goals (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            parent_id TEXT REFERENCES goals(id),
            title TEXT NOT NULL,
            description TEXT,
            level TEXT NOT NULL DEFAULT 'task',
            status TEXT NOT NULL DEFAULT 'planned',
            owner_agent_id TEXT REFERENCES agents(id),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS approvals (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            type TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'pending',
            requested_by_agent_id TEXT,
            decision_note TEXT,
            decided_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS cost_events (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            agent_id TEXT,
            issue_id TEXT,
            project_id TEXT,
            heartbeat_run_id TEXT,
            provider TEXT,
            biller TEXT,
            billing_type TEXT,
            model TEXT,
            input_tokens INTEGER DEFAULT 0,
            cached_input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cost_cents INTEGER NOT NULL DEFAULT 0,
            billing_code TEXT,
            occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_costs_company_agent ON cost_events(company_id, agent_id, occurred_at)")
        .execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS budget_policies (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            scope_type TEXT NOT NULL,
            scope_id TEXT,
            metric TEXT NOT NULL DEFAULT 'billed_cents',
            window_kind TEXT NOT NULL,
            amount INTEGER NOT NULL,
            warn_percent INTEGER NOT NULL DEFAULT 80,
            hard_stop_enabled INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    // ═══ V004: Routines & Workflows ═══

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS routines (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            project_id TEXT REFERENCES projects(id),
            goal_id TEXT,
            title TEXT NOT NULL,
            description TEXT,
            assignee_agent_id TEXT REFERENCES agents(id),
            priority TEXT NOT NULL DEFAULT 'medium',
            status TEXT NOT NULL DEFAULT 'active',
            concurrency_policy TEXT NOT NULL DEFAULT 'coalesce_if_active',
            catch_up_policy TEXT NOT NULL DEFAULT 'skip_missed',
            variables TEXT DEFAULT '[]',
            last_triggered_at TEXT,
            last_enqueued_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_routines_company ON routines(company_id, status)")
        .execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS routine_triggers (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            label TEXT,
            cron_expression TEXT,
            timezone TEXT DEFAULT 'UTC',
            next_run_at TEXT,
            last_fired_at TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS routine_runs (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            routine_id TEXT NOT NULL REFERENCES routines(id),
            trigger_id TEXT REFERENCES routine_triggers(id),
            source TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'received',
            triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
            trigger_payload TEXT DEFAULT '{}',
            linked_issue_id TEXT REFERENCES issues(id),
            failure_reason TEXT,
            completed_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS workflows (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'draft',
            graph TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS workflow_runs (
            id TEXT PRIMARY KEY NOT NULL,
            workflow_id TEXT NOT NULL REFERENCES workflows(id),
            company_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'running',
            current_node_id TEXT,
            state TEXT NOT NULL DEFAULT '{}',
            started_at TEXT NOT NULL DEFAULT (datetime('now')),
            completed_at TEXT,
            error TEXT
        )",
    ).execute(pool).await?;

    // ═══ V005: Plugins, Local AI, Automation ═══

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS plugins (
            id TEXT PRIMARY KEY NOT NULL,
            plugin_key TEXT NOT NULL UNIQUE,
            package_name TEXT,
            version TEXT,
            api_version INTEGER NOT NULL DEFAULT 1,
            categories TEXT DEFAULT '[]',
            manifest_json TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'installed',
            install_order INTEGER,
            package_path TEXT,
            last_error TEXT,
            installed_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS plugin_config (
            id TEXT PRIMARY KEY NOT NULL,
            plugin_id TEXT NOT NULL UNIQUE REFERENCES plugins(id) ON DELETE CASCADE,
            config_json TEXT NOT NULL DEFAULT '{}',
            last_error TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS plugin_state (
            id TEXT PRIMARY KEY NOT NULL,
            plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
            scope_kind TEXT NOT NULL,
            scope_id TEXT,
            namespace TEXT NOT NULL DEFAULT 'default',
            state_key TEXT NOT NULL,
            value_json TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(plugin_id, scope_kind, scope_id, namespace, state_key)
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS plugin_jobs (
            id TEXT PRIMARY KEY NOT NULL,
            plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
            job_key TEXT NOT NULL,
            schedule TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            last_run_at TEXT,
            next_run_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(plugin_id, job_key)
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS local_models (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            family TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_size_bytes INTEGER NOT NULL,
            quantization TEXT,
            context_length INTEGER,
            status TEXT NOT NULL DEFAULT 'ready',
            download_progress REAL DEFAULT 0,
            metadata TEXT DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS pending_operations (
            id TEXT PRIMARY KEY NOT NULL,
            operation_type TEXT NOT NULL,
            payload TEXT NOT NULL,
            retry_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    // ═══ V006: Gap-fill — missing tables, columns, FTS5 ═══

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS agent_wakeup_requests (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            agent_id TEXT NOT NULL REFERENCES agents(id),
            source TEXT NOT NULL,
            reason TEXT,
            payload TEXT DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'queued',
            coalesced_count INTEGER NOT NULL DEFAULT 0,
            requested_by_actor_type TEXT,
            requested_by_actor_id TEXT,
            idempotency_key TEXT,
            run_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_wakeup_agent_status ON agent_wakeup_requests(company_id, agent_id, status)")
        .execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS execution_workspaces (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            agent_id TEXT REFERENCES agents(id),
            issue_id TEXT,
            project_workspace_id TEXT,
            cwd TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            metadata TEXT DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            released_at TEXT
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS budget_incidents (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            policy_id TEXT REFERENCES budget_policies(id),
            scope_type TEXT NOT NULL,
            scope_id TEXT,
            metric TEXT NOT NULL,
            window_kind TEXT NOT NULL,
            window_start TEXT,
            window_end TEXT,
            threshold_type TEXT,
            amount_limit INTEGER,
            amount_observed INTEGER,
            status TEXT NOT NULL DEFAULT 'open',
            approval_id TEXT,
            resolved_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_budget_incidents_company ON budget_incidents(company_id, status)")
        .execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS plugin_job_runs (
            id TEXT PRIMARY KEY NOT NULL,
            job_id TEXT NOT NULL REFERENCES plugin_jobs(id) ON DELETE CASCADE,
            plugin_id TEXT NOT NULL,
            trigger TEXT NOT NULL DEFAULT 'scheduled',
            status TEXT NOT NULL DEFAULT 'pending',
            duration_ms INTEGER,
            error TEXT,
            logs TEXT DEFAULT '[]',
            started_at TEXT,
            finished_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS issue_attachments (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            issue_id TEXT NOT NULL REFERENCES issues(id),
            asset_id TEXT,
            issue_comment_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS issue_labels (
            issue_id TEXT NOT NULL REFERENCES issues(id),
            label_id TEXT NOT NULL,
            company_id TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (issue_id, label_id)
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS issue_relations (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            source_issue_id TEXT NOT NULL REFERENCES issues(id),
            target_issue_id TEXT NOT NULL REFERENCES issues(id),
            relation_type TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    // Add missing columns to existing tables (ignore errors if columns already exist)
    let alter_stmts = vec![
        "ALTER TABLE project_workspaces ADD COLUMN default_ref TEXT",
        "ALTER TABLE project_workspaces ADD COLUMN visibility TEXT",
        "ALTER TABLE project_workspaces ADD COLUMN setup_command TEXT",
        "ALTER TABLE project_workspaces ADD COLUMN cleanup_command TEXT",
        "ALTER TABLE routines ADD COLUMN created_by_agent_id TEXT",
        "ALTER TABLE routines ADD COLUMN created_by_user_id TEXT",
        "ALTER TABLE routines ADD COLUMN updated_by_agent_id TEXT",
        "ALTER TABLE routines ADD COLUMN updated_by_user_id TEXT",
        "ALTER TABLE routine_runs ADD COLUMN coalesced_into_run_id TEXT",
    ];
    for stmt in alter_stmts {
        let _ = sqlx::query(stmt).execute(pool).await;
    }

    // FTS5 virtual tables
    sqlx::query(
        "CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(title, description, identifier, content=issues, content_rowid=rowid)",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(body, content=issue_comments, content_rowid=rowid)",
    ).execute(pool).await?;

    // ═══ V008: Agent task sessions, skills, automation rules ═══

    // V008: Agent task sessions (for F3)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS agent_task_sessions (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            adapter_type TEXT NOT NULL,
            task_key TEXT NOT NULL,
            session_params_json TEXT DEFAULT '{}',
            session_display_id TEXT,
            last_run_id TEXT,
            total_runs INTEGER DEFAULT 0,
            total_input_tokens INTEGER DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(company_id, agent_id, adapter_type, task_key)
        )",
    ).execute(pool).await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_task_sessions_agent ON agent_task_sessions(company_id, agent_id, updated_at)",
    ).execute(pool).await?;

    // V008: Company skills (for G2)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS company_skills (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            skill_key TEXT NOT NULL UNIQUE,
            slug TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            markdown TEXT NOT NULL DEFAULT '',
            source_type TEXT NOT NULL DEFAULT 'manual',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    // V008: Agent skills junction (for G2)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS agent_skills (
            agent_id TEXT NOT NULL REFERENCES agents(id),
            skill_id TEXT NOT NULL REFERENCES company_skills(id),
            company_id TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (agent_id, skill_id)
        )",
    ).execute(pool).await?;

    // V008: Automation rules (for I3)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS automation_rules (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            name TEXT NOT NULL,
            trigger_type TEXT NOT NULL,
            trigger_config TEXT NOT NULL DEFAULT '{}',
            action_type TEXT NOT NULL DEFAULT 'wake_agent',
            action_config TEXT NOT NULL DEFAULT '{}',
            enabled INTEGER NOT NULL DEFAULT 1,
            last_triggered_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ).execute(pool).await?;

    // V008: Column additions
    let alters = vec![
        "ALTER TABLE agents ADD COLUMN instructions_mode TEXT DEFAULT 'managed'",
        "ALTER TABLE agents ADD COLUMN instructions_path TEXT",
        "ALTER TABLE execution_workspaces ADD COLUMN strategy_type TEXT DEFAULT 'project_primary'",
        "ALTER TABLE execution_workspaces ADD COLUMN branch_name TEXT",
        "ALTER TABLE execution_workspaces ADD COLUMN worktree_path TEXT",
        "ALTER TABLE execution_workspaces ADD COLUMN base_ref TEXT",
        "ALTER TABLE execution_workspaces ADD COLUMN provision_command TEXT",
        "ALTER TABLE execution_workspaces ADD COLUMN teardown_command TEXT",
    ];
    for stmt in alters {
        let _ = sqlx::query(stmt).execute(pool).await;
    }

    // V009: Agent API keys
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS agent_api_keys (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            agent_id TEXT NOT NULL REFERENCES agents(id),
            name TEXT NOT NULL,
            key_prefix TEXT NOT NULL,
            key_hash TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            last_used_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )"
    ).execute(pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_agent_keys_agent ON agent_api_keys(agent_id, status)")
        .execute(pool).await?;

    let _ = sqlx::query("ALTER TABLE companies ADD COLUMN skill_sync_preference TEXT DEFAULT 'manual'").execute(pool).await;

    // V010: Feedback votes
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS feedback_votes (
            id TEXT PRIMARY KEY NOT NULL,
            company_id TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            vote TEXT NOT NULL,
            reason TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(target_type, target_id)
        )"
    ).execute(pool).await?;

    Ok(())
}
