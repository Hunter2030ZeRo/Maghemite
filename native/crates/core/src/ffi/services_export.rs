use crate::{StatusCode, services};
use std::panic::{AssertUnwindSafe, catch_unwind};
/// Executes exactly once. The caller must supply a full 64 KiB reply allocation,
/// even for probes: mutating operations must never run twice to size a result.
/// # Safety
/// Input is readable for input_len; output is writable for capacity; output_len is writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mg_workspace_request(
    workspace: u64,
    input: *const u8,
    input_len: usize,
    output: *mut u8,
    capacity: usize,
    output_len: *mut usize,
) -> i32 {
    if input.is_null()
        || input_len == 0
        || input_len > 65536
        || output.is_null()
        || capacity < 65536
        || output_len.is_null()
    {
        return StatusCode::InvalidArgument as i32;
    }
    let result = catch_unwind(AssertUnwindSafe(|| {
        let bytes = unsafe { std::slice::from_raw_parts(input, input_len) };
        let result = (|| {
            let request: serde_json::Value =
                serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
            let method = request["method"].as_str().ok_or("Missing method")?;
            services::request(workspace, method, &request["parameters"])
        })();
        let value = match result {
            Ok(value) => serde_json::json!({"ok":true,"value":value}),
            Err(error) => serde_json::json!({"ok":false,"error":error}),
        };
        let mut bytes = serde_json::to_vec(&value).unwrap();
        if bytes.len() > 65536 {
            bytes = br#"{"ok":false,"error":"Native result exceeds page limit"}"#.to_vec();
        }
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), output, bytes.len());
            output_len.write(bytes.len());
        }
    }));
    if result.is_ok() {
        StatusCode::Ok as i32
    } else {
        StatusCode::Internal as i32
    }
}
