//! A connection owns a shared lifetime fence until SQLite has closed. Moving a
//! store requires the exclusive fence; per-operation locks alone are too short.
use crate::durable::{open_private_regular_file, verify_private_directory, DurableRunnerError};
use crate::indexed_store::storage_error;
use std::{
    fs,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, DurableRunnerError>;
pub(crate) struct StoreLifetime(fs::File);
pub(crate) fn archive_fence(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".archive");
    PathBuf::from(name)
}
impl StoreLifetime {
    pub(crate) fn existing_exclusive(path: &Path) -> Result<Self> {
        let file =
            open_private_regular_file(&PathBuf::from(format!("{}.lifetime", path.display())))
                .map_err(storage_error)?;
        file.try_lock().map_err(|_| {
            DurableRunnerError::invalid(
                "storage_pressure: indexed store still has an open connection",
            )
        })?;
        Ok(Self(file))
    }
    pub(crate) fn existing_shared(path: &Path) -> Result<Self> {
        let file =
            open_private_regular_file(&PathBuf::from(format!("{}.lifetime", path.display())))
                .map_err(storage_error)?;
        file.try_lock_shared().map_err(|_| {
            DurableRunnerError::invalid("storage_pressure: indexed store is being archived")
        })?;
        let lock = Self(file);
        match fs::symlink_metadata(archive_fence(path)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(lock),
            _ => Err(DurableRunnerError::invalid(
                "indexed archive must finish before reading receipts",
            )),
        }
    }
    fn file(path: &Path) -> Result<fs::File> {
        verify_private_directory(
            path.parent()
                .ok_or_else(|| DurableRunnerError::invalid("store has no parent"))?,
        )?;
        let mut name = path.as_os_str().to_os_string();
        name.push(".lifetime");
        let path = PathBuf::from(name);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => file.sync_all().map_err(storage_error)?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(storage_error(e)),
        }
        open_private_regular_file(&path).map_err(storage_error)
    }
    pub(crate) fn shared(path: &Path) -> Result<Self> {
        let file = Self::file(path)?;
        file.try_lock_shared().map_err(|_| {
            DurableRunnerError::invalid("storage_pressure: indexed store is being archived")
        })?;
        let lock = Self(file);
        match fs::symlink_metadata(archive_fence(path)) {
            Ok(_) => {
                return Err(DurableRunnerError::invalid(
                    "storage_pressure: indexed archive must finish before opening the store",
                ))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(storage_error(e)),
        }
        Ok(lock)
    }
    pub(crate) fn exclusive(path: &Path) -> Result<Self> {
        let file = Self::file(path)?;
        file.try_lock().map_err(|_| {
            DurableRunnerError::invalid(
                "storage_pressure: indexed store still has an open connection",
            )
        })?;
        Ok(Self(file))
    }
}
impl Drop for StoreLifetime {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}
