use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde::Serialize;

use crate::local_runner::LocalRunnerError;

const PROCESS_OUTPUT_QUEUE_CAPACITY: usize = 256;

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
}

impl SupervisedProcess {
    pub fn spawn(
        program: &Path,
        args: &[String],
        shutdown_grace: Duration,
        max_line_bytes: usize,
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
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
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
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(LocalRunnerError::invalid("process output channel closed"));
                }
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
