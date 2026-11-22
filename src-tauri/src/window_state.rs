//! Remember where the main window was.
//!
//! The shipped app declares `center: true` for the main window and stores nothing, so
//! every launch puts it back on the primary monitor — on a two-monitor desk that means
//! dragging it across after each restart. The pet window already persists its own
//! position in `pet_config.json`; the main window had no equivalent.
//!
//! Deliberately in-process (no launcher script, no scheduler): the window saves its own
//! outer rect when it stops moving and is put back at startup. A saved rect that no
//! longer touches any monitor (unplugged display, changed resolution) is ignored and the
//! window is centred instead, so it can never restore off-screen.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Window};

const FILE_NAME: &str = "window_state.json";
/// How long the rect must stay unchanged before it is written.
const SETTLE: Duration = Duration::from_millis(500);
/// Minimum overlap with a monitor before a saved rect is accepted.
const MIN_VISIBLE: i32 = 120;

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

static DIRTY: AtomicBool = AtomicBool::new(false);
static LAST_EVENT: Mutex<Option<Instant>> = Mutex::new(None);

fn path() -> Option<PathBuf> {
    let dir = crate::utils::paths::data_dir()?.join("com.chyin.kokoro");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join(FILE_NAME))
}

fn load() -> Option<WindowState> {
    let raw = std::fs::read_to_string(path()?).ok()?;
    serde_json::from_str(&raw).ok()
}

fn store(state: WindowState) {
    let Some(path) = path() else { return };
    if let Ok(raw) = serde_json::to_string_pretty(&state) {
        let _ = std::fs::write(path, raw);
    }
}

fn overlaps_a_monitor(monitors: &[tauri::Monitor], state: &WindowState) -> bool {
    let left = state.x;
    let top = state.y;
    let right = state.x.saturating_add(state.width as i32);
    let bottom = state.y.saturating_add(state.height as i32);

    monitors.iter().any(|monitor| {
        let pos = monitor.position();
        let size = monitor.size();
        let overlap_x = right.min(pos.x.saturating_add(size.width as i32)) - left.max(pos.x);
        let overlap_y = bottom.min(pos.y.saturating_add(size.height as i32)) - top.max(pos.y);
        overlap_x >= MIN_VISIBLE && overlap_y >= MIN_VISIBLE
    })
}

/// Put the main window back where it was. Called once, from `setup`.
pub fn restore_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(state) = load() else {
        // First run: start centred on the primary monitor.
        let _ = window.center();
        return;
    };
    let monitors = window.available_monitors().unwrap_or_default();
    if !overlaps_a_monitor(&monitors, &state) {
        tracing::info!(target: "window", "saved window rect is off-screen; centring instead");
        let _ = window.center();
        return;
    }
    apply(&window, state);
    tracing::info!(
        target: "window",
        "restored main window at {},{} {}x{}",
        state.x,
        state.y,
        state.width,
        state.height
    );

    // A window that is still being realised silently ignores placement, and how long that
    // takes varies with the machine's load (measured: 2 of 3 launches landed at Windows'
    // default position instead). Keep re-applying until the window actually reports the
    // saved rect, then stop — self-correcting, bounded to ~5 s.
    std::thread::spawn(move || {
        for _ in 0..25 {
            std::thread::sleep(Duration::from_millis(200));
            match window.outer_position() {
                Ok(position)
                    if (position.x - state.x).abs() <= 2 && (position.y - state.y).abs() <= 2 =>
                {
                    return;
                }
                Ok(_) => apply(&window, state),
                Err(_) => continue,
            }
        }
        tracing::warn!(target: "window", "window did not accept its saved position");
    });
}

fn apply(window: &tauri::WebviewWindow, state: WindowState) {
    let _ = window.set_size(PhysicalSize::new(state.width, state.height));
    let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
}

/// Event entry point: mark the rect dirty, let the settler decide when to write.
///
/// Moving a window across monitors with different DPI fires several `Moved` events and
/// Windows adjusts the rect between them — a leading throttle wrote the *transient* rect
/// (measured: saved 3000,220 while the window settled at 3200,188). A trailing debounce
/// stores the position the owner actually left it in.
pub fn mark_dirty() {
    DIRTY.store(true, Ordering::Relaxed);
    if let Ok(mut last) = LAST_EVENT.lock() {
        *last = Some(Instant::now());
    }
}

/// Started once from `setup`: one write per drag, after the rect stops changing.
pub fn spawn_settler(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(200));
        if !DIRTY.load(Ordering::Relaxed) {
            continue;
        }
        let settled = LAST_EVENT
            .lock()
            .ok()
            .and_then(|last| *last)
            .map(|at| at.elapsed() >= SETTLE)
            .unwrap_or(false);
        if !settled {
            continue;
        }
        DIRTY.store(false, Ordering::Relaxed);
        if let Some(window) = app.get_webview_window("main") {
            // inner_size, because that is what set_size() restores; saving outer_size
            // grew the window by the frame thickness on every launch (measured
            // 1248 -> 1264 -> 1280 across restarts).
            let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
                continue;
            };
            store(WindowState {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            });
        }
    });
}

/// Final save on exit, ignoring the debounce.
pub fn save_now(window: &Window) {
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    store(WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    });
}
