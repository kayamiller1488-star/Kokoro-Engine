//! Lifecycle for the two local speech services the AEC voice MOD depends on.
//!
//! The MOD runs inside this app's webview: it can capture the microphone and play
//! audio, but it cannot start a process. Without a supervisor the services
//! (mouth on :9881, ears on :9882) have to be started by hand or by an external
//! scheduler, and when one dies the only symptom is `Failed to fetch` inside a
//! 1x1 invisible frame - which reads exactly like "she cannot hear you".
//!
//! So the app owns them: start whatever is missing when it boots, check every
//! 30 s while it runs, and kill the ones it started when it exits. Processes the
//! app did not spawn (a manual start, another stack) are never touched.

use std::fs::OpenOptions;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

const CHECK_INTERVAL: Duration = Duration::from_secs(30);
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(6);

struct ServiceSpec {
    name: &'static str,
    port: u16,
    project: &'static str,
    script: &'static str,
}

const SERVICES: [ServiceSpec; 2] = [
    ServiceSpec {
        name: "mouth",
        port: 9881,
        project: r"C:\Projects\va-mouth",
        script: "serve_tts.py",
    },
    ServiceSpec {
        name: "ears",
        port: 9882,
        project: r"C:\Projects\va-ears",
        script: "asr_server.py",
    },
];

#[derive(Default)]
pub struct VaStack {
    children: Mutex<Vec<(&'static str, Child)>>,
}

fn port_open(port: u16) -> bool {
    // A TCP connect is enough: both servers answer on loopback and a listening
    // socket is the difference between "there" and "not there".
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().expect("static socket address"),
        Duration::from_millis(400),
    )
    .is_ok()
}

/// The windowless interpreter when the venv ships one: a console python owns a
/// console window, which is visible as a flash on the owner's desktop.
fn interpreter(project: &Path) -> Option<PathBuf> {
    let scripts = project.join(".venv").join("Scripts");
    let pythonw = scripts.join("pythonw.exe");
    if pythonw.exists() {
        return Some(pythonw);
    }
    let python = scripts.join("python.exe");
    if python.exists() {
        return Some(python);
    }
    None
}

fn log_file(project: &str, name: &str, stderr: bool) -> Stdio {
    let dir = Path::new(project).join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(format!("{name}{}.log", if stderr { ".err" } else { "" }));
    match OpenOptions::new().create(true).append(true).open(path) {
        Ok(file) => Stdio::from(file),
        Err(_) => Stdio::null(),
    }
}

impl VaStack {
    fn spawn(&self, spec: &ServiceSpec) -> bool {
        let project = Path::new(spec.project);
        let Some(exe) = interpreter(project) else {
            tracing::warn!(
                target: "va_stack",
                "[va-stack] {}: no interpreter under {}",
                spec.name,
                spec.project
            );
            return false;
        };
        let mut command = Command::new(&exe);
        command
            .arg(spec.script)
            .current_dir(project)
            // The ears print transcripts verbatim; a redirected stdout on Windows uses
            // the locale codec, so a Japanese transcript used to die with
            // UnicodeEncodeError inside the log line and the request never got answered.
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1")
            .stdin(Stdio::null())
            .stdout(log_file(spec.project, spec.name, false))
            .stderr(log_file(spec.project, spec.name, true));
        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW: never create a console for the child.
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        match command.spawn() {
            Ok(child) => {
                tracing::info!(target: "va_stack", "[va-stack] started {} (pid {})", spec.name, child.id());
                if let Ok(mut children) = self.children.lock() {
                    children.push((spec.name, child));
                }
                true
            }
            Err(error) => {
                tracing::error!(target: "va_stack", "[va-stack] failed to start {}: {error}", spec.name);
                false
            }
        }
    }

    /// Start anything that is not answering, and reap children that died so a
    /// crash does not leak handles into the next check.
    pub fn ensure(&self) {
        for spec in SERVICES.iter() {
            if port_open(spec.port) {
                continue;
            }
            let started = self.spawn(spec);
            if started {
                // Give the model a moment before the next service is checked;
                // both load an ONNX model at import.
                std::thread::sleep(Duration::from_millis(300));
            }
        }
        if let Ok(mut children) = self.children.lock() {
            children.retain_mut(|(name, child)| match child.try_wait() {
                Ok(Some(_)) => {
                    tracing::info!(target: "va_stack", "[va-stack] {name} exited");
                    false
                }
                _ => true,
            });
        }
    }

    /// Kill only the processes this app started.
    pub fn stop_all(&self) {
        if let Ok(mut children) = self.children.lock() {
            for (name, child) in children.iter_mut() {
                match child.kill() {
                    Ok(()) => tracing::info!(target: "va_stack", "[va-stack] stopped {name}"),
                    Err(error) => tracing::warn!(target: "va_stack", "[va-stack] could not stop {name}: {error}"),
                }
            }
            children.clear();
        }
    }

    /// Check once now, then keep checking in the background for the life of the app.
    pub fn supervise(self: std::sync::Arc<Self>) {
        std::thread::spawn(move || {
            // Let the app finish its own startup first: the DB open plus config and
            // history restore happen in that window, and two ONNX models loading at
            // the same moment measurably slows it (which is when the front end's
            // early `list_characters` call used to land on a half-built app).
            std::thread::sleep(FIRST_CHECK_DELAY);
            loop {
                self.ensure();
                std::thread::sleep(CHECK_INTERVAL);
            }
        });
    }
}
