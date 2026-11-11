use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
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

    fn extension(&self) -> &str {
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

pub(crate) struct AttachmentDownloads {
    directory: PathBuf,
    ready: bool,
    closed: bool,
    bytes: u64,
    files: usize,
}

impl AttachmentDownloads {
    pub(crate) fn new(state_dir: &Path) -> Self {
        Self {
            directory: state_dir.join("attachment-downloads"),
            ready: false,
            closed: false,
            bytes: 0,
            files: 0,
        }
    }

    pub(crate) fn download(
        &mut self,
        grant: AttachmentGrant,
        turn_id: &str,
    ) -> Result<PathBuf, DurableRunnerError> {
        let url = grant.validate(turn_id)?;
        if self.closed
            || self.bytes + grant.byte_size > MAX_TURN_BYTES
            || self.files >= MAX_TURN_FILES
        {
            return Err(DurableRunnerError::invalid(
                "attachment download scope is closed or full",
            ));
        }
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
        self.store(&grant, response).map_err(|_| failed())
    }

    fn store(&mut self, grant: &AttachmentGrant, source: impl Read) -> io::Result<PathBuf> {
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
            .join(format!("{}{}", Uuid::new_v4(), grant.extension()));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&path)?;
        if let Err(error) = copy_verified(source, &mut file, grant) {
            drop(file);
            fs::remove_file(&path)?;
            return Err(error);
        }
        self.bytes += grant.byte_size;
        self.files += 1;
        Ok(path)
    }

    pub(crate) fn close(&mut self) {
        self.closed = true;
        if self.clear().is_err() {
            eprintln!("paperclip-runnerd: attachment download cleanup failed");
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

fn copy_verified(
    mut source: impl Read,
    file: &mut File,
    grant: &AttachmentGrant,
) -> io::Result<()> {
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
        file.write_all(&buffer[..count])?;
    }
    if remaining != 0 || format!("{:x}", digest.finalize()) != grant.sha256 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(())
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
        for bytes in [b"im".as_slice(), b"images", b"wrong"] {
            assert!(downloads.store(&input, bytes).is_err());
            assert_eq!(fs::read_dir(&downloads.directory).unwrap().count(), 0);
        }
        let first = downloads.store(&input, b"image".as_slice()).unwrap();
        assert_eq!(first.extension().unwrap(), "png");
        assert_eq!(fs::read(&first).unwrap(), b"image");
        downloads.close();
        assert!(downloads.download(grant(b"image"), "turn-a").is_err());
        assert!(!first.exists());
        downloads.reset();
        let second = downloads.store(&input, b"image".as_slice()).unwrap();
        assert_ne!(first, second);
        drop(downloads);
        assert!(!second.exists());
        fs::remove_dir(root).unwrap();
    }
}
