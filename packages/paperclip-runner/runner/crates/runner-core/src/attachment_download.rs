use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};

use reqwest::{blocking::Client, redirect::Policy, StatusCode, Url};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::durable::{DurableRunnerError, EventPriority, PolledEvent};

pub(crate) const DOWNLOAD_COMMAND: &str = "runner.attachment.download";
pub(crate) const DOWNLOAD_RESULT_EVENT: &str = "runner.attachment.settled";
const MAX_ATTACHMENT_BYTES: u64 = 10 * 1024 * 1024;
const MAX_TURN_BYTES: u64 = 128 * 1024 * 1024;
const MAX_TURN_FILES: usize = 128;

fn download_directory(state_dir: &Path) -> PathBuf {
    state_dir.join("attachment-downloads")
}

pub(crate) fn codex_attachment_read_args(args: &[String], state_dir: &Path) -> Vec<String> {
    let directory = download_directory(state_dir);
    let Some(directory) = directory.to_str() else {
        return Vec::new();
    };
    let mut extra = Vec::new();
    for profile in [
        "paperclip-runner-workspace-only",
        "paperclip-runner-workspace-read-only",
    ] {
        let prefix = format!("permissions.{profile}.filesystem=");
        let Some(value) = args.iter().rev().find_map(|arg| arg.strip_prefix(&prefix)) else {
            continue;
        };
        let Ok(mut config) = format!("filesystem={value}").parse::<toml_edit::DocumentMut>() else {
            continue;
        };
        let Some(filesystem) = config["filesystem"].as_inline_table_mut() else {
            continue;
        };
        filesystem.insert(directory, "read".into());
        extra.extend(["-c".to_owned(), format!("{prefix}{filesystem}")]);
    }
    extra
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AttachmentGrant {
    turn_id: String,
    url: String,
    token: String,
    byte_size: u64,
    sha256: String,
    content_type: String,
}

impl AttachmentGrant {
    fn validate(&self, active_turn: &str) -> Result<Url, DurableRunnerError> {
        let invalid = || DurableRunnerError::invalid("attachment download grant is invalid");
        let url = Url::parse(&self.url).map_err(|_| invalid())?;
        if self.turn_id != active_turn
            || self.byte_size > MAX_ATTACHMENT_BYTES
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !(32..=1024).contains(&self.token.len())
            || !self
                .token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
            || self.url.len() > 2048
            || url.scheme() != "https"
            || !url.has_host()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid());
        }
        Ok(url)
    }

    fn extension(&self) -> &'static str {
        match self.content_type.as_str() {
            "image/png" => ".png",
            "image/jpeg" => ".jpg",
            "image/gif" => ".gif",
            "image/webp" => ".webp",
            "application/pdf" => ".pdf",
            _ => "",
        }
    }
}

pub(crate) struct DownloadedAttachment {
    bytes: Vec<u8>,
    extension: &'static str,
}

struct PendingDownload {
    id: Uuid,
    worker: JoinHandle<()>,
    result: Option<Receiver<Result<DownloadedAttachment, DurableRunnerError>>>,
}

pub(crate) struct AttachmentDownloads {
    directory: PathBuf,
    ready: bool,
    closed: bool,
    bytes: u64,
    files: usize,
    pending: Option<PendingDownload>,
}

impl AttachmentDownloads {
    pub(crate) fn new(state_dir: &Path) -> Self {
        Self {
            directory: download_directory(state_dir),
            ready: false,
            closed: false,
            bytes: 0,
            files: 0,
            pending: None,
        }
    }

    pub(crate) fn initialize(&mut self) -> Result<(), DurableRunnerError> {
        self.prepare_directory()
            .map_err(|_| DurableRunnerError::invalid("attachment download directory unavailable"))
    }

    fn prepare_directory(&mut self) -> io::Result<()> {
        self.clear()?;
        let mut builder = DirBuilder::new();
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(&self.directory)?;
        self.ready = true;
        Ok(())
    }

    pub(crate) fn start(
        &mut self,
        grant: AttachmentGrant,
        turn_id: &str,
    ) -> Result<Uuid, DurableRunnerError> {
        let url = grant.validate(turn_id)?;
        if self.closed
            || self.bytes + grant.byte_size > MAX_TURN_BYTES
            || self.files >= MAX_TURN_FILES
        {
            return Err(DurableRunnerError::invalid(
                "attachment download scope is closed or full",
            ));
        }
        self.start_worker(move || fetch_attachment(url, grant))
    }

    fn start_worker(
        &mut self,
        fetch: impl FnOnce() -> Result<DownloadedAttachment, DurableRunnerError> + Send + 'static,
    ) -> Result<Uuid, DurableRunnerError> {
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.result.is_none() && pending.worker.is_finished())
        {
            self.pending = None;
        }
        if self.pending.is_some() {
            return Err(DurableRunnerError::invalid(
                "attachment download already in progress",
            ));
        }
        let id = Uuid::new_v4();
        let (send, receive) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("attachment-download".to_owned())
            .spawn(move || {
                let _ = send.send(fetch());
            })
            .map_err(|_| DurableRunnerError::invalid("attachment download could not start"))?;
        self.pending = Some(PendingDownload {
            id,
            worker,
            result: Some(receive),
        });
        Ok(id)
    }

    pub(crate) fn take_result_event(&mut self) -> Option<PolledEvent> {
        let pending = self.pending.as_ref()?;
        let received = match pending.result.as_ref()?.try_recv() {
            Ok(result) => result,
            Err(TryRecvError::Empty) => return None,
            Err(TryRecvError::Disconnected) => {
                Err(DurableRunnerError::invalid("attachment download failed"))
            }
        };
        let id = pending.id.to_string();
        self.pending = None;
        let payload = match received
            .ok()
            .and_then(|downloaded| self.store(downloaded).ok())
        {
            Some(path) => json!({"downloadId": id, "status": "ready", "path": path}),
            None => json!({"downloadId": id, "status": "failed"}),
        };
        Some(PolledEvent {
            executor_event_id: format!("runner-attachment-{id}"),
            event_type: DOWNLOAD_RESULT_EVENT.to_owned(),
            priority: EventPriority::P0,
            payload,
        })
    }

    fn store(&mut self, downloaded: DownloadedAttachment) -> io::Result<PathBuf> {
        if !self.ready {
            self.prepare_directory()?;
        }
        let path = self
            .directory
            .join(format!("{}{}", Uuid::new_v4(), downloaded.extension));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&path)?;
        if let Err(error) = file.write_all(&downloaded.bytes) {
            drop(file);
            fs::remove_file(&path)?;
            return Err(error);
        }
        self.bytes += downloaded.bytes.len() as u64;
        self.files += 1;
        Ok(path)
    }

    pub(crate) fn close(&mut self) {
        self.closed = true;
        if let Some(pending) = &mut self.pending {
            pending.result = None;
            if pending.worker.is_finished() {
                self.pending = None;
            }
        }
        if self.clear().is_err() {
            eprintln!("paperclip-runnerd: attachment download cleanup failed");
        }
    }

    pub(crate) fn finish_turn(&mut self) {
        if !self.closed {
            self.reset();
        }
    }

    pub(crate) fn open_next_turn(&mut self) {
        if self.closed {
            self.reset();
        }
    }

    pub(crate) fn reset(&mut self) {
        self.close();
        self.closed = false;
    }

    fn clear(&mut self) -> io::Result<()> {
        self.ready = false;
        match fs::remove_dir_all(&self.directory) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        self.bytes = 0;
        self.files = 0;
        Ok(())
    }
}

impl Drop for AttachmentDownloads {
    fn drop(&mut self) {
        self.close();
    }
}

fn fetch_attachment(
    url: Url,
    grant: AttachmentGrant,
) -> Result<DownloadedAttachment, DurableRunnerError> {
    let failed = || DurableRunnerError::invalid("attachment download failed");
    let client = Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| failed())?;
    let response = client
        .get(url)
        .bearer_auth(&grant.token)
        .send()
        .map_err(|_| failed())?;
    if response.status() != StatusCode::OK
        || response
            .content_length()
            .is_some_and(|size| size != grant.byte_size)
    {
        return Err(failed());
    }
    read_verified(response, &grant).map_err(|_| failed())
}

fn read_verified(
    mut source: impl Read,
    grant: &AttachmentGrant,
) -> io::Result<DownloadedAttachment> {
    let mut bytes = Vec::with_capacity(grant.byte_size as usize);
    let mut buffer = [0; 16 * 1024];
    let mut digest = Sha256::new();
    let mut remaining = grant.byte_size;
    loop {
        let limit = (remaining + 1).min(buffer.len() as u64) as usize;
        let count = source.read(&mut buffer[..limit])?;
        if count == 0 {
            break;
        }
        remaining = remaining
            .checked_sub(count as u64)
            .ok_or(io::ErrorKind::InvalidData)?;
        digest.update(&buffer[..count]);
        bytes.extend_from_slice(&buffer[..count]);
    }
    if remaining != 0 || format!("{:x}", digest.finalize()) != grant.sha256 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(DownloadedAttachment {
        bytes,
        extension: grant.extension(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(bytes: &[u8]) -> AttachmentGrant {
        AttachmentGrant {
            turn_id: "turn-a".into(),
            url: "https://tenant.example/runner/attachment".into(),
            token: "a".repeat(43),
            byte_size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            content_type: "image/png".into(),
        }
    }

    #[test]
    fn accepts_only_an_https_grant_for_the_bound_turn() {
        let mut input = grant(b"image");
        assert!(input.validate("turn-a").is_ok());
        assert!(input.validate("turn-b").is_err());
        for url in [
            "http://tenant.example/file",
            "https://tenant.example/file?ticket=secret",
            "https://user@tenant.example/file",
        ] {
            input.url = url.into();
            assert!(input.validate("turn-a").is_err());
        }
    }

    #[test]
    fn command_requires_prp_v3() {
        let mut command: crate::durable::Command = serde_json::from_value(serde_json::json!({
            "schema": "paperclip.prp.command.v3",
            "commandId": "download-1",
            "controllerSeq": 1,
            "type": DOWNLOAD_COMMAND,
            "issuedAt": "2099-01-01T00:00:00Z",
            "payload": {},
        }))
        .unwrap();
        assert!(command.validate().is_ok());
        command.schema = "paperclip.prp.command.v2".into();
        assert!(command.validate().is_err());
    }

    #[test]
    fn verifies_files_and_clears_them_across_warm_turns() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir(&root).unwrap();
        let mut downloads = AttachmentDownloads::new(&root);
        let input = grant(b"image");
        fs::create_dir(&downloads.directory).unwrap();
        fs::write(downloads.directory.join("old.png"), b"old turn").unwrap();
        downloads.initialize().unwrap();
        assert_eq!(fs::read_dir(&downloads.directory).unwrap().count(), 0);
        for bytes in [b"im".as_slice(), b"images", b"wrong"] {
            assert!(read_verified(bytes, &input).is_err());
        }
        let first = downloads
            .store(read_verified(b"image".as_slice(), &input).unwrap())
            .unwrap();
        assert_eq!(first.extension().unwrap(), "png");
        assert_eq!(fs::read(&first).unwrap(), b"image");
        downloads.close();
        assert!(downloads.start(grant(b"image"), "turn-a").is_err());
        assert!(!first.exists());
        downloads.open_next_turn();
        let second = downloads
            .store(read_verified(b"image".as_slice(), &input).unwrap())
            .unwrap();
        assert_ne!(first, second);
        drop(downloads);
        assert!(!second.exists());
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn emits_one_durable_result_for_a_download() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir(&root).unwrap();
        let mut downloads = AttachmentDownloads::new(&root);
        let input = grant(b"image");
        let id = downloads
            .start_worker(move || Ok(read_verified(b"image".as_slice(), &input).unwrap()))
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let event = loop {
            if let Some(event) = downloads.take_result_event() {
                break event;
            }
            assert!(std::time::Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(event.event_type, DOWNLOAD_RESULT_EVENT);
        assert_eq!(event.payload["downloadId"], id.to_string());
        assert_eq!(event.payload["status"], "ready");
        let path = PathBuf::from(event.payload["path"].as_str().unwrap());
        assert_eq!(fs::read(&path).unwrap(), b"image");
        assert!(downloads.take_result_event().is_none());
        drop(downloads);
        assert!(!path.exists());
        fs::remove_dir(root).unwrap();
    }

    #[test]
    #[ignore = "requires the source-pinned Codex sandbox command"]
    fn restricted_provider_reads_a_download_without_access_to_runner_state() {
        use std::process::Command;

        let codex = std::env::var_os("PAPERCLIP_ATTACHMENT_CODEX_SANDBOX_COMMAND")
            .expect("set the pinned Codex CLI path");
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(Uuid::new_v4().to_string());
        let state = root.join("runner-state");
        let workspace = root.join("workspace");
        let home = root.join("home");
        for directory in [&state, &workspace, &home] {
            fs::create_dir_all(directory).unwrap();
        }
        let unrelated = state.join("controller.json");
        fs::write(&unrelated, b"unrelated private state").unwrap();
        let mut downloads = AttachmentDownloads::new(&state);
        downloads.initialize().unwrap();
        let input = grant(b"fixture image");
        let path = downloads
            .store(read_verified(b"fixture image".as_slice(), &input).unwrap())
            .unwrap();
        let profile = "paperclip-runner-workspace-read-only";
        let mut args = vec!["-c".to_owned(), format!("permissions.{profile}.filesystem={{\":root\"=\"none\",\":minimal\"=\"read\",\":tmpdir\"=\"none\",\"{}\"=\"read\"}}", workspace.display())];
        args.extend(codex_attachment_read_args(&args, &state));
        let output = Command::new(codex)
            .args(args)
            .args(["sandbox", "-P", profile, "-C"])
            .arg(&workspace)
            .args([
                "--",
                "/bin/sh",
                "-ec",
                r#"
test "$(cat "$1")" = 'fixture image'
if cat "$2" >/dev/null 2>&1; then exit 71; fi
if (printf x >> "$1") 2>/dev/null; then exit 72; fi
"#,
                "attachment-reader",
            ])
            .arg(&path)
            .arg(&unrelated)
            .env("HOME", &home)
            .env("CODEX_HOME", &home)
            .output()
            .unwrap();
        drop(downloads);
        fs::remove_dir_all(root).unwrap();
        assert!(
            output.status.success(),
            "restricted reader failed: {} {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn cancelling_a_slow_attachment_does_not_wait_for_the_transfer() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir(&root).unwrap();
        let mut downloads = AttachmentDownloads::new(&root);
        let (release, blocked) = std::sync::mpsc::channel();
        downloads
            .start_worker(move || {
                blocked.recv().unwrap();
                Ok(DownloadedAttachment {
                    bytes: b"image".to_vec(),
                    extension: ".png",
                })
            })
            .unwrap();
        assert_eq!(downloads.take_result_event(), None);
        downloads.close();
        assert!(downloads.take_result_event().is_none());
        release.send(()).unwrap();
        let pending = downloads.pending.take().unwrap();
        pending.worker.join().unwrap();
        assert!(!downloads.directory.exists());
        fs::remove_dir(root).unwrap();
    }
}
