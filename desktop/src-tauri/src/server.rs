//! Owns the Paperclip server child process.
//!
//! The shell is the server's parent, so it is also responsible for the two
//! things a parent can get wrong: leaving the server running after the window
//! closes, and orphaning it when the shell itself is killed. Windows gets a job
//! object with `KILL_ON_JOB_CLOSE` for the second case; elsewhere the child is
//! asked to stop and then killed if it does not.
//!
//! Startup is a health gate, not a sleep. The window only navigates to the
//! board once `/api/health` answers, and only then does it become visible — a
//! desktop app that flashes a blank page while a server boots reads as broken.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::launch;

/// How often the health gate re-checks while the server starts.
const POLL_INTERVAL: Duration = Duration::from_millis(400);
/// Ceiling on the health gate. Past this the shell reports a startup failure
/// instead of waiting forever on a server that is not coming.
const READY_TIMEOUT: Duration = Duration::from_secs(120);
/// Grace period for a polite stop before the child is killed. Only the Unix
/// path asks first; Windows terminates through the job object.
#[cfg(unix)]
const STOP_GRACE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub state: &'static str,
    pub port: u16,
    pub url: String,
    pub detail: Option<String>,
}

/// A Windows job handle. `HANDLE` is a raw pointer and so not `Send`, but this
/// one is only ever created, closed, and read on the shell's own thread, and
/// closing it is the only operation that has an effect — so marking it `Send` is
/// sound for the state it lives in.
#[cfg(windows)]
struct JobHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for JobHandle {}

struct Inner {
    child: Option<Child>,
    port: u16,
    /// The last status the shell published.
    ///
    /// The boot window asks for status as soon as it loads, which can be after a
    /// fast failure has already been emitted — and an emitted event nobody was
    /// listening for is lost. Retaining it means `boot_info` can still report
    /// the failure instead of a synthesized "stopped" that renders as a spinner
    /// with nothing to read.
    last_status: Option<ServerStatus>,
    /// Windows only: the job object that guarantees the child dies with the
    /// shell even if the shell is killed rather than closed.
    #[cfg(windows)]
    job: Option<JobHandle>,
}

/// Handle shared with the app's exit hook and the restart command.
pub struct ServerHandle<R: Runtime> {
    inner: std::sync::Mutex<Inner>,
    stopping: std::sync::atomic::AtomicBool,
    app: AppHandle<R>,
    log_path: std::path::PathBuf,
}

impl<R: Runtime> ServerHandle<R> {
    pub fn new(app: AppHandle<R>, log_path: std::path::PathBuf) -> Self {
        Self {
            inner: std::sync::Mutex::new(Inner {
                child: None,
                port: launch::DEFAULT_PORT,
                last_status: None,
                #[cfg(windows)]
                job: None,
            }),
            stopping: std::sync::atomic::AtomicBool::new(false),
            app,
            log_path,
        }
    }

    pub fn log_path(&self) -> &std::path::Path {
        &self.log_path
    }

    pub fn status(&self) -> ServerStatus {
        let inner = self.inner.lock().unwrap();
        // A retained failure is more useful than a synthesized "stopped": the
        // boot page turns "stopped" with no detail into an indefinite spinner.
        if let Some(status) = &inner.last_status {
            if status.state == "failed" {
                return status.clone();
            }
        }
        ServerStatus {
            state: if inner.child.is_some() {
                "running"
            } else {
                "stopped"
            },
            port: inner.port,
            url: launch::base_url(inner.port),
            detail: None,
        }
    }

    fn publish(&self, state: &'static str, port: u16, detail: Option<String>) -> ServerStatus {
        let status = ServerStatus {
            state,
            port,
            url: launch::base_url(port),
            detail,
        };
        // Retain before emitting. An event with no listener is dropped, and the
        // boot window may not have registered yet.
        if let Ok(mut inner) = self.inner.lock() {
            inner.last_status = Some(status.clone());
        }
        let _ = self.app.emit("paperclip://server-status", status.clone());
        status
    }

    /// Record a startup failure so both the boot page and a later `boot_info`
    /// read can see it.
    ///
    /// Retained as well as emitted: a startup can fail faster than the webview
    /// registers its listener, and an event nobody received leaves the boot page
    /// spinning forever with nothing to report.
    pub fn fail(&self, detail: String) -> ServerStatus {
        let port = self.inner.lock().unwrap().port;
        self.publish("failed", port, Some(detail))
    }

    /// Bring the server up, or adopt one that is already listening on the
    /// resolved port. Returns the port the window should load.
    pub async fn start(&self) -> Result<u16, String> {
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(child) = inner.child.as_mut() {
                if matches!(child.try_wait(), Ok(None)) {
                    // Already ours and still running.
                    return Ok(inner.port);
                }
            }
        }

        // Adopt a server that is already serving before looking for a free port.
        //
        // Order matters. Scanning for a free port first would skip straight past
        // the documented port whenever something already listens there — which is
        // exactly the case where a Paperclip the user started themselves is
        // running — and the shell would then try to start a second server against
        // the same database.
        let preferred = launch::preferred_port()?;
        if launch::probe_health(preferred) {
            self.inner.lock().unwrap().port = preferred;
            self.publish(
                "ready",
                preferred,
                Some("Attached to a Paperclip server that was already running".to_string()),
            );
            return Ok(preferred);
        }

        let port = launch::resolve_port()?;
        if launch::probe_health(port) {
            self.inner.lock().unwrap().port = port;
            self.publish(
                "ready",
                port,
                Some("Attached to a Paperclip server that was already running".to_string()),
            );
            return Ok(port);
        }

        let resolved = launch::resolve_server_launch()?;
        self.publish(
            "starting",
            port,
            Some(format!("Starting Paperclip from {}", resolved.source)),
        );

        let mut child = Command::new(&resolved.program)
            .args(&resolved.args)
            // The server resolves its UI bundle, instance data, and config
            // relative to the process, so it needs the checkout root rather than
            // whatever directory the shell happened to be launched from.
            .current_dir(
                resolved
                    .cwd
                    .as_deref()
                    .unwrap_or_else(|| std::path::Path::new(".")),
            )
            // The shell owns the port; the server must not pick its own.
            .env("PORT", port.to_string())
            // Both of these, not just the host. `PAPERCLIP_BIND_HOST` alone does
            // not hold: the server resolves `bind` from its config file first,
            // and an instance that was onboarded with `--bind lan` keeps a `lan`
            // value there. A desktop shell that honored it would publish
            // Paperclip on the network the moment it started.
            .env("PAPERCLIP_BIND", "loopback")
            .env("PAPERCLIP_BIND_HOST", "127.0.0.1")
            // The child inherits a working directory the shell was launched
            // from, which may not be a Paperclip checkout at all. Without this,
            // the server would load a `.env` belonging to whatever project the
            // user happened to start the shell from.
            .env("PAPERCLIP_DISABLE_CWD_ENV_FILE", "true")
            .env("PAPERCLIP_MIGRATION_PROMPT", "never")
            .env("PAPERCLIP_MIGRATION_AUTO_APPLY", "true")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| {
                format!(
                    "Could not start {}: {err}",
                    resolved.program.to_string_lossy()
                )
            })?;

        #[cfg(windows)]
        let job = attach_job(&child);
        #[cfg(windows)]
        if job.is_none() {
            // AssignProcessToJobObject fails under nested-job restrictions
            // (sandboxes, AppContainer, some CI). The child is still ours and
            // `stop` still kills it, but killing the *shell* would no longer
            // take the server with it, and that guarantee should not disappear
            // silently.
            record_shell_failure(
                &self.log_path,
                "warning: could not attach the server to a Windows job object. Closing the \
                 window still stops the server, but force-quitting the shell may leave it running.",
            );
        }

        // Drain both pipes into the log file. Without draining, a chatty server
        // fills the pipe buffer and blocks forever.
        if let Some(stdout) = child.stdout.take() {
            spawn_pump(stdout, self.log_path.clone(), "stdout");
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_pump(stderr, self.log_path.clone(), "stderr");
        }

        {
            let mut inner = self.inner.lock().unwrap();
            inner.child = Some(child);
            inner.port = port;
            #[cfg(windows)]
            {
                inner.job = job;
            }
        }

        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            if self.stopping.load(std::sync::atomic::Ordering::SeqCst) {
                self.stop();
                return Err("Startup cancelled".to_string());
            }
            {
                let mut inner = self.inner.lock().unwrap();
                match inner.child.as_mut() {
                    None => return Err("Paperclip process disappeared during startup".to_string()),
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => {
                            inner.child = None;
                            return Err(format!(
                                "Paperclip exited during startup ({status}).{}",
                                tail_log(&self.log_path, 20)
                            ));
                        }
                        Ok(None) => {}
                        Err(err) => {
                            inner.child = None;
                            return Err(format!("Lost track of the Paperclip process: {err}"));
                        }
                    },
                }
            }

            if launch::probe_health(port) {
                self.publish("ready", port, None);
                return Ok(port);
            }
            if Instant::now() >= deadline {
                self.stop();
                return Err(format!(
                    "Paperclip did not become healthy within {}s. Logs: {}",
                    READY_TIMEOUT.as_secs(),
                    self.log_path.display()
                ));
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    /// Stop the server if this shell owns it. Idempotent.
    pub fn stop(&self) {
        self.stopping
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let mut guard = self.inner.lock().unwrap();
        let Some(mut child) = guard.child.take() else {
            return;
        };
        terminate(&mut child);
        // Reap so the child does not linger as a zombie on Unix.
        let _ = child.wait();
        #[cfg(windows)]
        {
            // KILL_ON_JOB_CLOSE is set at creation, so closing the handle is
            // itself the kill for anything still in the job.
            if let Some(job) = guard.job.take() {
                unsafe {
                    windows_sys::Win32::Foundation::CloseHandle(job.0);
                }
            }
        }
        let _ = &guard;
    }

    /// Stop then start again. Used by the boot window's retry action.
    pub async fn restart(&self) -> Result<u16, String> {
        self.stop();
        self.stopping
            .store(false, std::sync::atomic::Ordering::SeqCst);
        self.start().await
    }
}

fn spawn_pump<R: std::io::Read + Send + 'static>(
    reader: R,
    path: std::path::PathBuf,
    stream_name: &'static str,
) {
    std::thread::spawn(move || {
        let Some(file) = open_append(&path) else {
            return;
        };
        let mut writer = std::io::BufWriter::new(file);
        let _ = writeln!(writer, "--- {stream_name} ---");
        let _ = writer.flush();
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            let _ = writeln!(writer, "{line}");
            // Flush per line. A server can take a minute to bind its port, and
            // a user watching a boot screen with an empty log has nothing to
            // go on while that happens.
            let _ = writer.flush();
        }
        let _ = writer.flush();
    });
}

fn open_append(path: &std::path::Path) -> Option<std::fs::File> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

/// Record a shell-level failure in the same log the server writes to.
///
/// A release build sets `windows_subsystem = "windows"`, so it has no console to
/// print to. Without this, a startup failure would leave the boot page as the
/// only account of what went wrong.
pub fn record_shell_failure(log_path: &std::path::Path, message: &str) {
    let Some(mut file) = open_append(log_path) else {
        return;
    };
    let _ = writeln!(file, "--- desktop shell ---");
    let _ = writeln!(file, "{message}");
    let _ = file.flush();
}

fn tail_log(path: &std::path::Path, lines: usize) -> String {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let tail: Vec<&str> = contents.lines().rev().take(lines).collect();
    if tail.is_empty() {
        return String::new();
    }
    let mut out = String::from("\nLast log lines:\n");
    for line in tail.into_iter().rev() {
        out.push_str("  ");
        out.push_str(line);
        out.push('\n');
    }
    out
}

#[cfg(unix)]
fn terminate(child: &mut Child) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    // SIGTERM first so the server can flush, then escalate.
    unsafe {
        kill(child.id() as i32, 15);
    }
    let deadline = Instant::now() + STOP_GRACE;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => break,
        }
    }
    let _ = child.kill();
}

#[cfg(windows)]
fn terminate(child: &mut Child) {
    let _ = child.kill();
}

#[cfg(windows)]
fn attach_job(child: &Child) -> Option<JobHandle> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    unsafe {
        let job: HANDLE = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            CloseHandle(job);
            return None;
        }
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child.id());
        if process.is_null() {
            CloseHandle(job);
            return None;
        }
        let assigned = AssignProcessToJobObject(job, process);
        CloseHandle(process);
        if assigned == 0 {
            CloseHandle(job);
            return None;
        }
        Some(JobHandle(job))
    }
}

/// Register the handle so commands and the exit hook can reach it.
pub fn install<R: Runtime>(app: &AppHandle<R>, handle: ServerHandle<R>) {
    app.manage(std::sync::Arc::new(handle));
}

/// Reap the server on window close or app exit. Called from both paths because
/// either one can be the first to run on a given platform.
pub fn stop_on_exit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(handle) = app.try_state::<std::sync::Arc<ServerHandle<R>>>() {
        handle.stop();
    }
}
