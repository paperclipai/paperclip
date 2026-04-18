use clap::{Parser, Subcommand};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::str::FromStr;

#[derive(Parser)]
#[command(name = "archonos", about = "ArchonOS CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Agent {
        #[command(subcommand)]
        action: AgentAction,
    },
    Issue {
        #[command(subcommand)]
        action: IssueAction,
    },
    Approval {
        #[command(subcommand)]
        action: ApprovalAction,
    },
    Company {
        #[command(subcommand)]
        action: CompanyAction,
    },
    Heartbeat {
        #[command(subcommand)]
        action: HeartbeatAction,
    },
}

#[derive(Subcommand)]
enum AgentAction {
    List,
    Wake {
        id: String,
        #[arg(long)]
        reason: Option<String>,
    },
}

#[derive(Subcommand)]
enum IssueAction {
    List {
        #[arg(long)]
        status: Option<String>,
    },
    Create {
        title: String,
        #[arg(long)]
        priority: Option<String>,
    },
}

#[derive(Subcommand)]
enum ApprovalAction {
    List,
    Approve {
        id: String,
        #[arg(long)]
        note: Option<String>,
    },
    Reject {
        id: String,
        #[arg(long)]
        note: Option<String>,
    },
}

#[derive(Subcommand)]
enum CompanyAction {
    List,
    Export { id: String },
}

#[derive(Subcommand)]
enum HeartbeatAction {
    Run {
        agent_id: String,
        #[arg(long)]
        reason: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    let db_path = dirs::data_dir()
        .unwrap_or_default()
        .join("com.archonos.app")
        .join("archonos.db");

    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
    let options = SqliteConnectOptions::from_str(&db_url)?
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new()
        .max_connections(3)
        .connect_with(options)
        .await?;

    match cli.command {
        Commands::Agent { action } => match action {
            AgentAction::List => {
                let rows = sqlx::query_as::<_, (String, String, String, String)>(
                    "SELECT name, role, adapter_type, status FROM agents WHERE status != 'terminated' ORDER BY created_at",
                )
                .fetch_all(&pool)
                .await?;
                println!(
                    "{:<20} {:<12} {:<15} {:<10}",
                    "NAME", "ROLE", "ADAPTER", "STATUS"
                );
                println!("{}", "-".repeat(60));
                for (name, role, adapter, status) in rows {
                    println!("{:<20} {:<12} {:<15} {:<10}", name, role, adapter, status);
                }
            }
            AgentAction::Wake { id, reason } => {
                let wid = uuid::Uuid::new_v4().to_string();
                let r = reason.unwrap_or_else(|| "cli".to_string());
                sqlx::query("INSERT INTO agent_wakeup_requests (id, company_id, agent_id, source, reason) VALUES (?, (SELECT company_id FROM agents WHERE id = ?), ?, 'cli', ?)")
                    .bind(&wid)
                    .bind(&id)
                    .bind(&id)
                    .bind(&r)
                    .execute(&pool)
                    .await?;
                println!("Wakeup request created: {}", wid);
                println!("The heartbeat scheduler will pick this up within 30 seconds.");
            }
        },
        Commands::Issue { action } => match action {
            IssueAction::List { status } => {
                let rows = if let Some(s) = status {
                    sqlx::query_as::<_, (String, String, String, String)>(
                        "SELECT identifier, title, status, priority FROM issues WHERE hidden_at IS NULL AND status = ? ORDER BY created_at DESC LIMIT 50",
                    )
                    .bind(&s)
                    .fetch_all(&pool)
                    .await?
                } else {
                    sqlx::query_as::<_, (String, String, String, String)>(
                        "SELECT identifier, title, status, priority FROM issues WHERE hidden_at IS NULL ORDER BY created_at DESC LIMIT 50",
                    )
                    .fetch_all(&pool)
                    .await?
                };
                println!(
                    "{:<12} {:<40} {:<15} {:<10}",
                    "ID", "TITLE", "STATUS", "PRIORITY"
                );
                println!("{}", "-".repeat(80));
                for (id, title, status, priority) in rows {
                    let t = if title.len() > 38 {
                        format!("{}...", &title[..35])
                    } else {
                        title
                    };
                    println!("{:<12} {:<40} {:<15} {:<10}", id, t, status, priority);
                }
            }
            IssueAction::Create { title, priority } => {
                let cid: String = sqlx::query_scalar(
                    "SELECT id FROM companies WHERE status = 'active' LIMIT 1",
                )
                .fetch_one(&pool)
                .await?;
                let next_num: i64 = sqlx::query_scalar(
                    "SELECT COALESCE(MAX(issue_number), 0) + 1 FROM issues WHERE company_id = ?",
                )
                .bind(&cid)
                .fetch_one(&pool)
                .await?;
                let prefix: String = sqlx::query_scalar(
                    "SELECT issue_prefix FROM companies WHERE id = ?",
                )
                .bind(&cid)
                .fetch_one(&pool)
                .await?;
                let identifier = format!("{}-{}", prefix, next_num);
                let id = uuid::Uuid::new_v4().to_string();
                let p = priority.unwrap_or_else(|| "medium".to_string());
                sqlx::query("INSERT INTO issues (id, company_id, issue_number, identifier, title, priority) VALUES (?, ?, ?, ?, ?, ?)")
                    .bind(&id)
                    .bind(&cid)
                    .bind(next_num)
                    .bind(&identifier)
                    .bind(&title)
                    .bind(&p)
                    .execute(&pool)
                    .await?;
                println!("Created: {}", identifier);
            }
        },
        Commands::Approval { action } => match action {
            ApprovalAction::List => {
                let rows = sqlx::query_as::<_, (String, String, String)>(
                    "SELECT id, type, created_at FROM approvals WHERE status = 'pending' ORDER BY created_at DESC",
                )
                .fetch_all(&pool)
                .await?;
                if rows.is_empty() {
                    println!("No pending approvals.");
                    return Ok(());
                }
                println!("{:<38} {:<20} {:<20}", "ID", "TYPE", "CREATED");
                for (id, t, created) in rows {
                    println!("{:<38} {:<20} {:<20}", id, t, created);
                }
            }
            ApprovalAction::Approve { id, note } => {
                sqlx::query("UPDATE approvals SET status='approved', decision_note=?, decided_at=datetime('now') WHERE id=?")
                    .bind(&note)
                    .bind(&id)
                    .execute(&pool)
                    .await?;
                println!("Approved: {}", id);
            }
            ApprovalAction::Reject { id, note } => {
                sqlx::query("UPDATE approvals SET status='rejected', decision_note=?, decided_at=datetime('now') WHERE id=?")
                    .bind(&note)
                    .bind(&id)
                    .execute(&pool)
                    .await?;
                println!("Rejected: {}", id);
            }
        },
        Commands::Company { action } => match action {
            CompanyAction::List => {
                let rows = sqlx::query_as::<_, (String, String, String)>(
                    "SELECT name, issue_prefix, status FROM companies ORDER BY created_at",
                )
                .fetch_all(&pool)
                .await?;
                println!("{:<30} {:<10} {:<10}", "NAME", "PREFIX", "STATUS");
                for (name, prefix, status) in rows {
                    println!("{:<30} {:<10} {:<10}", name, prefix, status);
                }
            }
            CompanyAction::Export { id } => {
                let company = sqlx::query_as::<_, (String, String, String)>(
                    "SELECT name, issue_prefix, status FROM companies WHERE id = ?",
                )
                .bind(&id)
                .fetch_optional(&pool)
                .await?
                .ok_or("Company not found")?;
                println!(
                    "{{\"schema\":\"archonos/v1\",\"company\":{{\"name\":\"{}\",\"prefix\":\"{}\"}}}}",
                    company.0, company.1
                );
            }
        },
        Commands::Heartbeat { action } => match action {
            HeartbeatAction::Run { agent_id, reason } => {
                let r = reason.unwrap_or_else(|| "cli".to_string());
                let wid = uuid::Uuid::new_v4().to_string();

                sqlx::query("INSERT INTO agent_wakeup_requests (id, company_id, agent_id, source, reason) VALUES (?, (SELECT company_id FROM agents WHERE id = ?), ?, 'cli', ?)")
                    .bind(&wid)
                    .bind(&agent_id)
                    .bind(&agent_id)
                    .bind(&r)
                    .execute(&pool)
                    .await?;
                println!(
                    "\x1b[36mWakeup request {} created. Waiting for heartbeat scheduler...\x1b[0m",
                    wid
                );

                let mut last_excerpt_len = 0usize;
                let mut run_id: Option<String> = None;
                let start = std::time::Instant::now();
                let timeout = std::time::Duration::from_secs(600);

                loop {
                    if start.elapsed() > timeout {
                        eprintln!("\x1b[33mTimeout waiting for run to complete.\x1b[0m");
                        std::process::exit(2);
                    }

                    if run_id.is_none() {
                        if let Ok(Some((rid,))) = sqlx::query_as::<_, (String,)>(
                            "SELECT run_id FROM agent_wakeup_requests WHERE id = ? AND run_id IS NOT NULL",
                        )
                        .bind(&wid)
                        .fetch_optional(&pool)
                        .await
                        {
                            run_id = Some(rid.clone());
                            println!("\x1b[36mRun started: {}\x1b[0m", rid);
                        }
                    }

                    if let Some(ref rid) = run_id {
                        if let Ok(Some((status, excerpt, exit_code))) =
                            sqlx::query_as::<_, (String, Option<String>, Option<i32>)>(
                                "SELECT status, stdout_excerpt, exit_code FROM heartbeat_runs WHERE id = ?",
                            )
                            .bind(rid)
                            .fetch_optional(&pool)
                            .await
                        {
                            if let Some(ref exc) = excerpt {
                                if exc.len() > last_excerpt_len {
                                    print!("{}", &exc[last_excerpt_len..]);
                                    last_excerpt_len = exc.len();
                                }
                            }
                            match status.as_str() {
                                "succeeded" => {
                                    println!("\n\x1b[32mRun succeeded.\x1b[0m");
                                    std::process::exit(0);
                                }
                                "failed" => {
                                    eprintln!(
                                        "\n\x1b[31mRun failed (exit {}).\x1b[0m",
                                        exit_code.unwrap_or(-1)
                                    );
                                    std::process::exit(1);
                                }
                                "timed_out" => {
                                    eprintln!("\n\x1b[33mRun timed out.\x1b[0m");
                                    std::process::exit(2);
                                }
                                "cancelled" => {
                                    eprintln!("\n\x1b[33mRun cancelled.\x1b[0m");
                                    std::process::exit(1);
                                }
                                _ => {}
                            }
                        }
                    }

                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }
        },
    }

    Ok(())
}
