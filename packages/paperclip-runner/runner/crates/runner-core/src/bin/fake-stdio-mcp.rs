use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::{self, BufRead, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

fn main() {
    let output = Arc::new(Mutex::new(io::stdout()));
    let mut workers = vec![];
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else {
            break;
        };
        let message: Value = serde_json::from_str(&line).unwrap();
        let Some(id) = message.get("id").cloned() else {
            continue;
        };
        let output = output.clone();
        workers.push(thread::spawn(move || {
            let mut result = match message["method"].as_str().unwrap_or("") {
                "initialize" => json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}),
                "tools/list" => json!({"tools":[{"name":"opaque","inputSchema":{"type":"object","properties":{"original":{"type":"string"}}}}]}),
                "ping" => {
                    if message.pointer("/params/padding") == Some(&json!(true)) {
                        std::fs::write(std::env::var("FIXTURE_PING_READY").unwrap(), "ready").unwrap();
                        json!({"padding":"x".repeat(1024*1024)})
                    } else { json!({"secretLeaked":std::env::var_os("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET").is_some()}) }
                },
                "tools/call" => {
                    let log = std::env::var("FIXTURE_LOG").unwrap();
                    let mut file = OpenOptions::new().create(true).append(true).open(log).unwrap();
                    writeln!(file, "begin {id}").unwrap();
                    if message.pointer("/params/arguments/block") == Some(&json!(true)) {
                        let gate = std::env::var("FIXTURE_GATE").unwrap();
                        while !std::path::Path::new(&gate).exists() { thread::sleep(Duration::from_millis(10)); }
                    }
                    writeln!(file, "end {id}").unwrap();
                    json!({"content":[{"type":"text","text":"unchanged"},{"type":"image","mimeType":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="}],"structuredContent":{"original":message["params"]["arguments"]}})
                }
                _ => json!({}),
            };
            if std::env::var_os("FIXTURE_NO_STRUCTURED").is_some() { result.as_object_mut().unwrap().remove("structuredContent"); }
            let mut output = output.lock().unwrap();
            writeln!(output, "{}", json!({"jsonrpc":"2.0","id":id,"result":result})).unwrap();
            output.flush().unwrap();
        }));
    }
    for worker in workers {
        let _ = worker.join();
    }
}
