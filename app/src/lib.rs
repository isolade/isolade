use std::os::unix::process::CommandExt;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::path::BaseDirectory;
use tauri::Manager;

// The single isolade sidecar (API server + in-process sandbox runtime). It is
// spawned in its own process group so teardown can signal the whole tree —
// including the `msb` processes and microVMs it fans out to — rather than just
// the immediate child.
struct ServerProcess(Mutex<Option<Child>>);

/// Installed font family names on this machine, sorted and de-duplicated.
/// The webview (WKWebView on macOS) can't enumerate local fonts itself, so the
/// font picker invokes this command to populate its list.
#[tauri::command]
fn list_system_fonts() -> Vec<String> {
    use font_kit::source::SystemSource;

    let mut families = match SystemSource::new().all_families() {
        Ok(families) => families,
        Err(_) => return Vec::new(),
    };
    families.sort_by_key(|name| name.to_lowercase());
    families.dedup();
    families
}

/// Open a URL in the user's default system browser. The webview can't do this
/// itself — `window.open` inside WKWebView either no-ops or tries to spawn
/// another in-app webview — so the OAuth "Sign in" flow (ProvidersTab) hands the
/// authorize URL to the host, which asks the OS to open it. Called from Rust,
/// `shell().open` skips the JS-facing ACL scope check and needs no extra config.
#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    // Deprecated in favour of tauri-plugin-opener, but the shell plugin is
    // already a dependency and this is the only thing we use it for.
    #[allow(deprecated)]
    app.shell().open(url, None).map_err(|e| e.to_string())
}

fn repo_root() -> std::path::PathBuf {
    // The Tauri crate lives at <repo>/app, so the repo root is its parent. In
    // dev we derive it from CARGO_MANIFEST_DIR (baked in at compile time →
    // <repo>/app), which is correct regardless of the process's runtime cwd.
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent() // <repo>/app -> <repo>
        .unwrap()
        .to_path_buf()
}

/// Pick a free loopback TCP port for the API server. We bind :0, read the
/// assigned port, then drop the listener so the sidecar can claim it. A tiny
/// race window exists between drop and the sidecar's bind, but it's negligible
/// for a single-user desktop app and avoids hardcoding (and colliding on) 3000.
fn pick_free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(3000)
}

/// Mint the per-launch API bearer token: 32 random bytes from the OS CSPRNG,
/// hex-encoded. We hand it to the sidecar via ISOLADE_AUTH_TOKEN and inject the
/// same value into the webview (window.__ISOLADE__.token), so every API request
/// can present it and the Hono middleware can reject anything without it. Read
/// straight from /dev/urandom to avoid pulling in an RNG crate — this app is
/// already Unix-only (see the libc/killpg teardown paths). Panics if the read
/// fails: launching without a token would leave the API ungated.
fn generate_token() -> String {
    use std::io::Read;
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .expect("failed to read /dev/urandom for the API token");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const BUNDLED_NODE_NAME: &str = "microsandbox.darwin-arm64.node";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const BUNDLED_NODE_NAME: &str = "microsandbox.darwin-x64.node";
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const BUNDLED_NODE_NAME: &str = "microsandbox.linux-arm64-gnu.node";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const BUNDLED_NODE_NAME: &str = "microsandbox.linux-x64-gnu.node";
#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "aarch64"),
    all(target_os = "linux", target_arch = "x86_64")
)))]
compile_error!("Isolade release builds support macOS/Linux on arm64/x86_64 only");

/// True on macOS Tahoe (26) or newer. Tahoe's redesign enlarged the native
/// window controls (the "traffic lights") and widened the gaps between them, so
/// their metrics — the only OS-dependent input to the title-bar layout (see
/// [`mac_title_bar_layout`]) — differ from the pre-Tahoe ones. Detected from the
/// Darwin kernel release via sysctl — Darwin 25 == macOS 26 Tahoe (23 == Sonoma,
/// 24 == Sequoia) — which needs no new dependency (libc is already used for the
/// teardown paths) and mirrors the `>= 25` Tahoe check VSCode adopted for the
/// same title-bar alignment problem.
#[cfg(target_os = "macos")]
fn is_tahoe_or_newer() -> bool {
    let mut buf = [0u8; 32];
    let mut len = buf.len();
    // SAFETY: the name is a valid C string and (buf, len) describes a writable
    // buffer sysctl fills with the NUL-terminated release string (e.g. "25.5.0");
    // no new value is written (newp is null, newlen 0).
    let rc = unsafe {
        libc::sysctlbyname(
            c"kern.osrelease".as_ptr(),
            buf.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return false; // Unknown → assume pre-Tahoe, our long-standing default.
    }
    std::str::from_utf8(&buf[..len.saturating_sub(1)])
        .ok()
        .and_then(|release| release.split('.').next())
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major >= 25)
}

/// The app's title bar height, in logical pixels — the single constant the
/// window-chrome layout is built around. The native window controls (the
/// "traffic lights") are centred within a bar of exactly this height, and the
/// webview's own title bar is sized to match. packages/web keeps an identical
/// constant (TITLE_BAR_HEIGHT in lib/tauri.ts): it's a fixed design number, so a
/// mirrored literal on each side is simpler than threading a value across the
/// boundary — just keep the two in step. This does NOT include the native inset.
#[cfg(target_os = "macos")]
const TITLE_BAR_HEIGHT: f64 = 32.0;

/// The height AppKit gives a native traffic-light button — the extent wry
/// vertically centres — on a given macOS generation; the sole OS-dependent input
/// to [`traffic_light_position`]. macOS Tahoe (26) enlarged the controls, so it
/// needs its own value. Dialled in by eye (see the env override below). The
/// webview mirrors these values, plus the cluster width it also needs, in
/// lib/tauri.ts.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_HEIGHT_PRE_TAHOE: f64 = 12.0;
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_HEIGHT_TAHOE: f64 = 14.0;

/// MacOS draws an inset border around the window content.
#[cfg(target_os = "macos")]
const MACOS_WINDOW_INSET: f64 = 1.0;

/// The wry inset that places the native traffic lights, derived from
/// [`TITLE_BAR_HEIGHT`] and this machine's traffic-light height.
///
/// The rule: the leftmost light is inset from the top edge by an equal margin
/// above and below — i.e. vertically centred in the bar — where
/// `margin = (TITLE_BAR_HEIGHT − control_height) / 2`, and that *same* margin is
/// used as its inset from the left edge, so the light sits an equal distance
/// from the top, the bottom, and the left of the corner. wry expresses its inset
/// as `(x, y)` where `x` is the button's left origin (= the margin) and `y` is
/// the *extra* container height wry centres the button within (so the gap above
/// is `y/2`); centring in a bar of `TITLE_BAR_HEIGHT` therefore means
/// `y = TITLE_BAR_HEIGHT − control_height = 2·margin`.
///
/// `ISOLADE_TRAFFIC_LIGHT_HEIGHT` overrides the control height per run (e.g.
/// `ISOLADE_TRAFFIC_LIGHT_HEIGHT=26 bun run app`) so it can be dialled in by eye
/// without a recompile; the inset follows from the formula.
#[cfg(target_os = "macos")]
fn traffic_light_position(is_tahoe: bool) -> tauri::LogicalPosition<f64> {
    let control_height = if is_tahoe {
        TRAFFIC_LIGHT_HEIGHT_TAHOE
    } else {
        TRAFFIC_LIGHT_HEIGHT_PRE_TAHOE
    };
    let control_height = std::env::var("ISOLADE_TRAFFIC_LIGHT_HEIGHT")
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(control_height);
    let margin = (TITLE_BAR_HEIGHT - control_height) / 2.0;
    tauri::LogicalPosition::new(
        MACOS_WINDOW_INSET + margin,
        MACOS_WINDOW_INSET + 2.0 * margin,
    )
}

/// Terminate the sidecar's whole process group: SIGTERM (so it can stop VMs
/// cleanly and its msb/VM grandchildren get the signal), a short grace period,
/// then SIGKILL as a backstop so nothing is orphaned on quit. Idempotent — the
/// child is taken out of the Mutex on the first call.
fn terminate(state: &ServerProcess) {
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(mut child) = guard.take() {
        // process_group(0) made the child a group leader, so pgid == pid.
        let pgid = child.id() as i32;
        unsafe {
            libc::killpg(pgid, libc::SIGTERM);
        }
        // Up to ~3s for a graceful VM teardown, polling for exit.
        for _ in 0..30 {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
        let _ = child.wait();
    }
}

/// Create the parent-death watch pipe handed to the sidecar via
/// ISOLADE_PARENT_WATCH_FD (see packages/server/src/parent-watchdog.ts). The
/// child inherits the READ end and watches it for EOF; we keep the WRITE end
/// open for this process's whole life, so even a SIGKILL or crash of the app —
/// where neither `terminate()` nor any other handler gets to run — still closes
/// it, the child's read end hits EOF, and the sidecar tears its msb/VM subtree
/// down on its own. Returns (read_fd, write_fd), or None if the pipe couldn't be
/// created — in which case the sidecar falls back to its ppid-reparent poll.
fn make_parent_watch_pipe() -> Option<(libc::c_int, libc::c_int)> {
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: fds is a valid 2-element array for pipe(2) to fill.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return None;
    }
    let (read_fd, write_fd) = (fds[0], fds[1]);
    // SAFETY: both fds are owned by us and open here.
    unsafe {
        // The child must NOT inherit the write end — if it did, the pipe would
        // always have a live writer and never reach EOF.
        libc::fcntl(write_fd, libc::F_SETFD, libc::FD_CLOEXEC);
        // The child MUST inherit the read end. pipe(2) leaves it non-CLOEXEC,
        // but be explicit so a changed default can't silently break teardown.
        libc::fcntl(read_fd, libc::F_SETFD, 0);
    }
    Some((read_fd, write_fd))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![list_system_fonts, open_url])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let port = pick_free_port();
            // Per-launch bearer token gating the API. Passed to the sidecar via
            // env (below) and injected into the webview (initialization_script)
            // so both ends agree on the same secret for this launch.
            let token = generate_token();

            // The sandbox runtime runs in-process in the server (a Bun binary)
            // and reads MSB_HOME/MSB_PATH via native getenv. The sidecar owns
            // those paths (the TS xdg layer) and sets the *real* env itself via
            // setenv — Bun's `process.env` writes don't reach in-process native
            // getenv, so we no longer preset them here. We pass only what the
            // launcher alone knows: ISOLADE_MSB_BIN_DIR (the msb binary +
            // libkrunfw location — dev runtime vs bundled runtime) and, in
            // release, NAPI_RS_NATIVE_LIBRARY_PATH (consumed by napi-rs at
            // dlopen, before any JS runs).

            // Parent-death watch pipe: handed to the sidecar so it can tear its
            // VM subtree down even when we die without running any handler (a
            // SIGKILL/crash, or a terminal Ctrl-C that only reaches our process
            // group — the sidecar sits in its own). Belt-and-suspenders with
            // terminate() (clean quits) and the sidecar's own ppid poll.
            let watch_pipe = make_parent_watch_pipe();

            // One sidecar: the API server with the sandbox runtime embedded.
            // Its own process group (process_group(0)) lets teardown signal the
            // entire tree, including msb and the microVMs.
            let mut cmd = if cfg!(debug_assertions) {
                let root = repo_root();
                // Dev runtime assembled by dev.sh / assemble-msb-runtime.sh into
                // the gitignored app/binaries/msb-runtime — the same location
                // release bundles from, so dev and release share one artifact.
                let dev_bin = root.join("app/binaries/msb-runtime/bin");
                let mut c = Command::new("bun");
                // --watch reloads the server (and everything it imports —
                // packages/shared, packages/sandbox) on source change, so a
                // `bun run app` session picks up backend edits without a manual
                // restart, matching Vite's frontend HMR. bun restarts the entry
                // in place: this same process keeps its PID, process group, and
                // inherited ISOLADE_PARENT_WATCH_FD, and rebinds the OS-assigned
                // ISOLADE_PORT, so teardown and the webview's injected port both
                // survive the reload. Tradeoff: the sandbox runs in-process, so
                // each reload tears down running VMs — the same cost the browser
                // dev flow (scripts/dev.sh) already pays. --no-clear-screen keeps
                // the sidecar logs interleaved with Tauri's rather than wiping them.
                c.args([
                    "run",
                    "--watch",
                    "--no-clear-screen",
                    "packages/server/src/index.ts",
                ])
                .current_dir(&root)
                .env("ISOLADE_PORT", port.to_string())
                .env("ISOLADE_MSB_BIN_DIR", &dev_bin)
                .process_group(0);
                c
            } else {
                // Both the server sidecar and the microsandbox runtime ship as
                // Tauri resources. Resolve them through Tauri instead of
                // assuming a platform bundle layout: macOS puts resources under
                // Contents/Resources, while Linux packages install them under
                // the app's resource directory (for example /usr/lib/...).
                let sidecar = app
                    .path()
                    .resolve("binaries/Isolade", BaseDirectory::Resource)?;
                let runtime = app
                    .path()
                    .resolve("binaries/msb-runtime", BaseDirectory::Resource)?;
                let mut c = Command::new(sidecar);
                c.env(
                    "NAPI_RS_NATIVE_LIBRARY_PATH",
                    runtime.join(BUNDLED_NODE_NAME),
                )
                .env("ISOLADE_MSB_BIN_DIR", runtime.join("bin"))
                .env("ISOLADE_PORT", port.to_string())
                .process_group(0);
                c
            };

            // The running app version, surfaced to the sidecar so its once-per-
            // day update check can report it (see packages/server/src/
            // update-check.ts). The value comes from tauri.conf.json via Tauri's
            // package info. Only official releases — CI builds off a release/**
            // branch, which compile with ISOLADE_OFFICIAL_BUILD set (baked in
            // here via option_env!, so nothing at runtime can flip it) — report
            // the bare version. Every other build, `bun run app` dev sessions and
            // local `bun run build` bundles alike, appends "+dev".
            //
            // "+dev" is SemVer build metadata (not a "-dev" pre-release): main
            // carries the last *released* version, so a build off it is that
            // release "plus" unshipped commits — precedence-equal to the release,
            // just tagged into its own bucket of the version stats so dev
            // sessions never blend into the release install figures.
            let mut app_version = app.package_info().version.to_string();
            if option_env!("ISOLADE_OFFICIAL_BUILD")
                .unwrap_or("")
                .is_empty()
            {
                app_version.push_str("+dev");
            }
            cmd.env("ISOLADE_APP_VERSION", app_version);

            // The bearer token the API middleware enforces. Set once for both
            // the dev and release commands. Under `bun --watch` (dev) the sidecar
            // reloads in place and keeps this inherited env, so the token — like
            // ISOLADE_PORT — survives a reload and stays in sync with the value
            // injected into the webview below.
            cmd.env("ISOLADE_AUTH_TOKEN", &token);

            // Hand the sidecar the read end's fd number. The fd is inherited
            // across spawn() (it's not close-on-exec), so the child can open it.
            if let Some((read_fd, _)) = watch_pipe {
                cmd.env("ISOLADE_PARENT_WATCH_FD", read_fd.to_string());
            }

            let child = cmd.spawn().expect("failed to start isolade sidecar");

            if let Some((read_fd, _write_fd)) = watch_pipe {
                // The child now holds its own inherited copy of the read end, so
                // drop ours. We deliberately keep _write_fd open (a raw fd is not
                // closed on drop): it stays open for this process's lifetime and
                // is the EOF signal the sidecar waits on.
                // SAFETY: read_fd is our own fd, still open, used nowhere else.
                unsafe {
                    libc::close(read_fd);
                }
            }

            app.manage(ServerProcess(Mutex::new(Some(child))));

            // Whether this machine is on macOS Tahoe (26+), whose enlarged window
            // controls carry their own metrics. Injected into the webview so its
            // title bar picks the matching values (packages/web), and used below
            // to place the native controls. False off-macOS.
            #[cfg(target_os = "macos")]
            let is_tahoe = is_tahoe_or_newer();
            #[cfg(not(target_os = "macos"))]
            let is_tahoe = false;

            let builder =
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("/".into()))
                    .title("")
                    .inner_size(1280.0, 800.0)
                    .resizable(true)
                    .accept_first_mouse(true)
                    // Tell the webview which loopback port the API server bound this
                    // launch, the bearer token to authenticate with, and whether the host
                    // is on Tahoe (so its title bar picks the matching control metrics).
                    // Runs before page scripts, in dev and release alike. The token is
                    // hex, so it's safe to embed verbatim in a JS string literal.
                    .initialization_script(&format!(
                        "window.__ISOLADE__={{port:{port},token:\"{token}\",tahoe:{is_tahoe}}};"
                    ));

            #[cfg(target_os = "macos")]
            let builder = {
                // Place the native controls centred in a bar of TITLE_BAR_HEIGHT
                // (see traffic_light_position for the formula). NOTE: the layout
                // AppKit actually paints follows the macOS SDK the binary was
                // *linked* against, not the running OS — so the release must build
                // on the Tahoe SDK (see .github/workflows/ci.yml) for
                // is_tahoe to line up with what the user actually sees.
                builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .traffic_light_position(traffic_light_position(is_tahoe))
            };

            builder.build()?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<ServerProcess>() {
                    terminate(&state);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Covers quit paths that don't go through window-close (Cmd-Q, app
            // exit). terminate() is idempotent, so overlapping with the window
            // Destroyed handler is harmless.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<ServerProcess>() {
                    terminate(&state);
                }
            }
        });
}
