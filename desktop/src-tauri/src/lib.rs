mod commands;
mod db;
mod events;
mod menu;
mod services;
mod tray;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::block_on(async {
                db::init_db(&app_handle).await.expect("Failed to initialize database");
            });

            // Build and set application menu
            let app_menu = menu::build_menu(app.handle())?;
            app.set_menu(app_menu)?;

            // Create system tray
            tray::create_tray(app.handle())?;

            // Start background schedulers
            let scheduler_pool = app.state::<db::DbPool>().0.clone();
            let heartbeat_app = app.handle().clone();
            let heartbeat_pool = scheduler_pool.clone();
            tauri::async_runtime::spawn(async move {
                services::heartbeat::start_scheduler(heartbeat_app, heartbeat_pool).await;
            });

            let routine_app = app.handle().clone();
            let routine_pool = scheduler_pool.clone();
            tauri::async_runtime::spawn(async move {
                services::routine_scheduler::start_scheduler(routine_app, routine_pool).await;
            });

            // Initialize plugin runtime
            let plugin_pool = app.state::<db::DbPool>().0.clone();
            let plugin_runtime =
                std::sync::Arc::new(services::plugin_host::PluginRuntime::new());
            let pr = plugin_runtime.clone();
            tauri::async_runtime::spawn(async move {
                pr.initialize_all(&plugin_pool).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::system::health_check,
            commands::system::get_app_version,
            commands::system::test_adapter,
            commands::system::get_mcp_config,
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::companies::list_companies,
            commands::companies::create_company,
            commands::companies::get_company,
            commands::companies::export_company,
            commands::companies::import_company,
            commands::companies::import_bundled_company,
            commands::companies::import_github_company,
            commands::agents::list_agents,
            commands::agents::get_agent,
            commands::agents::create_agent,
            commands::agents::update_agent,
            commands::agents::delete_agent,
            commands::agents::pause_agent,
            commands::agents::resume_agent,
            commands::agents::terminate_agent,
            commands::agents::list_heartbeat_runs,
            commands::agents::get_org_tree,
            // Phase 3: Issues
            commands::issues::list_issues,
            commands::issues::get_issue,
            commands::issues::create_issue,
            commands::issues::update_issue,
            commands::issues::delete_issue,
            commands::issues::list_issue_comments,
            commands::issues::create_issue_comment,
            // Phase 3: Projects
            commands::projects::list_projects,
            commands::projects::get_project,
            commands::projects::create_project,
            commands::projects::update_project,
            commands::projects::delete_project,
            // Phase 3: Goals
            commands::goals::list_goals,
            commands::goals::create_goal,
            commands::goals::update_goal,
            commands::goals::delete_goal,
            // Phase 3: Approvals
            commands::approvals::list_approvals,
            commands::approvals::create_approval,
            commands::approvals::approve_approval,
            commands::approvals::reject_approval,
            // Phase 3: Costs
            commands::costs::get_cost_summary,
            commands::costs::get_costs_by_agent,
            commands::costs::get_costs_by_model,
            // I1: Dashboard Analytics
            commands::costs::get_cost_trend,
            commands::costs::get_run_stats,
            commands::costs::get_agent_utilization,
            // J2: Budget Policy CRUD
            commands::costs::list_budget_policies,
            commands::costs::create_budget_policy,
            commands::costs::delete_budget_policy,
            // Phase 4: Routines
            commands::routines::list_routines,
            commands::routines::get_routine,
            commands::routines::create_routine,
            commands::routines::update_routine,
            commands::routines::delete_routine,
            commands::routines::list_routine_runs,
            commands::routines::trigger_routine,
            // Phase 4: Workflows
            commands::workflows::list_workflows,
            commands::workflows::get_workflow,
            commands::workflows::create_workflow,
            commands::workflows::update_workflow,
            commands::workflows::delete_workflow,
            commands::workflows::run_workflow,
            commands::workflows::get_workflow_run,
            // Phase 5: Plugins
            commands::plugins::list_plugins,
            commands::plugins::install_plugin,
            commands::plugins::uninstall_plugin,
            commands::plugins::enable_plugin,
            commands::plugins::disable_plugin,
            commands::plugins::get_plugin_config,
            commands::plugins::update_plugin_config,
            // Phase 5: Local AI
            commands::local_ai::list_local_models,
            commands::local_ai::register_model,
            commands::local_ai::delete_model,
            commands::local_ai::get_system_info,
            // Gap-fill: Missing agent commands
            commands::agents::wake_agent,
            commands::agents::get_runtime_state,
            commands::agents::get_agent_config,
            commands::agents::list_config_revisions,
            commands::agents::rollback_config,
            commands::agents::get_heartbeat_run,
            commands::agents::cancel_heartbeat_run,
            commands::agents::get_live_runs,
            commands::agents::list_adapter_models,
            commands::agents::get_agent_instructions,
            commands::agents::save_agent_instructions,
            commands::agents::create_agent_key,
            commands::agents::list_agent_keys,
            commands::agents::revoke_agent_key,
            // Gap-fill: Missing issue commands
            commands::issues::search_issues,
            commands::issues::checkout_issue,
            commands::issues::update_issue_comment,
            // Gap-fill: Missing project commands
            commands::projects::list_project_workspaces,
            commands::projects::create_project_workspace,
            commands::projects::inspect_workspace,
            // Gap-fill: Missing workflow commands
            commands::workflows::cancel_workflow_run,
            // Gap-fill: Missing routine trigger commands
            commands::routines::list_routine_triggers,
            commands::routines::create_routine_trigger,
            commands::routines::update_routine_trigger,
            commands::routines::delete_routine_trigger,
            // Gap-fill: Automation commands
            commands::automation::run_applescript,
            commands::automation::list_shortcuts,
            commands::automation::run_shortcut,
            commands::automation::get_automation_system_info,
            // I3: Automation Rules
            commands::automation::list_automation_rules,
            commands::automation::create_automation_rule,
            commands::automation::delete_automation_rule,
            commands::automation::toggle_automation_rule,
            // Skills
            commands::skills::list_company_skills,
            commands::skills::create_company_skill,
            commands::skills::delete_company_skill,
            commands::skills::attach_skill_to_agent,
            commands::skills::detach_skill_from_agent,
            commands::skills::list_agent_skills,
            commands::skills::scan_skills,
            commands::skills::import_discovered_skill,
            commands::skills::import_skill_from_github,
            // Secrets management
            commands::secrets::set_secret,
            commands::secrets::get_secret,
            commands::secrets::delete_secret,
            commands::secrets::list_secret_keys,
            // Feedback votes
            commands::feedback::vote_on_target,
            commands::feedback::get_vote_for_target,
            commands::feedback::list_votes,
            commands::feedback::export_feedback_json,
            // Activity log
            commands::activity_cmd::list_activity,
            // Instructions file listing
            commands::agents::list_instruction_files,
            // Auth
            commands::auth::check_adapter_auth,
            commands::auth::adapter_login,
            commands::auth::adapter_logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ArchonOS");
}
