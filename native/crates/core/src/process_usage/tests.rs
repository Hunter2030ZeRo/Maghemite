use std::{
    io::{Read, Write},
    process::{Child, Command, Stdio},
};

use super::{ProcessRole, command_role, parse_rss, snapshot};

struct WaitingChild(Child);

impl Drop for WaitingChild {
    fn drop(&mut self) {
        if let Err(error) = self.0.kill()
            && error.kind() != std::io::ErrorKind::InvalidInput
        {
            eprintln!("failed to kill telemetry test child: {error}");
        }
        if let Err(error) = self.0.wait() {
            eprintln!("failed to reap telemetry test child: {error}");
        }
    }
}

#[test]
fn parsers_preserve_unknown_rss_and_exact_renderer_role() {
    assert_eq!(parse_rss("Name:\tchild\nVmRSS:\t123 kB\n"), Some(125_952));
    assert_eq!(parse_rss("Name:\tchild\n"), None);
    assert_eq!(
        command_role(b"cef\0--type=renderer\0"),
        Some(ProcessRole::CefRenderer)
    );
    assert_eq!(command_role(b"cef\0--url=--type=renderer\0"), None);
}

#[test]
fn snapshot_samples_signalled_child_of_native_process() {
    const ISOLATED: &str = "MAGHEMITE_TELEMETRY_TEST_ISOLATED";
    // Other parallel tests create and retire threads. Their disappearing /proc
    // entries correctly make a snapshot partial, so test completeness in its own
    // stable process rather than depending on those threads' timing.
    if std::env::var_os(ISOLATED).is_none() {
        let status = Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "process_usage::tests::snapshot_samples_signalled_child_of_native_process",
                "--test-threads=1",
            ])
            .env(ISOLATED, "1")
            .status()
            .expect("run isolated telemetry test");
        assert!(status.success());
        return;
    }
    let mut child = WaitingChild(
        Command::new("/bin/sh")
            .args([
                "-c",
                "printf ready; IFS= read -r line",
                "maghemite-telemetry-child",
                "--type=renderer",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn telemetry child"),
    );
    let mut ready = [0_u8; 5];
    child
        .0
        .stdout
        .as_mut()
        .expect("child stdout")
        .read_exact(&mut ready)
        .expect("read child ready signal");
    assert_eq!(&ready, b"ready");

    let usage = snapshot(64);
    let process = usage
        .processes
        .iter()
        .find(|process| process.pid == child.0.id())
        .expect("snapshot includes direct child");
    assert!(usage.supported);
    assert!(usage.complete);
    assert!(process.rss_bytes.is_some_and(|rss| rss > 0));
    assert_eq!(process.role, Some(ProcessRole::CefRenderer));

    child
        .0
        .stdin
        .as_mut()
        .expect("child stdin")
        .write_all(b"\n")
        .expect("release child");
    assert!(child.0.wait().expect("wait for child").success());
}
