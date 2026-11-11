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
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::durable::DurableRunnerError;

pub(crate) const DOWNLOAD_COMMAND: &str = "runner.attachment.download";
const MAX_ATTACHMENT_BYTES: u64 = 10 * 1024 * 1024;
const MAX_TURN_BYTES: u64 = 128 * 1024 * 1024;
const MAX_TURN_FILES: usize = 128;

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AttachmentDownloadPoll {
    pub(crate) download_id: String,
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
            directory: state_dir.join("attachment-downloads"),
            ready: false,
            closed: false,
            bytes: 0,
            files: 0,
            pending: None,
        }
    }

    pub(crate) fn initialize(&mut self) -> Result<(), DurableRunnerError> {
        self.clear()
            .map_err(|_| DurableRunnerError::invalid("attachment download cleanup failed"))
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

    pub(crate) fn poll(&mut self, id: Uuid) -> Result<Option<PathBuf>, DurableRunnerError> {
        let Some(result) = self
            .pending
            .as_ref()
            .filter(|pending| pending.id == id)
            .and_then(|pending| pending.result.as_ref())
        else {
            return Err(DurableRunnerError::invalid(
                "attachment download is no longer available",
            ));
        };
        let received = match result.try_recv() {
            Ok(result) => result,
            Err(TryRecvError::Empty) => return Ok(None),
            Err(TryRecvError::Disconnected) => {
                Err(DurableRunnerError::invalid("attachment download failed"))
            }
        };
        self.pending = None;
        let downloaded = received?;
        self.store(downloaded)
            .map(Some)
            .map_err(|_| DurableRunnerError::invalid("attachment download write failed"))
    }

    fn store(&mut self, downloaded: DownloadedAttachment) -> io::Result<PathBuf> {
        if !self.ready {
            self.clear()?;
            let mut builder = DirBuilder::new();
            #[cfg(unix)]
            builder.mode(0o700);
            builder.create(&self.directory)?;
            self.ready = true;
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
        assert!(!downloads.directory.exists());
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
    fn cancelling_a_slow_attachment_does_not_wait_for_the_transfer() {
        let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir(&root).unwrap();
        let mut downloads = AttachmentDownloads::new(&root);
        let (release, blocked) = std::sync::mpsc::channel();
        let id = downloads
            .start_worker(move || {
                blocked.recv().unwrap();
                Ok(DownloadedAttachment {
                    bytes: b"image".to_vec(),
                    extension: ".png",
                })
            })
            .unwrap();
        assert_eq!(downloads.poll(id).unwrap(), None);
        downloads.close();
        assert!(downloads.poll(id).is_err());
        release.send(()).unwrap();
        let pending = downloads.pending.take().unwrap();
        pending.worker.join().unwrap();
        assert!(!downloads.directory.exists());
        fs::remove_dir(root).unwrap();
    }
}
