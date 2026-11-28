#[test]
fn loopback_listener_enables_tcp_nodelay() {
    let listener = TcpListener::bind("0.0.0.0:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let path = "/api/runner/v1/connect/run_1".to_owned();
    let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
    let client = thread::spawn({
        let url = format!("ws://127.0.0.1:{port}{path}");
        move || client(url, stream).unwrap()
    });
    let endpoint = RunnerTransportEndpoint::Listen { listener, path };
    let Some(RunnerSocket::Listen(socket)) = endpoint
        .open(64 * 1024, None, Instant::now() + Duration::from_secs(5))
        .unwrap()
    else {
        panic!("expected an accepted PRP socket");
    };
    client.join().unwrap();
    assert!(socket.get_ref().nodelay().unwrap());
}

#[test]
fn loopback_dial_enables_tcp_nodelay() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let config = config(listener.local_addr().unwrap().port());
    let endpoint = RunnerTransportEndpoint::new(&config.connect_url, &config.run_id).unwrap();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        accept(stream).unwrap()
    });
    let Some(RunnerSocket::Dial(socket)) = endpoint
        .open(
            config.max_frame_bytes,
            None,
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap()
    else {
        panic!("expected an outbound PRP socket");
    };
    server.join().unwrap();
    let MaybeTlsStream::Plain(stream) = socket.get_ref() else {
        panic!("expected a plaintext loopback socket");
    };
    assert!(stream.nodelay().unwrap());
}
