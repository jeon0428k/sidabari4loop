use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

// Supervisor 루프가 프로젝트 폴더의 텍스트 파일(docs/PROGRESS.md, docs/BUILD_ORDER.md 등)을
// 읽기 위한 커맨드. 임의 경로 읽기를 막기 위해 다음을 검증한다 (CLAUDE.md §1.2.2 path traversal):
//   - directory는 절대경로 + 실제 디렉토리
//   - relative는 상대경로 + ".." 컴포넌트 금지
//   - 정규화(canonicalize) 후에도 directory 내부에 있어야 함
// 파일이 없으면 Err가 아니라 Ok(None)을 돌려준다 (루프가 "MEMORY 아직 없음"을 구분할 수 있게).

#[tauri::command]
pub async fn read_project_text(
    directory: String,
    relative: String,
) -> Result<Option<String>, String> {
    let dir = PathBuf::from(directory.trim());
    if !dir.is_absolute() {
        return Err("directory는 절대경로여야 합니다".to_string());
    }
    if !dir.is_dir() {
        return Err(format!("directory가 존재하지 않습니다: {}", dir.display()));
    }

    let rel = relative.trim();
    if rel.is_empty() {
        return Err("relative 경로가 비어있습니다".to_string());
    }
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("relative는 상대경로여야 합니다".to_string());
    }
    if rel_path
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("relative에 '..'는 사용할 수 없습니다".to_string());
    }

    let full = dir.join(rel_path);
    if !full.exists() {
        return Ok(None);
    }

    // 정규화 후 directory 내부인지 재확인 (심볼릭 링크 우회 방어).
    let canon_dir = dir
        .canonicalize()
        .map_err(|e| format!("directory 정규화 실패: {}", e))?;
    let canon_full = full
        .canonicalize()
        .map_err(|e| format!("경로 정규화 실패: {}", e))?;
    if !canon_full.starts_with(&canon_dir) {
        return Err("경로가 directory를 벗어납니다".to_string());
    }
    if !canon_full.is_file() {
        return Err(format!("파일이 아닙니다: {}", canon_full.display()));
    }

    let content =
        fs::read_to_string(&canon_full).map_err(|e| format!("파일 읽기 실패: {}", e))?;
    Ok(Some(content))
}

// Claude Code 세션 트랜스크립트(.jsonl)에서 "현재 컨텍스트 점유"를 추정한다.
//   현재 점유 ≈ 마지막 assistant 메시지의 (input + cache_creation + cache_read) input 토큰.
//   (output_tokens는 모델이 생성한 응답이라 컨텍스트 누적분이 아님.)
//
// 경로는 훅 payload의 transcript_path에서 오므로, 임의 파일 읽기를 막기 위해 검증한다
// (CLAUDE.md §1.2.2): 절대경로 + 확장자 .jsonl + 경로에 `.claude/projects` 컴포넌트 포함.
// 파일이 없거나 usage를 못 찾으면 Ok(None).

/// context_window가 0/미지정일 때의 폴백.
const DEFAULT_CONTEXT_WINDOW: u64 = 1_000_000;
/// 트랜스크립트는 길어질 수 있어 끝부분만 읽는다.
const TRANSCRIPT_TAIL_BYTES: u64 = 512 * 1024;

#[derive(Debug, Serialize)]
pub struct ContextUsage {
    /// input + cache_creation + cache_read (현재 프롬프트에 들어간 컨텍스트 토큰 합).
    pub total_input_tokens: u64,
    /// 마지막 assistant 메시지의 생성 토큰 (참고용 — 컨텍스트 누적 아님).
    pub output_tokens: u64,
    /// 분모(컨텍스트 윈도우).
    pub context_window: u64,
}

#[tauri::command]
pub async fn context_usage(
    transcript_path: String,
    context_window: u64,
) -> Result<Option<ContextUsage>, String> {
    let window = if context_window > 0 {
        context_window
    } else {
        DEFAULT_CONTEXT_WINDOW
    };
    let path = PathBuf::from(transcript_path.trim());
    if !path.is_absolute() {
        return Err("transcript_path는 절대경로여야 합니다".to_string());
    }
    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err("transcript_path는 .jsonl 파일이어야 합니다".to_string());
    }
    // `.claude` 바로 다음에 `projects`가 오는 구간이 있는지 확인 (임의 경로 차단).
    let comps: Vec<String> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => s.to_str().map(|s| s.to_string()),
            _ => None,
        })
        .collect();
    let under_claude_projects = comps
        .windows(2)
        .any(|w| w[0] == ".claude" && w[1] == "projects");
    if !under_claude_projects {
        return Err("transcript_path가 .claude/projects 하위가 아닙니다".to_string());
    }
    if !path.is_file() {
        return Ok(None);
    }

    let mut file =
        fs::File::open(&path).map_err(|e| format!("트랜스크립트 열기 실패: {}", e))?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(TRANSCRIPT_TAIL_BYTES);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("트랜스크립트 seek 실패: {}", e))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("트랜스크립트 읽기 실패: {}", e))?;
    // 끝에서 잘라 읽었으므로 첫 줄은 깨졌을 수 있다 → from_utf8_lossy + 거꾸로 스캔하며
    // 파싱 실패 줄은 건너뛴다.
    let text = String::from_utf8_lossy(&bytes);

    for line in text.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // 서브에이전트(sidechain) 메시지는 메인 컨텍스트가 아니므로 제외.
        if v.get("isSidechain").and_then(|b| b.as_bool()) == Some(true) {
            continue;
        }
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let usage = match v.get("message").and_then(|m| m.get("usage")) {
            Some(u) => u,
            None => continue,
        };
        let field = |k: &str| usage.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
        let total_input_tokens = field("input_tokens")
            + field("cache_creation_input_tokens")
            + field("cache_read_input_tokens");
        return Ok(Some(ContextUsage {
            total_input_tokens,
            output_tokens: field("output_tokens"),
            context_window: window,
        }));
    }
    Ok(None)
}
