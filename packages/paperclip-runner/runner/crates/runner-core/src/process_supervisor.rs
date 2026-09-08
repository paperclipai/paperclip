use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::os::fd::AsRawFd;

#[cfg(target_os = "macos")]
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt, PermissionsExt};

#[cfg(target_os = "macos")]
use uuid::Uuid;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::local_runner::LocalRunnerError;

const PROCESS_OUTPUT_QUEUE_CAPACITY: usize = 256;
const VERIFIED_RUNTIME_EXECUTABLE_ENV: &str = "PAPERCLIP_VERIFIED_RUNTIME_EXECUTABLE";
const VERIFIED_COMMONJS_ARTIFACT_LOADER: &str = r#"const fs=require("node:fs");const Module=require("node:module");const filename=process.argv[1];const source=fs.readFileSync(filename,"utf8").replace(/^#![^\r\n]*(?:\r?\n|$)/,"");const artifact=new Module(filename);artifact.filename=filename;artifact.paths=[];artifact._compile(source,filename);"#;

pub(crate) fn is_node_interpreter(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| matches!(name, "node" | "nodejs" | "node.exe"))
}

#[derive(Clone, Debug)]
pub struct VerifiedProcessArtifact {
    display_path: PathBuf,
    file: Arc<File>,
}

impl VerifiedProcessArtifact {
    pub fn snapshot_verified(
        display_path: PathBuf,
        mut file: File,
        expected_sha256: &str,
    ) -> Result<Self, LocalRunnerError> {
        file.seek(SeekFrom::Start(0)).map_err(|error| {
            LocalRunnerError::invalid(format!(
                "failed to rewind verified process artifact {}: {error}",
                display_path.display()
            ))
        })?;
        #[cfg(target_os = "linux")]
        let file = sealed_snapshot(&display_path, &mut file, expected_sha256)?;
        #[cfg(target_os = "macos")]
        let file = unlinked_snapshot(&display_path, &mut file, expected_sha256)?;
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        return Err(LocalRunnerError::invalid(
            "verified process snapshots are supported only on Linux and macOS",
        ));
        Ok(Self {
            display_path,
            file: Arc::new(file),
        })
    }
}

#[cfg(target_os = "linux")]
fn sealed_snapshot(
    display_path: &Path,
    source: &mut File,
    expected_sha256: &str,
) -> Result<File, LocalRunnerError> {
    use rustix::fs::{MemfdFlags, Mode, SealFlags};

    let flags = MemfdFlags::CLOEXEC | MemfdFlags::ALLOW_SEALING | MemfdFlags::EXEC;
    let fd = match rustix::fs::memfd_create("paperclip-verified-launch", flags) {
        Ok(fd) => fd,
        Err(rustix::io::Errno::INVAL) => rustix::fs::memfd_create(
            "paperclip-verified-launch",
            MemfdFlags::CLOEXEC | MemfdFlags::ALLOW_SEALING,
        )
        .map_err(|error| snapshot_error(display_path, error))?,
        Err(error) => return Err(snapshot_error(display_path, error)),
    };
    let mut snapshot = File::from(fd);
    copy_verified(source, &mut snapshot, display_path, expected_sha256)?;
    snapshot
        .flush()
        .map_err(|error| snapshot_error(display_path, error))?;
    rustix::fs::fchmod(&snapshot, Mode::RUSR | Mode::XUSR)
        .map_err(|error| snapshot_error(display_path, error))?;
    rustix::fs::fcntl_add_seals(
        &snapshot,
        SealFlags::WRITE | SealFlags::GROW | SealFlags::SHRINK | SealFlags::SEAL,
    )
    .map_err(|error| snapshot_error(display_path, error))?;
    snapshot
        .seek(SeekFrom::Start(0))
        .map_err(|error| snapshot_error(display_path, error))?;
    Ok(snapshot)
}

#[cfg(target_os = "macos")]
fn unlinked_snapshot(
    display_path: &Path,
    source: &mut File,
    expected_sha256: &str,
) -> Result<File, LocalRunnerError> {
    let temporary_path = std::env::temp_dir().join(format!(
        ".paperclip-verified-launch-{}",
        Uuid::new_v4().simple()
    ));
    let mut writable = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(&temporary_path)
        .map_err(|error| snapshot_error(display_path, error))?;
    let result = (|| {
        copy_verified(source, &mut writable, display_path, expected_sha256)?;
        writable
            .sync_all()
            .map_err(|error| snapshot_error(display_path, error))?;
        fs::set_permissions(&temporary_path, fs::Permissions::from_mode(0o500))
            .map_err(|error| snapshot_error(display_path, error))?;
        let snapshot =
            File::open(&temporary_path).map_err(|error| snapshot_error(display_path, error))?;
        let written = writable
            .metadata()
            .map_err(|error| snapshot_error(display_path, error))?;
        let opened = snapshot
            .metadata()
            .map_err(|error| snapshot_error(display_path, error))?;
        if written.dev() != opened.dev() || written.ino() != opened.ino() {
            return Err(LocalRunnerError::invalid(format!(
                "verified process snapshot {} changed while it was reopened",
                display_path.display()
            )));
        }
        fs::remove_file(&temporary_path).map_err(|error| snapshot_error(display_path, error))?;
        drop(writable);
        Ok(snapshot)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary_path);
    }
    result
}

fn copy_verified(
    source: &mut File,
    destination: &mut File,
    display_path: &Path,
    expected_sha256: &str,
) -> Result<(), LocalRunnerError> {
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = source
            .read(&mut buffer)
            .map_err(|error| snapshot_error(display_path, error))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        destination
            .write_all(&buffer[..count])
            .map_err(|error| snapshot_error(display_path, error))?;
    }
    let actual = format!("sha256:{:x}", digest.finalize());
    if actual != expected_sha256 {
        return Err(LocalRunnerError::invalid(format!(
            "verified process artifact digest mismatch for {}",
            display_path.display()
        )));
    }
    Ok(())
}

fn snapshot_error(display_path: &Path, error: impl std::fmt::Display) -> LocalRunnerError {
    LocalRunnerError::invalid(format!(
        "failed to create immutable process snapshot for {}: {error}",
        display_path.display()
    ))
}

#[derive(Clone, Debug)]
pub enum VerifiedProcessArgument {
    Literal(String),
    Artifact(VerifiedProcessArtifact),
    CommonJsArtifact(VerifiedProcessArtifact),
    ExecutableArtifact(VerifiedProcessArtifact),
}

#[derive(Clone, Debug)]
pub struct VerifiedProcessLaunch {
    program: VerifiedProcessArtifact,
    args: Vec<VerifiedProcessArgument>,
    inherit_runtime_executable: bool,
}

impl VerifiedProcessLaunch {
    pub fn new(program: VerifiedProcessArtifact, args: Vec<VerifiedProcessArgument>) -> Self {
        Self {
            program,
            args,
            inherit_runtime_executable: false,
        }
    }

    pub fn with_inherited_runtime_executable(mut self) -> Self {
        self.inherit_runtime_executable = true;
        self
    }

    #[cfg(test)]
    pub(crate) fn arguments(&self) -> &[VerifiedProcessArgument] {
        &self.args
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn inherited_command(&self) -> Result<InheritedCommand, LocalRunnerError> {
        let mut inherited = Vec::with_capacity(self.args.len() + 1);
        #[cfg(target_os = "linux")]
        let (program_fd, program) = inherited_artifact(&self.program)?;
        #[cfg(target_os = "linux")]
        inherited.push(program_fd);
        #[cfg(target_os = "macos")]
        let program_snapshot = materialize_executable(&self.program)?;
        #[cfg(target_os = "macos")]
        let program = program_snapshot.path.clone();
        #[cfg(target_os = "macos")]
        let mut temporary_executables = vec![program_snapshot];
        let mut args = Vec::with_capacity(self.args.len());
        for argument in &self.args {
            match argument {
                VerifiedProcessArgument::Literal(value) => args.push(value.clone()),
                VerifiedProcessArgument::Artifact(artifact) => {
                    let (fd, path) = inherited_artifact(artifact)?;
                    inherited.push(fd);
                    args.push(path.to_string_lossy().into_owned());
                }
                VerifiedProcessArgument::CommonJsArtifact(artifact) => {
                    let (fd, path) = inherited_artifact(artifact)?;
                    inherited.push(fd);
                    args.push("--eval".to_owned());
                    args.push(VERIFIED_COMMONJS_ARTIFACT_LOADER.to_owned());
                    args.push(path.to_string_lossy().into_owned());
                }
                VerifiedProcessArgument::ExecutableArtifact(artifact) => {
                    #[cfg(target_os = "linux")]
                    {
                        let (fd, path) = inherited_artifact(artifact)?;
                        inherited.push(fd);
                        args.push(path.to_string_lossy().into_owned());
                    }
                    #[cfg(target_os = "macos")]
                    {
                        let executable = materialize_bound_executable(artifact)?;
                        args.push(executable.path.to_string_lossy().into_owned());
                        temporary_executables.push(executable);
                    }
                }
            }
        }
        Ok(InheritedCommand {
            program,
            args,
            _inherited: inherited,
            #[cfg(target_os = "macos")]
            temporary_executables,
        })
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
struct InheritedCommand {
    program: PathBuf,
    args: Vec<String>,
    _inherited: Vec<rustix::fd::OwnedFd>,
    #[cfg(target_os = "macos")]
    temporary_executables: Vec<TemporaryExecutable>,
}

#[cfg(target_os = "macos")]
struct TemporaryExecutable {
    path: PathBuf,
    cleanup_directory: Option<PathBuf>,
    _file: File,
}

#[cfg(target_os = "macos")]
impl Drop for TemporaryExecutable {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        if let Some(directory) = &self.cleanup_directory {
            let _ = fs::remove_dir(directory);
        }
    }
}

#[cfg(target_os = "macos")]
fn verified_executable_parent(
    artifact: &VerifiedProcessArtifact,
) -> Result<&Path, LocalRunnerError> {
    let directory = artifact.display_path.parent().ok_or_else(|| {
        LocalRunnerError::invalid(format!(
            "verified process artifact {} has no parent directory",
            artifact.display_path.display()
        ))
    })?;
    let directory_metadata = fs::symlink_metadata(directory)
        .map_err(|error| snapshot_error(&artifact.display_path, error))?;
    if !directory_metadata.is_dir() || directory_metadata.permissions().mode() & 0o022 != 0 {
        return Err(LocalRunnerError::invalid(format!(
            "verified process artifact directory {} must be a directory that is not group- or world-writable",
            directory.display()
        )));
    }
    Ok(directory)
}

#[cfg(target_os = "macos")]
fn materialize_executable_at(
    artifact: &VerifiedProcessArtifact,
    path: PathBuf,
    cleanup_directory: Option<PathBuf>,
) -> Result<TemporaryExecutable, LocalRunnerError> {
    let mut writable = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(&path)
        .map_err(|error| snapshot_error(&artifact.display_path, error))?;
    let result = (|| {
        let length = artifact
            .file
            .metadata()
            .map_err(|error| snapshot_error(&artifact.display_path, error))?
            .len();
        let mut offset = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        while offset < length {
            let count = artifact
                .file
                .read_at(&mut buffer, offset)
                .map_err(|error| snapshot_error(&artifact.display_path, error))?;
            if count == 0 {
                return Err(LocalRunnerError::invalid(format!(
                    "immutable process snapshot for {} ended unexpectedly",
                    artifact.display_path.display()
                )));
            }
            writable
                .write_all(&buffer[..count])
                .map_err(|error| snapshot_error(&artifact.display_path, error))?;
            offset += count as u64;
        }
        writable
            .sync_all()
            .map_err(|error| snapshot_error(&artifact.display_path, error))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o500))
            .map_err(|error| snapshot_error(&artifact.display_path, error))?;
        let file =
            File::open(&path).map_err(|error| snapshot_error(&artifact.display_path, error))?;
        let written = writable
            .metadata()
            .map_err(|error| snapshot_error(&artifact.display_path, error))?;
        let opened = file
            .metadata()
            .map_err(|error| snapshot_error(&artifact.display_path, error))?;
        if written.dev() != opened.dev() || written.ino() != opened.ino() {
            return Err(LocalRunnerError::invalid(format!(
                "private executable snapshot {} changed while it was reopened",
                artifact.display_path.display()
            )));
        }
        drop(writable);
        Ok(TemporaryExecutable {
            path: path.clone(),
            cleanup_directory,
            _file: file,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

#[cfg(target_os = "macos")]
fn materialize_executable(
    artifact: &VerifiedProcessArtifact,
) -> Result<TemporaryExecutable, LocalRunnerError> {
    let directory = verified_executable_parent(artifact)?;
    let path = directory.join(format!(
        ".paperclip-verified-executable-{}",
        Uuid::new_v4().simple()
    ));
    materialize_executable_at(artifact, path, None)
}

#[cfg(target_os = "macos")]
fn materialize_bound_executable(
    artifact: &VerifiedProcessArtifact,
) -> Result<TemporaryExecutable, LocalRunnerError> {
    let parent = verified_executable_parent(artifact)?;
    let directory = parent.join(format!(
        ".paperclip-verified-executable-{}",
        Uuid::new_v4().simple()
    ));
    fs::create_dir(&directory).map_err(|error| snapshot_error(&artifact.display_path, error))?;
    if let Err(error) = fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)) {
        let _ = fs::remove_dir(&directory);
        return Err(snapshot_error(&artifact.display_path, error));
    }
    let result =
        materialize_executable_at(artifact, directory.join("launch"), Some(directory.clone()));
    if result.is_err() {
        let _ = fs::remove_dir(directory);
    }
    result
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn inherited_artifact(
    artifact: &VerifiedProcessArtifact,
) -> Result<(rustix::fd::OwnedFd, PathBuf), LocalRunnerError> {
    let fd = rustix::io::dup(&*artifact.file).map_err(|error| {
        LocalRunnerError::invalid(format!(
            "failed to inherit verified process artifact {}: {error}",
            artifact.display_path.display()
        ))
    })?;
    let mut flags = rustix::io::fcntl_getfd(&fd).map_err(|error| {
        LocalRunnerError::invalid(format!(
            "failed to inspect inherited process artifact {}: {error}",
            artifact.display_path.display()
        ))
    })?;
    flags.remove(rustix::io::FdFlags::CLOEXEC);
    rustix::io::fcntl_setfd(&fd, flags).map_err(|error| {
        LocalRunnerError::invalid(format!(
            "failed to inherit process artifact {} across exec: {error}",
            artifact.display_path.display()
        ))
    })?;
    #[cfg(target_os = "linux")]
    let path = PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd()));
    #[cfg(target_os = "macos")]
    let path = PathBuf::from(format!("/dev/fd/{}", fd.as_raw_fd()));
    Ok((fd, path))
}

pub(crate) enum ProcessOutput {
    Stdout(String),
    Stderr(String),
    StdoutError(String),
    StdoutClosed,
    StderrClosed,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BoundedLine {
    Line(String),
    TooLong,
    Eof,
}

pub(crate) fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    max_bytes: usize,
) -> io::Result<BoundedLine> {
    let max_bytes = max_bytes.max(1);
    let mut bytes = Vec::with_capacity(max_bytes.min(8 * 1024));
    let mut too_long = false;

    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            if too_long {
                return Ok(BoundedLine::TooLong);
            }
            if bytes.is_empty() {
                return Ok(BoundedLine::Eof);
            }
            return String::from_utf8(bytes)
                .map(BoundedLine::Line)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
        }

        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let content_len = newline.unwrap_or(buffer.len());
        if !too_long {
            let remaining = max_bytes.saturating_sub(bytes.len());
            let copy_len = remaining.min(content_len);
            bytes.extend_from_slice(&buffer[..copy_len]);
            if content_len > remaining {
                too_long = true;
                bytes.clear();
            }
        }
        let consumed = newline.map_or(buffer.len(), |index| index + 1);
        reader.consume(consumed);

        if newline.is_some() {
            if too_long {
                return Ok(BoundedLine::TooLong);
            }
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            return String::from_utf8(bytes)
                .map(BoundedLine::Line)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
        }
    }
}

fn forward_bounded_output<R: io::Read + Send + 'static>(
    reader: R,
    sender: SyncSender<ProcessOutput>,
    stdout: bool,
    max_line_bytes: usize,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        loop {
            let output = match read_bounded_line(&mut reader, max_line_bytes) {
                Ok(BoundedLine::Line(line)) if stdout => ProcessOutput::Stdout(line),
                Ok(BoundedLine::Line(line)) => ProcessOutput::Stderr(line),
                Ok(BoundedLine::TooLong) if stdout => ProcessOutput::StdoutError(format!(
                    "harness stdout frame exceeded {max_line_bytes} bytes"
                )),
                Ok(BoundedLine::TooLong) => ProcessOutput::Stderr(format!(
                    "[harness stderr frame exceeded {max_line_bytes} bytes]"
                )),
                Ok(BoundedLine::Eof) => break,
                Err(error) if stdout => {
                    ProcessOutput::StdoutError(format!("failed to read harness stdout: {error}"))
                }
                Err(error) => {
                    ProcessOutput::Stderr(format!("[failed to read harness stderr: {error}]"))
                }
            };
            let terminal_output = matches!(&output, ProcessOutput::StdoutError(_));
            if sender.send(output).is_err() || terminal_output {
                return;
            }
        }
        let closed = if stdout {
            ProcessOutput::StdoutClosed
        } else {
            ProcessOutput::StderrClosed
        };
        let _ = sender.send(closed);
    });
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessExitFact {
    pub exit_code: Option<i32>,
    pub success: bool,
    pub signal: Option<i32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundedLogSnapshot {
    pub lines: Vec<String>,
    pub retained_bytes: usize,
    pub dropped_lines: usize,
}

#[derive(Debug)]
pub struct BoundedLogBuffer {
    max_lines: usize,
    max_bytes: usize,
    retained_bytes: usize,
    dropped_lines: usize,
    lines: VecDeque<String>,
}

impl BoundedLogBuffer {
    pub fn new(max_lines: usize, max_bytes: usize) -> Self {
        Self {
            max_lines: max_lines.max(1),
            max_bytes: max_bytes.max(1),
            retained_bytes: 0,
            dropped_lines: 0,
            lines: VecDeque::new(),
        }
    }

    pub fn push(&mut self, line: impl Into<String>) {
        let mut line = line.into();
        if line.len() > self.max_bytes {
            let mut end = self.max_bytes;
            while !line.is_char_boundary(end) {
                end -= 1;
            }
            line.truncate(end);
        }
        self.retained_bytes += line.len();
        self.lines.push_back(line);
        while self.lines.len() > self.max_lines || self.retained_bytes > self.max_bytes {
            if let Some(removed) = self.lines.pop_front() {
                self.retained_bytes = self.retained_bytes.saturating_sub(removed.len());
                self.dropped_lines += 1;
            } else {
                break;
            }
        }
    }

    pub fn snapshot(&self) -> BoundedLogSnapshot {
        BoundedLogSnapshot {
            lines: self.lines.iter().cloned().collect(),
            retained_bytes: self.retained_bytes,
            dropped_lines: self.dropped_lines,
        }
    }
}

pub struct SupervisedProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    output: Receiver<ProcessOutput>,
    process_group_id: u32,
    shutdown_grace: Duration,
    finished: bool,
    #[cfg(target_os = "macos")]
    _temporary_executables: Vec<TemporaryExecutable>,
}

impl SupervisedProcess {
    pub fn spawn(
        program: &Path,
        args: &[String],
        shutdown_grace: Duration,
        max_line_bytes: usize,
    ) -> Result<Self, LocalRunnerError> {
        Self::spawn_with_environment_keys(program, args, shutdown_grace, max_line_bytes, &[])
    }

    pub fn spawn_with_environment_keys(
        program: &Path,
        args: &[String],
        shutdown_grace: Duration,
        max_line_bytes: usize,
        additional_environment_keys: &[&str],
    ) -> Result<Self, LocalRunnerError> {
        Self::spawn_command(
            program,
            args,
            shutdown_grace,
            max_line_bytes,
            additional_environment_keys,
            None,
        )
    }

    pub fn spawn_verified_with_environment_keys(
        launch: &VerifiedProcessLaunch,
        shutdown_grace: Duration,
        max_line_bytes: usize,
        additional_environment_keys: &[&str],
    ) -> Result<Self, LocalRunnerError> {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let mut inherited = launch.inherited_command()?;
            let mut result = Self::spawn_command(
                &inherited.program,
                &inherited.args,
                shutdown_grace,
                max_line_bytes,
                additional_environment_keys,
                launch
                    .inherit_runtime_executable
                    .then_some(inherited.program.as_path()),
            );
            #[cfg(target_os = "macos")]
            if let Ok(process) = result.as_mut() {
                process._temporary_executables =
                    std::mem::take(&mut inherited.temporary_executables);
            }
            drop(inherited);
            result
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = (
                launch,
                shutdown_grace,
                max_line_bytes,
                additional_environment_keys,
            );
            Err(LocalRunnerError::invalid(
                "verified process launch is supported only on Linux and macOS",
            ))
        }
    }

    fn spawn_command(
        program: &Path,
        args: &[String],
        shutdown_grace: Duration,
        max_line_bytes: usize,
        additional_environment_keys: &[&str],
        verified_runtime_executable: Option<&Path>,
    ) -> Result<Self, LocalRunnerError> {
        let mut command = Command::new(program);
        command
            .args(args)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for key in [
            "PATH",
            "PATHEXT",
            "SystemRoot",
            "WINDIR",
            "HOME",
            "USERPROFILE",
            "LANG",
            "LC_ALL",
            "TMPDIR",
            "TEMP",
            "TMP",
            "TZ",
        ]
        .into_iter()
        .chain(additional_environment_keys.iter().copied())
        {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        if let Some(executable) = verified_runtime_executable {
            // Node reports a sealed memfd launch as `/memfd:... (deleted)` via
            // process.execPath. Give descriptor-loaded runtimes the inherited,
            // authenticated executable path so their governed child launches
            // can reopen the same immutable image instead of that dead alias.
            command.env(VERIFIED_RUNTIME_EXECUTABLE_ENV, executable);
        }
        #[cfg(unix)]
        command.process_group(0);

        let mut child = command.spawn().map_err(|error| {
            LocalRunnerError::invalid(format!(
                "failed to start supervised process {}: {error}",
                program.display()
            ))
        })?;
        let process_group_id = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| LocalRunnerError::invalid("supervised process stdin was not piped"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| LocalRunnerError::invalid("supervised process stdout was not piped"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| LocalRunnerError::invalid("supervised process stderr was not piped"))?;
        let (sender, output) = mpsc::sync_channel(PROCESS_OUTPUT_QUEUE_CAPACITY);
        forward_bounded_output(stdout, sender.clone(), true, max_line_bytes.max(1));
        forward_bounded_output(stderr, sender, false, max_line_bytes.max(1));

        Ok(Self {
            child,
            stdin: Some(stdin),
            output,
            process_group_id,
            shutdown_grace,
            finished: false,
            #[cfg(target_os = "macos")]
            _temporary_executables: Vec::new(),
        })
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn send<T: Serialize>(&mut self, value: &T) -> Result<(), LocalRunnerError> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| LocalRunnerError::invalid("supervised process stdin is closed"))?;
        serde_json::to_writer(&mut *stdin, value).map_err(|error| {
            LocalRunnerError::invalid(format!("command serialization failed: {error}"))
        })?;
        stdin
            .write_all(b"\n")
            .and_then(|_| stdin.flush())
            .map_err(|error| {
                LocalRunnerError::invalid(format!("failed to write process command: {error}"))
            })
    }

    pub(crate) fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<ProcessOutput, RecvTimeoutError> {
        self.output.recv_timeout(timeout)
    }

    pub fn receive_stdout_line(
        &self,
        timeout: Duration,
    ) -> Result<Option<String>, LocalRunnerError> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            match self.recv_timeout(remaining) {
                Ok(ProcessOutput::Stdout(line)) => return Ok(Some(line)),
                Ok(ProcessOutput::Stderr(_)) | Ok(ProcessOutput::StderrClosed) => {}
                Ok(ProcessOutput::StdoutError(message)) => {
                    return Err(LocalRunnerError::invalid(message));
                }
                Ok(ProcessOutput::StdoutClosed) => return Ok(None),
                Err(RecvTimeoutError::Timeout) => return Ok(None),
                // The reader threads end when the child closes its output.
                // Let the caller reconcile that closure with the authoritative
                // process exit status instead of turning the channel teardown
                // into a transport failure.
                Err(RecvTimeoutError::Disconnected) => return Ok(None),
            }
        }
    }

    pub(crate) fn try_recv(&self) -> Result<ProcessOutput, mpsc::TryRecvError> {
        self.output.try_recv()
    }

    pub fn try_wait(&mut self) -> Result<Option<ProcessExitFact>, LocalRunnerError> {
        self.child
            .try_wait()
            .map(|status| status.map(exit_fact))
            .map_err(|error| {
                LocalRunnerError::invalid(format!("failed to inspect process: {error}"))
            })
    }

    pub fn wait(&mut self) -> Result<ProcessExitFact, LocalRunnerError> {
        let status = self.child.wait().map_err(|error| {
            LocalRunnerError::invalid(format!("failed to wait for process: {error}"))
        })?;
        // The group leader can exit while descendants remain alive. Reap the
        // leader first, then clear any remaining members of its private group.
        // A caller that must exclude escaped or re-parented descendants still
        // needs a separately inherited lifetime fence.
        #[cfg(unix)]
        signal_process_group(self.process_group_id, "KILL");
        self.finished = true;
        Ok(exit_fact(status))
    }

    pub fn terminate_group(&mut self) -> Result<ProcessExitFact, LocalRunnerError> {
        self.stdin.take();
        #[cfg(unix)]
        signal_process_group(self.process_group_id, "TERM");
        #[cfg(not(unix))]
        let _ = self.child.kill();

        let deadline = Instant::now() + self.shutdown_grace;
        loop {
            if let Some(fact) = self.try_wait()? {
                #[cfg(unix)]
                signal_process_group(self.process_group_id, "KILL");
                self.finished = true;
                return Ok(fact);
            }
            if Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }

        #[cfg(unix)]
        signal_process_group(self.process_group_id, "KILL");
        #[cfg(not(unix))]
        let _ = self.child.kill();
        self.wait()
    }
}

impl Drop for SupervisedProcess {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.terminate_group();
        }
    }
}

#[cfg(unix)]
fn signal_process_group(process_group_id: u32, signal: &str) {
    let _ = Command::new("kill")
        .args([
            format!("-{signal}"),
            "--".to_owned(),
            format!("-{process_group_id}"),
        ])
        .env_clear()
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn exit_fact(status: ExitStatus) -> ProcessExitFact {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        ProcessExitFact {
            exit_code: status.code(),
            success: status.success(),
            signal: status.signal(),
        }
    }
    #[cfg(not(unix))]
    {
        ProcessExitFact {
            exit_code: status.code(),
            success: status.success(),
            signal: None,
        }
    }
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn verified_artifact(path: &Path, bytes: &[u8]) -> VerifiedProcessArtifact {
        fs::write(path, bytes).unwrap();
        let digest = format!("sha256:{:x}", Sha256::digest(bytes));
        VerifiedProcessArtifact::snapshot_verified(
            path.to_owned(),
            File::open(path).unwrap(),
            &digest,
        )
        .unwrap()
    }

    #[test]
    fn commonjs_artifacts_use_the_bounded_descriptor_loader() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "paperclip-commonjs-launch-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let program = verified_artifact(&directory.join("node"), b"node");
        let script = verified_artifact(&directory.join("sidecar.cjs"), b"module.exports = {};\n");
        let launch = VerifiedProcessLaunch::new(
            program,
            vec![VerifiedProcessArgument::CommonJsArtifact(script)],
        );

        let inherited = launch.inherited_command().unwrap();

        assert_eq!(inherited.args[0], "--eval");
        assert_eq!(inherited.args[1], VERIFIED_COMMONJS_ARTIFACT_LOADER);
        #[cfg(target_os = "linux")]
        assert!(inherited.args[2].starts_with("/proc/self/fd/"));
        #[cfg(target_os = "macos")]
        assert!(inherited.args[2].starts_with("/dev/fd/"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn executable_arguments_use_the_private_nested_launch_contract() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "paperclip-executable-argument-launch-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let program = verified_artifact(&directory.join("node"), b"node");
        let executable = verified_artifact(&directory.join("opencode"), b"opencode");
        let launch = VerifiedProcessLaunch::new(
            program,
            vec![VerifiedProcessArgument::ExecutableArtifact(executable)],
        );

        let inherited = launch.inherited_command().unwrap();
        let command = PathBuf::from(&inherited.args[0]);
        let private_directory = command.parent().unwrap().to_path_buf();
        assert_eq!(command.file_name().unwrap(), "launch");
        assert!(private_directory
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".paperclip-verified-executable-"));
        assert_eq!(
            fs::symlink_metadata(&private_directory)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::symlink_metadata(&command).unwrap().permissions().mode() & 0o777,
            0o500
        );

        drop(inherited);
        assert!(!private_directory.exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
