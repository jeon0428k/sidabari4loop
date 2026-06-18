import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

// 설정 스키마. Rust 측 src-tauri/src/config.rs 와 1:1 대응.
// IPC 응답 검증 (CLAUDE.md §3.2): zod로 런타임 파싱. 알 수 없는 키는 strip.

export const ClaudeCodeSessionSchema = z.object({
  directory: z.string().default(""),
  // Sidabari4Loop의 본질은 Claude Code 실행 — 기본 auto_start true.
  auto_start: z.boolean().default(true),
  // --dangerously-skip-permissions (자율 루프용, 위험).
  skip_permissions: z.boolean().default(false),
  // --chrome.
  chrome: z.boolean().default(false),
  // 추가 인자 (공백 구분).
  extra_args: z.string().default(""),
});

const DEFAULT_MAIN_SESSION = {
  directory: "",
  auto_start: true,
  skip_permissions: false,
  chrome: false,
  extra_args: "",
};

export const ClaudeCodeSessionsSchema = z.object({
  main: ClaudeCodeSessionSchema.default(DEFAULT_MAIN_SESSION),
});

// UI 토글류. Rust 측 UiConfig와 1:1.
export const UiConfigSchema = z
  .object({
    // 콘솔에 PreToolUse/PostToolUse 같은 시끄러운 훅 이벤트도 표시할지 (기본 off).
    verbose_hook_logs: z.boolean().default(false),
    // Bash 도구 호출 시 PreToolUse 게이트 모달 활성 (기본 off).
    gate_dangerous_tools: z.boolean().default(false),
    // 메인 Claude 터미널 글꼴 크기(px). Ctrl+휠로 조정, 마지막 값 유지. 범위 8~48.
    terminal_font_size: z.number().int().min(8).max(48).default(21),
  })
  .default({
    verbose_hook_logs: false,
    gate_dangerous_tools: false,
    terminal_font_size: 21,
  });

// 턴 사이 컨텍스트 리셋 방식 (Rust ContextResetMode와 1:1).
//  - clear:   /clear — 컨텍스트 미보존(새 세션)
//  - compact: /compact — 요약 압축, 같은 세션(컨텍스트 보존)
//  - none:    리셋 없이 운영 프롬프트만 재주입 (auto-compact가 경계 관리)
export const ContextResetModeSchema = z.enum(["clear", "compact", "none"]).default("compact");
export type ContextResetMode = z.infer<typeof ContextResetModeSchema>;

// Supervisor 자동 연속 루프 설정. Rust 측 SupervisorConfig와 1:1.
export const SupervisorConfigSchema = z
  .object({
    // 루프 시작 시 첫 주입 + 매 컨텍스트 리셋 후 재주입할 운영 프롬프트.
    operating_prompt: z.string().default(""),
    // 무한 루프 방지 상한.
    max_iterations: z.number().int().positive().default(500),
    // 턴 사이 컨텍스트 리셋 방식.
    context_reset: ContextResetModeSchema,
    // compact를 실행할 컨텍스트 점유 임계치(%). 미만이면 압축 생략.
    compact_threshold_pct: z.number().int().min(0).max(100).default(50),
    // 점유율 분모(토큰). 표준 200000, 1M 컨텍스트 1000000.
    context_window_tokens: z.number().int().positive().default(1_000_000),
  })
  .default({
    operating_prompt: "",
    max_iterations: 500,
    context_reset: "compact",
    compact_threshold_pct: 50,
    context_window_tokens: 1_000_000,
  });

export const ConfigSchema = z.object({
  schema_version: z.number().int().positive().default(1),
  claude_code_sessions: ClaudeCodeSessionsSchema.default({
    main: DEFAULT_MAIN_SESSION,
  }),
  ui: UiConfigSchema,
  supervisor: SupervisorConfigSchema,
});

export type Config = z.infer<typeof ConfigSchema>;

export async function loadConfig(): Promise<Config> {
  const raw = await invoke("load_config");
  return ConfigSchema.parse(raw);
}

export async function saveConfig(config: Config): Promise<void> {
  await invoke("save_config", { config });
}

export async function getConfigPath(): Promise<string> {
  return await invoke<string>("config_path");
}
