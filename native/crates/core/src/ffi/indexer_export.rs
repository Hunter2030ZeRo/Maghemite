use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
    slice,
};

use crate::{CoreError, StatusCode, index, workspace};

pub(super) fn ffi_call(f: impl FnOnce() -> Result<(), CoreError>) -> i32 {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(())) => StatusCode::Ok as i32,
        Ok(Err(error)) => error.code() as i32,
        Err(_) => StatusCode::Internal as i32,
    }
}

unsafe fn path_from_utf8(ptr: *const u8, len: usize) -> Result<PathBuf, CoreError> {
    if ptr.is_null() || len == 0 || len > isize::MAX as usize {
        return Err(CoreError::InvalidArgument(
            "path pointer or length is invalid",
        ));
    }
    // SAFETY: The caller promises a readable allocation of `len` bytes.
    let bytes = unsafe { slice::from_raw_parts(ptr, len) };
    let string =
        std::str::from_utf8(bytes).map_err(|_| CoreError::InvalidArgument("path must be UTF-8"))?;
    if string.contains('\0') {
        return Err(CoreError::InvalidArgument("path contains a NUL byte"));
    }
    Ok(PathBuf::from(string))
}

#[unsafe(no_mangle)]
pub extern "C" fn mg_core_abi_version() -> u32 {
    1
}

/// # Safety
/// Both path pointers must be readable for their lengths; `out_workspace_id` must be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mg_workspace_open(
    root_ptr: *const u8,
    root_len: usize,
    database_ptr: *const u8,
    database_len: usize,
    out_workspace_id: *mut u64,
) -> i32 {
    ffi_call(|| {
        if out_workspace_id.is_null() {
            return Err(CoreError::InvalidArgument(
                "workspace output pointer is null",
            ));
        }
        let root = unsafe { path_from_utf8(root_ptr, root_len) }?;
        let database = unsafe { path_from_utf8(database_ptr, database_len) }?;
        let id = workspace::open(root, database)?;
        // SAFETY: The caller promises writable storage for one u64.
        unsafe { out_workspace_id.write(id) };
        Ok(())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn mg_workspace_close(workspace_id: u64) -> i32 {
    ffi_call(|| index::close_workspace(workspace_id))
}

/// # Safety
/// `out_job_id` must point to writable storage for one u64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mg_index_start(workspace_id: u64, out_job_id: *mut u64) -> i32 {
    ffi_call(|| {
        if out_job_id.is_null() {
            return Err(CoreError::InvalidArgument("job output pointer is null"));
        }
        let id = index::start(workspace_id)?;
        // SAFETY: The caller promises writable storage for one u64.
        unsafe { out_job_id.write(id) };
        Ok(())
    })
}

/// Starts a targeted refresh. `paths_ptr` contains NUL-separated absolute UTF-8 paths.
/// # Safety
/// `paths_ptr` must be readable for `paths_len` bytes; `out_job_id` must be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mg_index_refresh_start(
    workspace_id: u64,
    paths_ptr: *const u8,
    paths_len: usize,
    out_job_id: *mut u64,
) -> i32 {
    ffi_call(|| {
        if out_job_id.is_null() || paths_ptr.is_null() || paths_len == 0 || paths_len > 1024 * 1024
        {
            return Err(CoreError::InvalidArgument("refresh path buffer is invalid"));
        }
        // SAFETY: The caller promises a readable buffer of `paths_len` bytes.
        let bytes = unsafe { slice::from_raw_parts(paths_ptr, paths_len) };
        let paths = bytes
            .split(|byte| *byte == 0)
            .map(|path| {
                if path.is_empty() {
                    return Err(CoreError::InvalidArgument("refresh path is empty"));
                }
                let path = std::str::from_utf8(path)
                    .map_err(|_| CoreError::InvalidArgument("refresh path must be UTF-8"))?;
                Ok(PathBuf::from(path))
            })
            .collect::<Result<Vec<_>, CoreError>>()?;
        let id = index::refresh(workspace_id, paths)?;
        // SAFETY: The caller promises writable storage for one u64.
        unsafe { out_job_id.write(id) };
        Ok(())
    })
}

/// # Safety
/// `out_status` must point to writable storage for one IndexStatus (eight u64 values).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mg_index_status(job_id: u64, out_status: *mut index::IndexStatus) -> i32 {
    ffi_call(|| {
        if out_status.is_null() {
            return Err(CoreError::InvalidArgument("status output pointer is null"));
        }
        let status = index::status(job_id)?;
        // SAFETY: The caller promises writable storage for one IndexStatus.
        unsafe { out_status.write(status) };
        Ok(())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn mg_index_cancel(job_id: u64) -> i32 {
    ffi_call(|| index::cancel(job_id))
}

#[unsafe(no_mangle)]
pub extern "C" fn mg_index_release(job_id: u64) -> i32 {
    ffi_call(|| index::release(job_id))
}

/// Returns the UTF-8 error length in `out_len`. Call again with a buffer of that size.
/// # Safety
/// `out_len` must be writable; `out_ptr` must be writable for `capacity` bytes when capacity > 0.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mg_index_error(
    job_id: u64,
    out_ptr: *mut u8,
    capacity: usize,
    out_len: *mut usize,
) -> i32 {
    if out_len.is_null() {
        return StatusCode::InvalidArgument as i32;
    }
    match catch_unwind(AssertUnwindSafe(|| index::error_message(job_id))) {
        Ok(Ok(message)) => {
            let bytes = message.as_bytes();
            // SAFETY: The caller promises writable storage for one usize.
            unsafe { out_len.write(bytes.len()) };
            if capacity < bytes.len() {
                return StatusCode::BufferTooSmall as i32;
            }
            if !bytes.is_empty() {
                if out_ptr.is_null() {
                    return StatusCode::InvalidArgument as i32;
                }
                // SAFETY: The caller promises a writable buffer of `capacity` bytes.
                unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_ptr, bytes.len()) };
            }
            StatusCode::Ok as i32
        }
        Ok(Err(error)) => error.code() as i32,
        Err(_) => StatusCode::Internal as i32,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn mg_core_shutdown() -> i32 {
    ffi_call(|| {
        index::shutdown();
        crate::services::shutdown();
        workspace::clear();
        Ok(())
    })
}
