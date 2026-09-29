use std::slice;

use crate::{
    CoreError,
    process_usage::{self, ProcessRole},
};

use super::indexer_export::ffi_call;

const WORDS_PER_PROCESS: usize = 3;
const META_WORDS: usize = 2;
const RSS_UNKNOWN: u64 = u64::MAX;
const FLAG_SUPPORTED: u64 = 1;
const FLAG_COMPLETE: u64 = 2;

/// Samples descendants of this native core process.
///
/// Each process occupies three u64 values: PID, RSS bytes (u64::MAX when unknown),
/// and role (zero for none, one for an owned CEF renderer). Metadata contains the
/// process count followed by supported/complete flags.
///
/// # Safety
/// `out_processes` must be writable for `capacity * 3` u64 values and `out_meta`
/// must be writable for two u64 values.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mg_owned_process_usage(
    out_processes: *mut u64,
    capacity: usize,
    out_meta: *mut u64,
) -> i32 {
    ffi_call(|| {
        let Some(word_capacity) = capacity.checked_mul(WORDS_PER_PROCESS) else {
            return Err(CoreError::InvalidArgument(
                "process output capacity overflows",
            ));
        };
        if out_processes.is_null() || out_meta.is_null() || capacity == 0 {
            return Err(CoreError::InvalidArgument(
                "process output buffer is invalid",
            ));
        }
        // SAFETY: The caller promises writable storage for `capacity * 3` u64 values.
        let output = unsafe { slice::from_raw_parts_mut(out_processes, word_capacity) };
        // SAFETY: The caller promises writable storage for two metadata u64 values.
        let meta = unsafe { slice::from_raw_parts_mut(out_meta, META_WORDS) };
        let snapshot = process_usage::snapshot(capacity);
        for (index, process) in snapshot.processes.iter().enumerate() {
            let offset = index * WORDS_PER_PROCESS;
            output[offset] = u64::from(process.pid);
            output[offset + 1] = process.rss_bytes.unwrap_or(RSS_UNKNOWN);
            output[offset + 2] = match process.role {
                None => 0,
                Some(ProcessRole::CefRenderer) => 1,
            };
        }
        meta[0] = u64::try_from(snapshot.processes.len())
            .map_err(|_| CoreError::Internal("process count does not fit u64".to_owned()))?;
        meta[1] = (u64::from(snapshot.supported) * FLAG_SUPPORTED)
            | (u64::from(snapshot.complete) * FLAG_COMPLETE);
        Ok(())
    })
}
