import { create } from "zustand";

// 패널 포커스 추적용 ID.
export type PanelId = "main-claude" | "console" | "progress";

export type ConsoleEvent = {
  id: string;
  timestamp: Date;
  source: string;
  message: string;
};

// 패널별 Claude turn 활성 상태. key는 SIDABARI4LOOP_PANEL_ID (예: "main-claude").
// SessionStart/Pre/PostToolUse → "thinking", Stop → "idle".
export type PanelActivityState = "thinking" | "idle";
export type PanelActivity = {
  state: PanelActivityState;
  /** Date.now() — "thinking 시작" 또는 "idle 진입" 시각. */
  since: number;
};

// 진행 중 도구 가시화. PreToolUse 시 set, Stop 시 clear.
export type PanelCurrentTool = {
  /** 도구명 (Bash, Edit, Write 등) */
  tool: string;
  /** 사용자 가시 요약 (명령 일부, 파일 경로 등) */
  detail: string;
  since: number;
};

// 메인 Claude 세션의 현재 컨텍스트 점유 (트랜스크립트 usage 기반). HookBridge가 갱신.
export type ContextUsageState = {
  /** 현재 컨텍스트 토큰 합 (input+cache). */
  totalInputTokens: number;
  /** 분모(컨텍스트 윈도우). */
  contextWindow: number;
  /** 점유율 0~1. */
  ratio: number;
  /** 갱신 시각 (Date.now()). */
  at: number;
};

type AppState = {
  consoleEvents: ConsoleEvent[];
  focusedPanelId: PanelId | null;
  panelActivity: Record<string, PanelActivity>;
  panelCurrentTool: Record<string, PanelCurrentTool>;
  /// 모든 Claude PTY를 일괄 unmount/remount하기 위한 카운터.
  /// MainClaudePanel의 PtyTerminal key prop에 결합되어, 값이 바뀌면 React가 컴포넌트를
  /// 새로 mount → 새 spawn → 새 settings.local.json 로드.
  claudeRestartKey: number;
  // 좌측 메인 Claude PTY의 현재 활성 sessionId (훅 동작에서 텍스트 주입 대상).
  mainClaudeSessionId: string | null;
  // Supervisor 자동 연속 루프 — 사용자 토글(on/off)과 현재 반복(주입) 횟수.
  supervisorActive: boolean;
  supervisorIteration: number;
  // 메인 Claude 세션 컨텍스트 점유 (없으면 null).
  contextUsage: ContextUsageState | null;
  addEvent: (source: string, message: string) => void;
  clearConsole: () => void;
  setSupervisorActive: (active: boolean) => void;
  setSupervisorIteration: (n: number) => void;
  setContextUsage: (u: ContextUsageState | null) => void;
  setFocusedPanel: (id: PanelId | null) => void;
  setMainClaudeSessionId: (id: string | null) => void;
  setPanelActivity: (panelId: string, state: PanelActivityState) => void;
  setPanelCurrentTool: (panelId: string, tool: string, detail: string) => void;
  clearPanelCurrentTool: (panelId: string) => void;
  /** 모든 Claude PTY 일괄 재시작 (settings.local.json 변경 즉시 반영). */
  restartAllClaudes: () => void;
};

function newEvent(source: string, message: string): ConsoleEvent {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    source,
    message,
  };
}

export const useAppStore = create<AppState>((set) => ({
  consoleEvents: [newEvent("SYSTEM", "앱 시작 — Hook 이벤트 대기 중")],
  focusedPanelId: null,
  mainClaudeSessionId: null,
  panelActivity: {},
  panelCurrentTool: {},
  claudeRestartKey: 0,
  supervisorActive: false,
  supervisorIteration: 0,
  contextUsage: null,

  addEvent: (source, message) =>
    set((state) => ({
      consoleEvents: [...state.consoleEvents, newEvent(source, message)],
    })),

  clearConsole: () => set({ consoleEvents: [] }),

  setSupervisorActive: (supervisorActive) => set({ supervisorActive }),

  setSupervisorIteration: (supervisorIteration) => set({ supervisorIteration }),

  setContextUsage: (contextUsage) => set({ contextUsage }),

  setFocusedPanel: (id) => set({ focusedPanelId: id }),

  setMainClaudeSessionId: (id) => set({ mainClaudeSessionId: id }),

  setPanelActivity: (panelId, state) =>
    set((prev) => {
      const cur = prev.panelActivity[panelId];
      // 같은 state 유지 시 since 갱신 X — 초 카운터가 흔들리지 않도록.
      if (cur && cur.state === state) return prev;
      return {
        panelActivity: {
          ...prev.panelActivity,
          [panelId]: { state, since: Date.now() },
        },
      };
    }),

  setPanelCurrentTool: (panelId, tool, detail) =>
    set((prev) => ({
      panelCurrentTool: {
        ...prev.panelCurrentTool,
        [panelId]: { tool, detail, since: Date.now() },
      },
    })),

  clearPanelCurrentTool: (panelId) =>
    set((prev) => {
      if (!prev.panelCurrentTool[panelId]) return prev;
      const next = { ...prev.panelCurrentTool };
      delete next[panelId];
      return { panelCurrentTool: next };
    }),

  restartAllClaudes: () =>
    set((prev) => ({
      claudeRestartKey: prev.claudeRestartKey + 1,
    })),
}));
