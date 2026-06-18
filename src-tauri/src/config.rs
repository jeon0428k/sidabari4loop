use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

// 설정 스키마. 모든 필드 #[serde(default)] — 부분 파일도 관용적으로 로드.
// (구 Sidabari 설정 파일에 남아있던 ec2/deploy 등 알 수 없는 필드는 무시된다.)

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ClaudeCodeSession {
    pub directory: String,
    pub auto_start: bool,
    /// `--dangerously-skip-permissions` — 권한 프롬프트 없이 실행 (자율 루프용, 위험).
    pub skip_permissions: bool,
    /// `--chrome` — Claude Code의 Chrome 연동 옵션.
    pub chrome: bool,
    /// 그 밖에 claude에 넘길 추가 인자 (공백으로 구분).
    pub extra_args: String,
}

impl Default for ClaudeCodeSession {
    fn default() -> Self {
        Self {
            directory: String::new(),
            // Sidabari4Loop의 본질은 Claude Code 실행 — 기본적으로 claude를 자동 실행한다.
            auto_start: true,
            skip_permissions: false,
            chrome: false,
            extra_args: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ClaudeCodeSessions {
    pub main: ClaudeCodeSession,
}

impl Default for ClaudeCodeSessions {
    fn default() -> Self {
        Self {
            main: ClaudeCodeSession::default(),
        }
    }
}

// UI 토글. 콘솔 verbose 미러링, PreToolUse 게이트 활성 등.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct UiConfig {
    pub verbose_hook_logs: bool,
    /// Bash 도구 호출 시 PreToolUse 게이트 모달 활성 (기본 off).
    pub gate_dangerous_tools: bool,
    /// 메인 Claude 터미널 글꼴 크기(px). Ctrl+마우스 휠로 ±1 조정, 마지막 값을 유지한다.
    pub terminal_font_size: u16,
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            verbose_hook_logs: false,
            gate_dangerous_tools: false,
            terminal_font_size: 21,
        }
    }
}

// 턴 사이 컨텍스트 리셋 방식.
//  - Clear:   /clear — 대화를 비우고 새 세션(SessionStart source=clear). 컨텍스트 미보존.
//  - Compact: /compact — 대화를 요약 압축, 같은 세션 유지(SessionStart source=compact). 컨텍스트 보존.
//  - None:    리셋 없음 — /clear·/compact 모두 안 하고 운영 프롬프트만 재주입. 턴이 끝나므로
//             Claude Code의 auto-compact가 경계에서 컨텍스트를 관리한다(가장 가벼운 기본 정책).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextResetMode {
    Clear,
    Compact,
    None,
}

impl Default for ContextResetMode {
    fn default() -> Self {
        ContextResetMode::Compact
    }
}

// Supervisor 자동 연속 루프 설정.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SupervisorConfig {
    /// 루프 시작 시 첫 주입 + 매 컨텍스트 리셋 후 재주입할 "운영 프롬프트" 텍스트.
    pub operating_prompt: String,
    /// 무한 루프 방지 상한 (이 횟수만큼 주입하면 정지).
    pub max_iterations: u32,
    /// 턴 사이 컨텍스트 리셋 방식 (clear | compact).
    pub context_reset: ContextResetMode,
    /// compact 모드에서 /compact를 실행할 컨텍스트 점유 임계치(%). 이 값 미만이면 압축을 생략하고
    /// 같은 컨텍스트로 다음 턴을 이어간다. 0~100. 기본 50.
    pub compact_threshold_pct: u8,
    /// 컨텍스트 점유율 계산의 분모(토큰). Claude Code 실행 모델/베타에 따라 다르다
    /// (표준 200_000, 1M 컨텍스트 1_000_000). 트랜스크립트로 자동 감지 불가 → 설정값.
    pub context_window_tokens: u64,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            operating_prompt: String::new(),
            max_iterations: 500,
            context_reset: ContextResetMode::default(),
            compact_threshold_pct: 50,
            context_window_tokens: 1_000_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub schema_version: u32,
    pub claude_code_sessions: ClaudeCodeSessions,
    pub ui: UiConfig,
    pub supervisor: SupervisorConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            schema_version: 1,
            claude_code_sessions: ClaudeCodeSessions::default(),
            ui: UiConfig::default(),
            supervisor: SupervisorConfig::default(),
        }
    }
}

fn config_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir resolve 실패: {}", e))?;
    Ok(dir.join("config.json"))
}

#[tauri::command]
pub async fn load_config(app: tauri::AppHandle) -> Result<Config, String> {
    let path = config_file_path(&app)?;
    if !path.exists() {
        return Ok(Config::default());
    }
    let bytes = fs::read(&path).map_err(|e| format!("config 읽기 실패: {}", e))?;
    let config: Config = serde_json::from_slice(&bytes)
        .map_err(|e| format!("config JSON 파싱 실패: {}", e))?;
    Ok(config)
}

#[tauri::command]
pub async fn save_config(app: tauri::AppHandle, config: Config) -> Result<(), String> {
    if config.schema_version == 0 {
        return Err("schema_version 누락".to_string());
    }
    let path = config_file_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("config 디렉토리 생성 실패: {}", e))?;
    }
    let json =
        serde_json::to_vec_pretty(&config).map_err(|e| format!("config 직렬화 실패: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("config 쓰기 실패: {}", e))?;

    // CLAUDE.md §1.2.7 — 로그/설정 파일 권한 제한 (Unix만; Windows는 ACL 별도)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        fs::set_permissions(&path, perms)
            .map_err(|e| format!("config 권한 설정 실패: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn config_path(app: tauri::AppHandle) -> Result<String, String> {
    let path = config_file_path(&app)?;
    Ok(path.to_string_lossy().to_string())
}
