mod audit_log;
mod config;
mod hook_installer;
mod hooks_bus;
mod pty;
mod supervisor;
mod window_clamp;

use std::sync::Arc;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // window-state 복원 "뒤에" 등록해야 한다 — 복원된 기하를 화면 안으로 보정한다.
        // (window_clamp.rs 참조: window-state 는 SIZE 를 무조건, POSITION 을 약한 교차검사로 복원함)
        .plugin(window_clamp::plugin())
        .plugin(tauri_plugin_notification::init())
        .manage(Arc::new(pty::PtyState::default()))
        .setup(|app| {
            // audit DB가 hooks_bus 보다 먼저 init되어야 한다 (tail_events가 참조).
            match audit_log::init(app.handle()) {
                Ok(db) => {
                    app.manage(Arc::new(db));
                }
                Err(e) => {
                    eprintln!("[lib] audit_log init 실패 — 영구 적재 비활성: {}", e);
                }
            }
            // Claude Code 훅 IPC 부트.
            // 실패 시 앱은 계속 동작하되 훅 기능 비활성. (CLAUDE.md §1.3 자동 재시도 X)
            match hooks_bus::init(app.handle()) {
                Ok(bus) => {
                    app.manage(Arc::new(bus));
                }
                Err(e) => {
                    eprintln!("[lib] hooks_bus init 실패 — 훅 기능 비활성: {}", e);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::load_config,
            config::save_config,
            config::config_path,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            hook_installer::install_claude_hooks,
            hook_installer::claude_hooks_status,
            hooks_bus::hook_gate_respond,
            hooks_bus::hook_paths,
            supervisor::read_project_text,
            supervisor::context_usage,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
