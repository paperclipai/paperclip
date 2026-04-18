use std::collections::HashMap;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use tokio::process::Child;
use tokio::sync::Mutex;

struct ManagedService {
    child: Child,
    port: Option<u16>,
    started_at: std::time::Instant,
    idle_handle: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Clone)]
pub struct RuntimeServices {
    active: Arc<Mutex<HashMap<String, ManagedService>>>,
    next_port: Arc<AtomicU16>,
}

impl RuntimeServices {
    pub fn new() -> Self {
        Self {
            active: Arc::new(Mutex::new(HashMap::new())),
            next_port: Arc::new(AtomicU16::new(9000)),
        }
    }

    pub async fn start_service(
        &self,
        name: &str,
        command: &str,
        cwd: &str,
    ) -> Result<(), String> {
        let mut active = self.active.lock().await;

        if active.contains_key(name) {
            return Err(format!("Service '{name}' is already running"));
        }

        let parts: Vec<&str> = command.split_whitespace().collect();
        if parts.is_empty() {
            return Err("Empty command".to_string());
        }

        let port = self.next_port.fetch_add(1, Ordering::SeqCst);

        let child = tokio::process::Command::new(parts[0])
            .args(&parts[1..])
            .current_dir(cwd)
            .env("PORT", port.to_string())
            .env("ARCHONOS_SERVICE_PORT", port.to_string())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start service '{name}': {e}"))?;

        // Set up idle timer
        let active_clone = self.active.clone();
        let name_clone = name.to_string();
        let idle_handle = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            // Auto-kill after 60s idle
            if let Some(mut svc) = active_clone.lock().await.remove(&name_clone) {
                let _ = svc.child.kill().await;
            }
        });

        active.insert(
            name.to_string(),
            ManagedService {
                child,
                port: Some(port),
                started_at: std::time::Instant::now(),
                idle_handle: Some(idle_handle),
            },
        );
        Ok(())
    }

    pub async fn stop_service(&self, name: &str) -> Result<(), String> {
        let mut active = self.active.lock().await;

        match active.remove(name) {
            Some(mut svc) => {
                if let Some(h) = svc.idle_handle {
                    h.abort();
                }
                svc.child
                    .kill()
                    .await
                    .map_err(|e| format!("Failed to kill service '{name}': {e}"))?;
                Ok(())
            }
            None => Err(format!("Service '{name}' is not running")),
        }
    }

    pub async fn stop_all(&self) -> Result<(), String> {
        let mut active = self.active.lock().await;
        let mut errors = Vec::new();

        let names: Vec<String> = active.keys().cloned().collect();
        for name in names {
            if let Some(mut svc) = active.remove(&name) {
                if let Some(h) = svc.idle_handle {
                    h.abort();
                }
                if let Err(e) = svc.child.kill().await {
                    errors.push(format!("{name}: {e}"));
                }
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Failed to stop some services: {}",
                errors.join(", ")
            ))
        }
    }

    pub async fn touch_service(&self, name: &str) {
        let mut active = self.active.lock().await;
        if let Some(svc) = active.get_mut(name) {
            if let Some(h) = svc.idle_handle.take() {
                h.abort();
            }
            let active_clone = self.active.clone();
            let name_clone = name.to_string();
            svc.idle_handle = Some(tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                if let Some(mut svc) = active_clone.lock().await.remove(&name_clone) {
                    let _ = svc.child.kill().await;
                }
            }));
        }
    }

    pub async fn get_service_port(&self, name: &str) -> Option<u16> {
        self.active.lock().await.get(name).and_then(|s| s.port)
    }
}
