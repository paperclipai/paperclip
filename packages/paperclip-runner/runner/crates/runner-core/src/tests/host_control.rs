use super::*;
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixDatagram;

#[test]
fn validates_connected_stream_and_sets_close_on_exec() {
    let (socket, _host) = UnixStream::pair().unwrap();
    let control = HostControl::new(socket).unwrap();
    assert!(rustix::io::fcntl_getfd(&control.socket)
        .unwrap()
        .contains(rustix::io::FdFlags::CLOEXEC));
    let (socket, _host) = UnixDatagram::pair().unwrap();
    let owned: OwnedFd = socket.into();
    assert!(HostControl::new(UnixStream::from(owned)).is_err());
}

#[test]
fn bounds_frames_rejects_unknown_fields_and_observes_eof_without_logging_secrets() {
    for payload in ["x".repeat(MAX_FRAME_BYTES),
        "{\"op\":\"claim\",\"id\":\"claim\",\"parkId\":\"park\",\"bootstrapTicket\":\"private-ticket\",\"extra\":true}\n".to_owned()] {
        let (socket, mut host) = UnixStream::pair().unwrap();
        let mut control = HostControl::new(socket).unwrap();
        let writer = std::thread::spawn(move || host.write_all(payload.as_bytes()).unwrap());
        let error = match control.receive(true, Some(Duration::from_secs(1))) { Err(error) => error, _ => panic!("malformed input accepted") };
        assert_eq!(error.to_string(), "host control channel failed closed");
        writer.join().unwrap();
    }
    let (socket, host) = UnixStream::pair().unwrap();
    let mut control = HostControl::new(socket).unwrap();
    drop(host);
    assert!(control.receive(true, None).is_err());
}

fn claim(id: &str, ticket: &str) -> HostRequest {
    HostRequest::Claim {
        id: id.into(),
        park_id: "park-1".into(),
        bootstrap_ticket: ticket.into(),
    }
}

fn read_reply(host: &mut UnixStream) -> serde_json::Value {
    use std::io::BufRead;
    host.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    let mut line = String::new();
    std::io::BufReader::new(host).read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

#[test]
fn identical_retry_replays_response_and_changed_payload_conflicts() {
    let (socket, mut host) = UnixStream::pair().unwrap();
    let mut control = HostControl::new(socket).unwrap();
    let request = claim("claim-1", "private-ticket");
    assert!(!control.replay(&request).unwrap());
    control.reply(&request, "claimed").unwrap();
    let first = read_reply(&mut host);
    assert_eq!(
        first,
        serde_json::json!({"id":"claim-1", "status":"claimed"})
    );
    assert!(control.replay(&request).unwrap());
    assert_eq!(read_reply(&mut host), first);
    assert!(control.replay(&claim("claim-1", "changed-ticket")).unwrap());
    assert_eq!(
        read_reply(&mut host),
        serde_json::json!({"id":"claim-1", "status":"conflict"})
    );
    // A conflicting retry neither replaces the original receipt nor exposes a ticket.
    assert!(control.replay(&request).unwrap());
    assert_eq!(read_reply(&mut host), first);
}

#[test]
fn conflict_does_not_reserve_a_request_id() {
    let (socket, mut host) = UnixStream::pair().unwrap();
    let mut control = HostControl::new(socket).unwrap();
    let request = claim("claim-1", "private-ticket");
    control.reply(&request, "conflict").unwrap();
    assert_eq!(read_reply(&mut host)["status"], "conflict");
    assert!(!control.replay(&request).unwrap());
}

#[test]
fn successful_park_starts_a_new_receipt_window() {
    let (socket, mut host) = UnixStream::pair().unwrap();
    let mut control = HostControl::new(socket).unwrap();
    let old = claim("claim-1", "private-ticket");
    control.reply(&old, "claimed").unwrap();
    read_reply(&mut host);
    let park: HostRequest = serde_json::from_value(serde_json::json!({
        "op":"park", "id":"park-2", "identity": {
            "runnerInstanceId":"runner", "environmentLeaseId":"lease", "runId":"run",
            "normalizedSessionId":"session", "turnId":"turn", "itemId":"item"
        }, "lastControllerCommandSeq":12, "ackedSourceSeq":34
    }))
    .unwrap();
    control.reply(&park, "conflict").unwrap();
    read_reply(&mut host);
    assert!(control.replay(&old).unwrap());
    read_reply(&mut host);
    control.reply(&park, "parked").unwrap();
    let parked = read_reply(&mut host);
    assert!(!control.replay(&old).unwrap());
    assert!(control.replay(&park).unwrap());
    assert_eq!(read_reply(&mut host), parked);
    assert_eq!(control.receipts.len(), 1);
}

#[test]
fn partial_frame_cannot_extend_the_absolute_lifetime() {
    let (socket, mut host) = UnixStream::pair().unwrap();
    let mut control = HostControl::new(socket).unwrap();
    let (stop, stopped) = std::sync::mpsc::channel();
    host.write_all(b"{").unwrap();
    let writer = std::thread::spawn(move || {
        let mut chunks = 0;
        // Keep a partial request arriving well beyond the receive deadline.
        // A timeout restarted on every read would wait for this writer to end.
        let limit = Instant::now() + Duration::from_secs(2);
        while Instant::now() < limit {
            if stopped.recv_timeout(Duration::from_millis(10)).is_ok() {
                return chunks;
            }
            host.write_all(b" ").unwrap();
            chunks += 1;
        }
        chunks
    });
    let result = control.receive(true, Some(Duration::from_millis(150)));
    let writer_was_still_sending = !writer.is_finished();
    let _ = stop.send(());
    let chunks = writer.join().unwrap();
    assert!(result.unwrap().is_none());
    assert!(
        writer_was_still_sending,
        "receive outlasted the chunk stream"
    );
    assert!(chunks >= 2, "test must send repeated chunks during receive");
    assert!(
        control.input.len() >= 3,
        "receive must consume repeated chunks"
    );
}
