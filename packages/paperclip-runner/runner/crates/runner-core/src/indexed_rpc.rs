//! Private stdio port for standalone controllers. Bounded requests reuse the
//! same partitioned store as runner/provider state, including its redo protocol.
use crate::{
    durable::DurableRunnerError,
    indexed_store::{ExactReceipt, IndexedStore},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

type Result<T> = std::result::Result<T, DurableRunnerError>;
fn invalid(message: &str) -> DurableRunnerError {
    DurableRunnerError::invalid(message)
}
fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| invalid("invalid storage RPC field"))
}
fn number(value: &Value, key: &str) -> Result<u64> {
    let text = field(value, key)?;
    let number = text
        .parse::<u64>()
        .map_err(|_| invalid("invalid storage RPC integer"))?;
    if text != number.to_string() {
        return Err(invalid("invalid storage RPC integer"));
    }
    Ok(number)
}
fn bytes(value: &Value, key: &str) -> Result<Vec<u8>> {
    STANDARD
        .decode(field(value, key)?)
        .map_err(|_| invalid("invalid storage RPC bytes"))
}
fn dispatch(store: &IndexedStore, value: &Value) -> Result<Value> {
    let input = &value["input"];
    Ok(match field(value,"operation")? {
        "ready"=>Value::Null,
        "load"=>store.read_state(field(input,"key")?)?.map(|state|json!({"generation":state.generation.to_string(),"bytes":STANDARD.encode(state.bytes)})).unwrap_or(Value::Null),
        "get"=>store.receipt(field(input,"namespace")?,field(input,"key")?)?.map(|body|json!(STANDARD.encode(body))).unwrap_or(Value::Null),
        "getWork"=>store.read_work(field(input,"collection")?,field(input,"key")?)?.map(work_value).unwrap_or(Value::Null),
        "workPage"=>json!(store.work_page(field(input,"collection")?,field(input,"after")?,number(input,"limit")? as usize)?.into_iter().map(work_value).collect::<Vec<_>>()),
        "page"=>{
            let records=store.receipt_page(field(input,"namespace")?,field(input,"after")?,number(input,"limit")? as usize,number(input,"byteBudget")? as usize)?;
            json!(records.into_iter().map(|r|json!({"key":r.key,"bytes":STANDARD.encode(r.bytes)})).collect::<Vec<_>>())
        },
        "commit"=>{
            let records=input["receipts"].as_array().ok_or_else(||invalid("invalid storage RPC receipts"))?;
            if records.len()>4096 { return Err(invalid("storage_pressure: receipt transaction bound")); }
            let receipts=records.iter().map(|r|Ok(ExactReceipt{namespace:field(r,"namespace")?.into(),key:field(r,"key")?.into(),bytes:bytes(r,"bytes")?})).collect::<Result<Vec<_>>>()?;
            let work=match input.get("work") {
                None=>vec![],
                Some(work)=>work.as_array().ok_or_else(||invalid("invalid outstanding-work list"))?.iter().map(|r|Ok(crate::indexed_work::WorkChange {
                    collection:field(r,"collection")?.into(),key:field(r,"key")?.into(),
                    expected_digest:if r["expectedDigest"].is_null() {None} else {Some(bytes(r,"expectedDigest")?)},
                    bytes:if r["bytes"].is_null() {None} else {Some(bytes(r,"bytes")?)},
                })).collect::<Result<Vec<_>>>()?,
            };
            json!(store.commit_with_work(field(input,"key")?,field(input,"expectedGeneration")?.parse::<crate::indexed_revision::Revision>()?,bytes(input,"bytes")?,receipts,work)?.to_string())
        },
        _=>return Err(invalid("invalid storage RPC operation")),
    })
}

fn work_value(record: crate::indexed_work::WorkRecord) -> Value {
    json!({"key":record.key,"bytes":STANDARD.encode(record.bytes),"digest":STANDARD.encode(record.digest)})
}

pub fn serve(store: IndexedStore, input: impl BufRead, mut output: impl Write) -> Result<()> {
    let mut input = input;
    loop {
        let mut line = Vec::new();
        loop {
            let available = input
                .fill_buf()
                .map_err(crate::indexed_store::storage_error)?;
            if available.is_empty() {
                if line.is_empty() {
                    return Ok(());
                }
                return Err(invalid("incomplete storage RPC frame"));
            }
            let count = available
                .iter()
                .position(|b| *b == b'\n')
                .map(|n| n + 1)
                .unwrap_or(available.len());
            if line.len() + count > 96 * 1024 * 1024 {
                return Err(invalid("storage_pressure: storage RPC frame bound"));
            }
            let complete = available[count - 1] == b'\n';
            line.extend_from_slice(&available[..count]);
            input.consume(count);
            if complete {
                break;
            }
        }
        let request: Value =
            serde_json::from_slice(&line).map_err(crate::indexed_store::storage_error)?;
        let id = request["id"]
            .as_u64()
            .ok_or_else(|| invalid("invalid storage RPC id"))?;
        let close = request["operation"] == "close";
        let result = if close {
            Ok(Value::Null)
        } else {
            dispatch(&store, &request)
        };
        let response = match result {
            Ok(value) => json!({"id":id,"value":value}),
            Err(error) => {
                let message = error.to_string();
                let code = if message.contains("stale indexed store generation")
                    || message.contains("stale outstanding-work digest")
                {
                    "stale_authority"
                } else if message.contains("exact receipt replay conflict") {
                    "receipt_conflict"
                } else if message.contains("storage_pressure:") {
                    "storage_pressure"
                } else {
                    "storage_unavailable"
                };
                json!({"id":id,"error":{"code":code,"message":message}})
            }
        };
        serde_json::to_writer(&mut output, &response)
            .map_err(crate::indexed_store::storage_error)?;
        output
            .write_all(b"\n")
            .and_then(|_| output.flush())
            .map_err(crate::indexed_store::storage_error)?;
        if close {
            return Ok(());
        }
    }
}
