#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProcessRole {
    CefRenderer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ProcessUsage {
    pub(crate) pid: u32,
    pub(crate) rss_bytes: Option<u64>,
    pub(crate) role: Option<ProcessRole>,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct OwnedProcessUsage {
    pub(crate) supported: bool,
    pub(crate) complete: bool,
    pub(crate) processes: Vec<ProcessUsage>,
}

#[cfg(target_os = "linux")]
pub(crate) fn snapshot(max_processes: usize) -> OwnedProcessUsage {
    use std::collections::HashSet;

    let root = std::process::id();
    let mut result = OwnedProcessUsage {
        supported: true,
        complete: true,
        processes: Vec::new(),
    };
    let mut seen = HashSet::from([root]);
    let mut pending = vec![root];

    while let Some(pid) = pending.pop() {
        let tasks = match std::fs::read_dir(format!("/proc/{pid}/task")) {
            Ok(tasks) => tasks,
            Err(_) => {
                result.complete = false;
                continue;
            }
        };
        for task in tasks {
            let Ok(task) = task else {
                result.complete = false;
                continue;
            };
            let Some(thread) = task.file_name().to_str().map(str::to_owned) else {
                result.complete = false;
                continue;
            };
            if !thread.bytes().all(|byte| byte.is_ascii_digit()) {
                continue;
            }
            let children =
                match std::fs::read_to_string(format!("/proc/{pid}/task/{thread}/children")) {
                    Ok(children) => children,
                    Err(_) => {
                        result.complete = false;
                        continue;
                    }
                };
            for value in children.split_ascii_whitespace() {
                let Ok(child) = value.parse::<u32>() else {
                    result.complete = false;
                    continue;
                };
                if child == 0 || !seen.insert(child) {
                    continue;
                }
                if result.processes.len() == max_processes {
                    result.complete = false;
                    return result;
                }
                let rss_bytes = process_rss(child);
                if rss_bytes.is_none() {
                    result.complete = false;
                }
                result.processes.push(ProcessUsage {
                    pid: child,
                    rss_bytes,
                    role: process_role(child),
                });
                pending.push(child);
            }
        }
    }
    result
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn snapshot(_max_processes: usize) -> OwnedProcessUsage {
    OwnedProcessUsage {
        supported: false,
        complete: false,
        processes: Vec::new(),
    }
}

#[cfg(target_os = "linux")]
fn process_rss(pid: u32) -> Option<u64> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    parse_rss(&status)
}

#[cfg(target_os = "linux")]
fn parse_rss(status: &str) -> Option<u64> {
    status.lines().find_map(|line| {
        let value = line.strip_prefix("VmRSS:")?.trim();
        let kibibytes = value.strip_suffix("kB")?.trim().parse::<u64>().ok()?;
        kibibytes.checked_mul(1024)
    })
}

#[cfg(target_os = "linux")]
fn process_role(pid: u32) -> Option<ProcessRole> {
    let command = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    command_role(&command)
}

#[cfg(target_os = "linux")]
fn command_role(command: &[u8]) -> Option<ProcessRole> {
    command
        .split(|byte| *byte == 0)
        .any(|argument| argument == b"--type=renderer")
        .then_some(ProcessRole::CefRenderer)
}

#[cfg(all(test, target_os = "linux"))]
mod tests;
