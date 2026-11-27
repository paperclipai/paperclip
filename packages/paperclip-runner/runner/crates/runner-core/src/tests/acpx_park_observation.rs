use super::*;

fn scripted_transport(reply_id: u64) -> AcpxSidecarTransport {
    let event = json!({"protocolVersion":GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
        "sequence":1,"eventType":"runtime.diagnostic","runId":null,"turnId":null,
        "payload":{"code":"park_tail","message":"Preserve this exact event."}});
    let late = json!({"protocolVersion":GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,"id":1,"ok":true,"result":{"late":true}});
    let ordinary = json!({"protocolVersion":GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,"id":reply_id,"ok":true,"result":{"ordinary":true}});
    AcpxSidecarTransport::start(&AcpxSidecarTransportConfig {
        command: "/bin/sh".into(),
        args: vec!["-c".to_owned(), format!("read first; sleep 0.1; printf '%s\\n' '{event}' '{late}'; read second; printf '%s\\n' '{ordinary}'; cat >/dev/null")],
        verified_launch: None,
        request_timeout: Duration::from_secs(1),
        shutdown_grace: Duration::from_millis(20),
    }).unwrap()
}

#[test]
fn late_park_observation_reply_preserves_ordinary_commands_and_event_polling() {
    // Shutdown can orphan the script's `cat` for a moment after its shell dies.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let _orphans = crate::process_lineage::host_orphans::may_orphan();
    for poll_first in [false, true] {
        let mut transport = scripted_transport(2);
        let start = Instant::now();
        assert!(transport
            .observe(
                GeneratedAcpxSidecarCommand::SessionSnapshot,
                start + Duration::from_millis(10)
            )
            .unwrap()
            .is_none());
        assert_eq!(transport.abandoned_observation, Some(1));
        assert!(transport
            .observe(
                GeneratedAcpxSidecarCommand::SessionGoalGet,
                Instant::now() + Duration::from_millis(10)
            )
            .unwrap()
            .is_none());
        assert_eq!(transport.next_request_id, 2);
        let event = if poll_first {
            let event = transport
                .poll_event(Duration::from_secs(1))
                .unwrap()
                .unwrap();
            assert!(transport
                .poll_event(Duration::from_millis(10))
                .unwrap()
                .is_none());
            event
        } else {
            assert_eq!(
                transport
                    .request(GeneratedAcpxSidecarCommand::SessionGoalGet, json!({}))
                    .unwrap(),
                json!({"ordinary":true})
            );
            transport.poll_event(Duration::ZERO).unwrap().unwrap()
        };
        assert_eq!(event.sequence, 1);
        assert_eq!(
            event.payload,
            json!({"code":"park_tail","message":"Preserve this exact event."})
        );
        assert_eq!(transport.abandoned_observation, None);
        if poll_first {
            assert_eq!(
                transport
                    .request(GeneratedAcpxSidecarCommand::SessionGoalGet, json!({}))
                    .unwrap(),
                json!({"ordinary":true})
            );
        }
        assert!(!transport.poisoned);
        transport.shutdown().unwrap();
    }
}

#[test]
fn late_park_observation_does_not_relax_ordinary_reply_identity() {
    // Shutdown can orphan the script's `cat` for a moment after its shell dies.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let _orphans = crate::process_lineage::host_orphans::may_orphan();
    for wrong_id in [1, 99] {
        let mut transport = scripted_transport(wrong_id);
        assert!(transport
            .observe(
                GeneratedAcpxSidecarCommand::SessionSnapshot,
                Instant::now() + Duration::from_millis(10)
            )
            .unwrap()
            .is_none());
        let error = transport
            .request(GeneratedAcpxSidecarCommand::SessionGoalGet, json!({}))
            .unwrap_err();
        assert!(error.to_string().contains("response id mismatch"));
        assert!(transport.poisoned);
    }
}
