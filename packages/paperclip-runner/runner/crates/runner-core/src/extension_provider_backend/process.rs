use std::sync::mpsc::{RecvTimeoutError, TryRecvError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::durable::{DurableRunnerError, EventPriority};
use crate::process_supervisor::{ProcessOutput, SupervisedProcess};

use super::{
    bounded_text, expire_requests, invalid, parse_frame, push_event, ExtensionCommandExecutor,
    MAX_FRAME_BYTES, MAX_PENDING_EVENTS, MAX_SAFE_INTEGER, REQUEST_TIMEOUT, WIRE_SCHEMA,
};

impl ExtensionCommandExecutor {
    pub(super) fn ensure_process(&mut self) -> Result<(), DurableRunnerError> {
        if self.poisoned {
            return Err(invalid(
                "extension runtime is unavailable after a protocol failure",
            ));
        }
        if self.process.is_some() {
            return Ok(());
        }
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| invalid("extension must be prepared before launch"))?;
        if state.closed {
            return Err(invalid("extension session has been closed"));
        }
        if let Some(group) = state.process_group {
            require_group_absent(group)?;
        }
        if state.generation > 0 && state.snapshot.is_none() {
            return Err(invalid(
                "extension recovery requires a durable provider checkpoint",
            ));
        }
        let profile = self.profile()?.clone();
        let launch = profile.verified_launch()?;
        self.update(|state| {
            expire_requests(state, "provider_process_lost")?;
            state.generation = state
                .generation
                .checked_add(1)
                .filter(|v| *v <= MAX_SAFE_INTEGER)
                .ok_or_else(|| invalid("extension process generation exhausted"))?;
            state.sequence = 0;
            Ok(())
        })?;
        let keys = profile
            .environment_keys
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let process = SupervisedProcess::spawn_verified_with_environment_keys(
            &launch,
            Duration::from_secs(2),
            MAX_FRAME_BYTES,
            &keys,
        )
        .map_err(|_| invalid("extension verified process launch failed"))?;
        let group = process.process_group_id();
        self.process = Some(process);
        self.update(|state| {
            state.process_group = Some(group);
            Ok(())
        })?;
        let state = self.state.as_ref().unwrap();
        let initialized = self.request("initialize", json!({ "identity": profile.identity, "runId": state.run_id, "normalizedSessionId": state.session_id,
            "correlation":{"runId":state.run_id,"normalizedSessionId":state.session_id,"turnId":state.turn_id,"itemId":state.item_id},
            "provider": state.provider, "snapshot": state.snapshot }))?;
        if initialized.get("identity")
            != Some(
                &serde_json::to_value(&profile.identity)
                    .map_err(|_| invalid("extension identity serialization failed"))?,
            )
        {
            self.poison();
            return Err(invalid(
                "extension initialization returned a different release identity",
            ));
        }
        if initialized.get("capabilities")
            != self.state.as_ref().unwrap().provider.get("capabilities")
        {
            self.poison();
            return Err(invalid(
                "extension initialization capabilities differ from the admitted declaration",
            ));
        }
        Ok(())
    }
    pub(super) fn poison(&mut self) {
        self.poisoned = true;
        if self.state.as_ref().is_some_and(|state| state.active_turn) {
            let _ = self.update(|state| {
                state.snapshot = None;
                Ok(())
            });
        }
        let _ = self.stop_process();
    }
    pub(super) fn request(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Value, DurableRunnerError> {
        let result = self.request_inner(method, params);
        if result.is_err() {
            self.poison();
        }
        result
    }
    fn request_inner(&mut self, method: &str, params: Value) -> Result<Value, DurableRunnerError> {
        let id = self.next_request;
        self.next_request = id
            .checked_add(1)
            .filter(|v| *v <= MAX_SAFE_INTEGER)
            .ok_or_else(|| invalid("extension request sequence exhausted"))?;
        let request =
            json!({ "schema": WIRE_SCHEMA, "id": id, "method": method, "params": params });
        if serde_json::to_vec(&request)
            .map_err(|_| invalid("extension request serialization failed"))?
            .len()
            > MAX_FRAME_BYTES
        {
            return Err(invalid("extension request exceeds frame bound"));
        }
        self.process
            .as_mut()
            .ok_or_else(|| invalid("extension process is absent"))?
            .send(&request)
            .map_err(|_| invalid("extension command write failed"))?;
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(invalid("extension command timed out"));
            }
            let output = self.process.as_ref().unwrap().recv_timeout(remaining);
            match output {
                Ok(ProcessOutput::Stdout(line)) => {
                    let value = parse_frame(&line)?;
                    if value.get("sequence").is_some() {
                        if method == "initialize" {
                            return Err(invalid(
                                "extension emitted provider facts before identity admission",
                            ));
                        }
                        self.receive_event(value)?;
                        continue;
                    }
                    let fields = value
                        .as_object()
                        .ok_or_else(|| invalid("extension response must be an object"))?;
                    if fields.keys().any(|key| {
                        !["schema", "id", "ok", "result", "error"].contains(&key.as_str())
                    }) || value["id"].as_u64() != Some(id)
                    {
                        return Err(invalid(
                            "extension response has unknown fields or wrong correlation",
                        ));
                    }
                    match value["ok"].as_bool() {
                        Some(true)
                            if value["result"].is_object() && value.get("error").is_none() =>
                        {
                            return Ok(value["result"].clone())
                        }
                        Some(false)
                            if value["error"].is_object() && value.get("result").is_none() =>
                        {
                            let error = &value["error"];
                            let code = error["code"]
                                .as_str()
                                .filter(|value| bounded_text(value, 160))
                                .ok_or_else(|| invalid("extension error code is malformed"))?;
                            let message = error["message"]
                                .as_str()
                                .filter(|value| value.len() <= 8192)
                                .ok_or_else(|| invalid("extension error message is malformed"))?;
                            if !error["retryable"].is_boolean()
                                || error.as_object().unwrap().keys().any(|key| {
                                    !["code", "message", "retryable"].contains(&key.as_str())
                                })
                            {
                                return Err(invalid("extension error fields are malformed"));
                            }
                            return Err(invalid(format!(
                                "extension {code}: {}",
                                crate::durable::redact_diagnostic_text(message)
                            )));
                        }
                        _ => return Err(invalid("extension response is malformed")),
                    }
                }
                Ok(ProcessOutput::Stderr(_)) => {}
                Ok(ProcessOutput::StderrClosed) => {}
                Ok(ProcessOutput::StdoutClosed) | Err(RecvTimeoutError::Disconnected) => {
                    return Err(invalid("extension process closed its protocol stream"))
                }
                Ok(ProcessOutput::StdoutError(_)) => {
                    return Err(invalid(
                        "extension protocol frame is oversized or unreadable",
                    ))
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err(invalid("extension command timed out"))
                }
            }
        }
    }
    pub(super) fn poll_process(&mut self) -> Result<(), DurableRunnerError> {
        if self.process.is_none()
            || self
                .state
                .as_ref()
                .is_some_and(|state| !state.events.is_empty())
        {
            return Ok(());
        }
        let result = (|| {
            for _ in 0..MAX_PENDING_EVENTS / 2 {
                match self.process.as_ref().unwrap().try_recv() {
                    Ok(ProcessOutput::Stdout(line)) => {
                        let value = parse_frame(&line)?;
                        if value.get("sequence").is_none() {
                            return Err(invalid("extension emitted an unsolicited response"));
                        }
                        self.receive_event(value)?;
                    }
                    Ok(ProcessOutput::Stderr(_)) => {}
                    Ok(ProcessOutput::StderrClosed) => {}
                    Ok(ProcessOutput::StdoutError(_)) => {
                        return Err(invalid("extension protocol stream failed"))
                    }
                    Ok(ProcessOutput::StdoutClosed) | Err(TryRecvError::Disconnected) => {
                        return Err(invalid("extension process was lost"))
                    }
                    Err(TryRecvError::Empty) => break,
                }
            }
            Ok(())
        })();
        if result.is_err() {
            self.poison();
            self.update(|state| {
                if state.active_turn {
                    state.active_turn = false;
                    expire_requests(state, "provider_process_lost")?;
                    push_event(state, "turn.failed".to_owned(), EventPriority::P0, json!({"code":"extension_process_lost","message":"The installed harness process was lost","providerTerminalObserved":false}))?;
                    push_event(state, "run.terminal".to_owned(), EventPriority::P0, json!({"schema":"paperclip.prp.terminal.v1","turnTerminalState":"failed","runTerminalState":"failed","reportedWorkDisposition":"needs_review"}))?;
                }
                Ok(())
            })?;
        }
        // Physical loss is represented by durable terminal facts. A protocol
        // failure with no active work remains a command error on subsequent use.
        Ok(())
    }
    pub(super) fn stop_process(&mut self) -> Result<(), DurableRunnerError> {
        let group = self
            .process
            .as_ref()
            .map(SupervisedProcess::process_group_id)
            .or_else(|| self.state.as_ref().and_then(|state| state.process_group));
        if let Some(mut process) = self.process.take() {
            process
                .terminate_group()
                .map_err(|_| invalid("extension process-group cleanup is unconfirmed"))?;
        }
        if let Some(group) = group {
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match require_group_absent(group) {
                    Ok(()) => break,
                    Err(error) if Instant::now() >= deadline => return Err(error),
                    Err(_) => std::thread::sleep(Duration::from_millis(5)),
                }
            }
        }
        if self.state.is_some() {
            self.update(|state| {
                state.process_group = None;
                Ok(())
            })?;
        }
        Ok(())
    }
}

pub(super) fn require_group_absent(group: u32) -> Result<(), DurableRunnerError> {
    #[cfg(unix)]
    {
        let pid = rustix::process::Pid::from_raw(
            i32::try_from(group)
                .map_err(|_| invalid("extension checkpoint process group is invalid"))?,
        )
        .ok_or_else(|| invalid("extension checkpoint process group is invalid"))?;
        match rustix::process::test_kill_process_group(pid) {
            Err(error) if error == rustix::io::Errno::SRCH => Ok(()),
            _ => Err(invalid(
                "extension prior process group has not been proven stopped",
            )),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = group;
        Err(invalid(
            "extension recovery process ownership is unsupported on this platform",
        ))
    }
}
