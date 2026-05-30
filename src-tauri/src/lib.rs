use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
  fs,
  io::{BufRead, BufReader},
  net::TcpStream,
  path::{Path, PathBuf},
  process::{Child, Command, Stdio},
  sync::{Arc, Mutex},
  thread,
  time::Duration,
};
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
struct SidecarManager {
  inner: Arc<Mutex<SidecarState>>,
}

#[derive(Default)]
struct SidecarState {
  child: Option<Child>,
  port: Option<u16>,
  hook_port: Option<u16>,
  data_dir: String,
  launch_mode: String,
  stderr_tail: Vec<String>,
  stdout_tail: Vec<String>,
  fatal_event: Option<String>,
}

#[derive(Serialize, Clone)]
struct RuntimeInfo {
  running: bool,
  port: Option<u16>,
  #[serde(rename = "hookPort")]
  hook_port: Option<u16>,
  data_dir: String,
  launch_mode: String,
}

#[derive(Deserialize)]
struct DaemonManifest {
  pid: u32,
  port: u16,
  #[serde(rename = "hookPort")]
  hook_port: Option<u16>,
  #[serde(rename = "appDataDir")]
  app_data_dir: String,
}

fn bundled_sidecar_dir(app: &AppHandle) -> Option<PathBuf> {
  let resource_dir = app.path().resource_dir().ok()?;
  let direct = resource_dir.join(".sidecar-bundle");
  if direct.exists() {
    return Some(direct);
  }

  let tauri_relative = resource_dir.join("_up_").join(".sidecar-bundle");
  if tauri_relative.exists() {
    return Some(tauri_relative);
  }

  None
}

fn path_status(path: &Path) -> String {
  format!("{} exists={}", path.display(), path.exists())
}

fn dev_sidecar_dir() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("sidecar")
}

fn sidecar_entrypoint(app: &AppHandle) -> Result<(PathBuf, PathBuf, String), String> {
  let mut checked_paths: Vec<String> = Vec::new();
  let resource_dir = app.path().resource_dir().ok();
  if let Some(bundle_dir) = bundled_sidecar_dir(app) {
    let node_path = bundle_dir.join("runtime").join("node");
    let entrypoint = bundle_dir.join("app").join("index.js");
    checked_paths.push(path_status(&bundle_dir));
    checked_paths.push(path_status(&node_path));
    checked_paths.push(path_status(&entrypoint));
    if node_path.exists() && entrypoint.exists() {
      return Ok((node_path, entrypoint, "bundled".to_string()));
    }
  }

  let script_dir = dev_sidecar_dir();
  let script_path = script_dir.join("index.js");
  checked_paths.push(path_status(&script_dir));
  checked_paths.push(path_status(&script_path));
  if script_path.exists() {
    return Ok((PathBuf::from("node"), script_path, "dev".to_string()));
  }

  Err(format!(
    "Sidecar-Einstiegspunkt wurde weder im Bundle noch lokal gefunden.\nresource_dir={}\nGepruefte Pfade:\n{}",
    resource_dir
      .as_ref()
      .map(|path| path.display().to_string())
      .unwrap_or_else(|| "unbekannt".to_string()),
    checked_paths.join("\n")
  ))
}

fn daemon_manifest_path(app_data_dir: &Path) -> PathBuf {
  app_data_dir.join("sidecar-daemon.json")
}

fn read_daemon_manifest(path: &Path) -> Option<DaemonManifest> {
  fs::read_to_string(path)
    .ok()
    .and_then(|content| serde_json::from_str::<DaemonManifest>(&content).ok())
}

fn tcp_port_alive(port: u16) -> bool {
  TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn reuse_existing_daemon(app_data_dir: &Path, state: &State<'_, SidecarManager>) -> Result<Option<RuntimeInfo>, String> {
  let manifest_path = daemon_manifest_path(app_data_dir);
  let Some(manifest) = read_daemon_manifest(&manifest_path) else {
    return Ok(None);
  };

  if !tcp_port_alive(manifest.port) {
    let _ = fs::remove_file(&manifest_path);
    return Ok(None);
  }

  let mut inner = state.inner.lock().map_err(|_| "state lock failed".to_string())?;
  inner.port = Some(manifest.port);
  inner.hook_port = manifest.hook_port;
  inner.data_dir = manifest.app_data_dir.clone();
  inner.launch_mode = "reused".to_string();

  Ok(Some(RuntimeInfo {
    running: true,
    port: Some(manifest.port),
    hook_port: manifest.hook_port,
    data_dir: manifest.app_data_dir,
    launch_mode: format!("reused-pid-{}", manifest.pid),
  }))
}

fn spawn_sidecar_if_needed(app: &AppHandle, state: &State<'_, SidecarManager>) -> Result<RuntimeInfo, String> {
  {
    let inner = state.inner.lock().map_err(|_| "state lock failed".to_string())?;
    if inner.child.is_some() && inner.port.is_some() {
      return Ok(RuntimeInfo {
        running: true,
        port: inner.port,
        hook_port: inner.hook_port,
        data_dir: inner.data_dir.clone(),
        launch_mode: inner.launch_mode.clone(),
      });
    }
  }

  let app_data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
  fs::create_dir_all(&app_data_dir).map_err(|err| err.to_string())?;

  if let Some(runtime) = reuse_existing_daemon(&app_data_dir, state)? {
    return Ok(runtime);
  }

  let (runtime_binary, entrypoint, launch_mode) = sidecar_entrypoint(app)?;
  let script_root = entrypoint
    .parent()
    .ok_or_else(|| "invalid sidecar path".to_string())?
    .to_path_buf();
  let resource_dir = app
    .path()
    .resource_dir()
    .map(|path| path.display().to_string())
    .unwrap_or_else(|_| "unbekannt".to_string());
  let launch_context = format!(
    "runtime={} runtime_exists={} entrypoint={} entrypoint_exists={} script_root={} resource_dir={} launch_mode={}",
    runtime_binary.display(),
    if runtime_binary.is_absolute() {
      runtime_binary.exists()
    } else {
      true
    },
    entrypoint.display(),
    entrypoint.exists(),
    script_root.display(),
    resource_dir,
    launch_mode
  );

  let runtime_exists = if runtime_binary.is_absolute() {
    runtime_binary.exists()
  } else {
    true
  };
  if !runtime_exists || !entrypoint.exists() {
    return Err(format!(
      "Sidecar-Runtime unvollstaendig. runtime={} entrypoint={}",
      runtime_binary.display(),
      entrypoint.display()
    ));
  }

  let mut child = Command::new(&runtime_binary)
    .arg(&entrypoint)
    .current_dir(&script_root)
    .env("CLAUDE_MAC_APP_DATA_DIR", app_data_dir.to_string_lossy().to_string())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|err| format!("Sidecar konnte nicht gestartet werden: {err}\n{launch_context}"))?;

  let stdout = child
    .stdout
    .take()
    .ok_or_else(|| "sidecar stdout unavailable".to_string())?;
  let stderr = child
    .stderr
    .take()
    .ok_or_else(|| "sidecar stderr unavailable".to_string())?;
  let shared = Arc::clone(&state.inner);
  let launch_mode_clone = launch_mode.clone();

  {
    let mut inner = state.inner.lock().map_err(|_| "state lock failed".to_string())?;
    inner.child = Some(child);
    inner.data_dir = app_data_dir.to_string_lossy().to_string();
    inner.port = None;
    inner.hook_port = None;
    inner.stderr_tail.clear();
    inner.stdout_tail.clear();
    inner.fatal_event = None;
    inner.launch_mode = launch_mode.clone();
  }

  thread::spawn(move || {
    let reader = BufReader::new(stdout);
    for line in reader.lines().map_while(Result::ok) {
      if let Ok(json) = serde_json::from_str::<Value>(&line) {
        let event_type = json.get("type").and_then(Value::as_str).unwrap_or("json");
        if matches!(
          event_type,
          "bootstrap_started"
            | "native_check_started"
            | "native_check_success"
            | "native_check_failed"
            | "main_loading"
            | "ready"
            | "fatal"
            | "fatal_diagnostic_server_ready"
        ) {
          if let Ok(mut inner) = shared.lock() {
            inner.stdout_tail.push(line.clone());
            if inner.stdout_tail.len() > 120 {
              inner.stdout_tail.remove(0);
            }
            if event_type == "fatal" {
              inner.fatal_event = Some(line.clone());
            }
          }
        }
        if event_type == "ready" {
          if let Some(port) = json.get("port").and_then(Value::as_u64) {
            if let Ok(mut inner) = shared.lock() {
              inner.port = Some(port as u16);
              inner.hook_port = json.get("hookPort").and_then(Value::as_u64).map(|value| value as u16);
              inner.launch_mode = launch_mode_clone.clone();
            }
          }
          continue;
        }
      }
      println!("[sidecar] {line}");
    }
  });

  let stderr_shared = Arc::clone(&state.inner);
  thread::spawn(move || {
    let reader = BufReader::new(stderr);
    for line in reader.lines().map_while(Result::ok) {
      if let Ok(mut inner) = stderr_shared.lock() {
        inner.stderr_tail.push(line.clone());
        if inner.stderr_tail.len() > 80 {
          inner.stderr_tail.remove(0);
        }
      }
      eprintln!("[sidecar] {line}");
    }
  });

  for _ in 0..100 {
    {
      let mut inner = state.inner.lock().map_err(|_| "state lock failed".to_string())?;
      if inner.port.is_some() {
        return Ok(RuntimeInfo {
          running: true,
          port: inner.port,
          hook_port: inner.hook_port,
          data_dir: inner.data_dir.clone(),
          launch_mode: inner.launch_mode.clone(),
          });
      }
      if let Some(fatal) = inner.fatal_event.clone() {
        let stdout = if inner.stdout_tail.is_empty() {
          "keine stdout-Diagnose".to_string()
        } else {
          inner.stdout_tail.join("\n")
        };
        let stderr = if inner.stderr_tail.is_empty() {
          "keine stderr-Ausgabe".to_string()
        } else {
          inner.stderr_tail.join("\n")
        };
        return Err(format!(
          "Sidecar-Bootstrap fatal.\n{launch_context}\nfatal={fatal}\nstdout events:\n{stdout}\nstderr:\n{stderr}"
        ));
      }
      if let Some(child) = inner.child.as_mut() {
        if let Ok(Some(status)) = child.try_wait() {
          let stderr = if inner.stderr_tail.is_empty() {
            "keine stderr-Ausgabe".to_string()
          } else {
            inner.stderr_tail.join("\n")
          };
          let stdout = if inner.stdout_tail.is_empty() {
            "keine stdout-Diagnose".to_string()
          } else {
            inner.stdout_tail.join("\n")
          };
          return Err(format!(
            "Sidecar wurde beendet, bevor ein WebSocket-Port gemeldet wurde. Status: {status}.\n{launch_context}\nstdout events:\n{stdout}\nLetzte stderr-Zeilen:\n{stderr}"
          ));
        }
      }
    }
    thread::sleep(Duration::from_millis(100));
  }

  let (stderr, stdout) = {
    let inner = state.inner.lock().map_err(|_| "state lock failed".to_string())?;
    let stderr = if inner.stderr_tail.is_empty() {
      "keine stderr-Ausgabe".to_string()
    } else {
      inner.stderr_tail.join("\n")
    };
    let stdout = if inner.stdout_tail.is_empty() {
      "keine stdout-Diagnose".to_string()
    } else {
      inner.stdout_tail.join("\n")
    };
    (stderr, stdout)
  };

  Err(format!(
    "Sidecar hat keinen WebSocket-Port gemeldet.\n{launch_context}\nstdout events:\n{stdout}\nLetzte stderr-Zeilen:\n{stderr}"
  ))
}

#[tauri::command]
fn ensure_sidecar(app: AppHandle, state: State<'_, SidecarManager>) -> Result<RuntimeInfo, String> {
  spawn_sidecar_if_needed(&app, &state)
}

#[tauri::command]
fn restart_sidecar(app: AppHandle, state: State<'_, SidecarManager>) -> Result<RuntimeInfo, String> {
  let app_data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
  {
    let mut inner = state.inner.lock().map_err(|_| "state lock failed".to_string())?;
    if let Some(child) = inner.child.as_mut() {
      let _ = child.kill();
      let _ = child.wait();
    }
    inner.child = None;
    inner.port = None;
    inner.hook_port = None;
    inner.launch_mode = "restarting".to_string();
    inner.stderr_tail.clear();
    inner.stdout_tail.clear();
    inner.fatal_event = None;
  }
  let _ = fs::remove_file(daemon_manifest_path(&app_data_dir));
  spawn_sidecar_if_needed(&app, &state)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(SidecarManager::default())
    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![ensure_sidecar, restart_sidecar])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
