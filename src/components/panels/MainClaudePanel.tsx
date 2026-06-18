import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Rocket, Settings, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import { PtyTerminal } from "@/components/terminal/PtyTerminal";
import { loadConfig, saveConfig } from "@/lib/config";
import { type SpawnOptions } from "@/lib/pty";
import { useAppStore } from "@/store/useAppStore";
import { ActivityIndicator } from "@/components/monitor/ActivityIndicator";
import { SettingsModal } from "@/components/modals/SettingsModal";
import { BootstrapModal } from "@/components/modals/BootstrapModal";

// 좌측 메인 Claude Code 화면. 설정의 claude_code_sessions.main을 따라 spawn:
//  - directory가 있으면 cwd로 사용 (없으면 백엔드가 home으로 폴백)
//  - auto_start=true → `claude` 실행, false → OS 기본 셸 (사용자가 수동으로 `claude` 입력)
// 설정 변경은 [설정] 저장 후 PTY 재시작(restartAllClaudes) 시 반영.

// key는 PtyTerminal remount 트리거. claudeRestartKey를 바로 key로 쓰지 않고,
// 새 설정 로드가 끝난 뒤에만 갱신해 "옛 spawn으로 먼저 remount되는" race를 막는다.
type Resolved = { spawn: SpawnOptions; key: number; fontSize: number };

export function MainClaudePanel() {
  const { isFocused, onMouseDown } = usePanelFocus("main-claude");
  const setMainClaudeSessionId = useAppStore((s) => s.setMainClaudeSessionId);
  const mainClaudeSessionId = useAppStore((s) => s.mainClaudeSessionId);
  const claudeRestartKey = useAppStore((s) => s.claudeRestartKey);
  const supervisorActive = useAppStore((s) => s.supervisorActive);
  const supervisorIteration = useAppStore((s) => s.supervisorIteration);
  const setSupervisorActive = useAppStore((s) => s.setSupervisorActive);
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bootstrapOpen, setBootstrapOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadConfig()
      .then((c) => {
        if (cancelled) return;
        const sess = c.claude_code_sessions.main;
        // claude 실행 인자 조립 (auto_start일 때만 — OS 셸엔 붙이지 않는다).
        const args: string[] = [];
        if (sess.skip_permissions) args.push("--dangerously-skip-permissions");
        if (sess.chrome) args.push("--chrome");
        const extra = sess.extra_args.trim();
        if (extra) args.push(...extra.split(/\s+/));
        setResolved({
          spawn: {
            command: sess.auto_start ? "claude" : "",
            args: sess.auto_start && args.length > 0 ? args : undefined,
            cwd: sess.directory || undefined,
            // Claude Code 훅이 이 PTY가 메인 패널임을 식별하도록 ENV 주입.
            env: { SIDABARI4LOOP_PANEL_ID: "main-claude" },
          },
          key: claudeRestartKey,
          fontSize: c.ui.terminal_font_size,
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        // 설정 로드 실패 → OS 기본 셸로 폴백 (사용자가 수동 진입 가능하도록)
        setResolved({
          spawn: { command: "", env: { SIDABARI4LOOP_PANEL_ID: "main-claude" } },
          key: claudeRestartKey,
          fontSize: 21,
        });
        console.warn("[MainClaudePanel] config 로드 실패, 기본 셸로 폴백:", message);
      });
    return () => {
      cancelled = true;
    };
    // claudeRestartKey 변경 시 설정을 다시 읽어 새 spawn 옵션 적용.
  }, [claudeRestartKey]);

  // Ctrl+휠 글꼴 크기 변경을 설정에 영속화. 휠이 연달아 발생하므로 debounce(500ms).
  // PTY 재시작(restartAllClaudes)을 트리거하지 않도록 saveConfig만 직접 호출하고,
  // 최신 설정을 다시 읽어 다른 필드를 보존한 채 ui.terminal_font_size만 갱신한다.
  const saveTimerRef = useRef<number | null>(null);
  const handleFontSizeChange = useCallback((size: number) => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      loadConfig()
        .then((c) =>
          saveConfig({ ...c, ui: { ...c.ui, terminal_font_size: size } }),
        )
        .catch(() => {});
    }, 500);
  }, []);

  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    },
    [],
  );

  return (
    <div className="flex h-full flex-col gap-[3px] bg-background" onMouseDown={onMouseDown}>
      <div
        className={cn(
          "mx-0.5 mt-0.5 flex items-center justify-between gap-2 rounded-md px-3 py-0.5 transition-colors",
          isFocused ? "bg-secondary" : "bg-card",
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-card-foreground">
            메인 Claude Code
          </span>
          <ActivityIndicator panelKey="main-claude" />
        </div>
        <div className="flex items-center gap-1.5">
          {supervisorActive && (
            <span className="text-xs font-medium text-accent-gold">
              루프 #{supervisorIteration}
            </span>
          )}
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={supervisorActive || !mainClaudeSessionId}
            onClick={() => setBootstrapOpen(true)}
            title="부트스트랩 — 새 프로젝트 스캐폴드 생성 프롬프트 주입 (루프는 시작하지 않음)"
          >
            <Rocket />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => setSupervisorActive(!supervisorActive)}
            className={
              supervisorActive ? "[&_svg]:text-destructive" : "[&_svg]:text-action-green"
            }
            title={
              supervisorActive
                ? "Supervisor 루프 정지"
                : "Supervisor 루프 시작 (턴 종료 시 자동으로 다음 단계 진행)"
            }
          >
            {supervisorActive ? <Square /> : <Play />}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => setSettingsOpen(true)}
            title="설정"
          >
            <Settings />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 mx-0.5">
        {resolved ? (
          <PtyTerminal
            // key는 새 설정 로드 후에만 올라간다 → 옛 spawn으로 remount되는 race 방지.
            key={resolved.key}
            spawn={resolved.spawn}
            onSessionChange={setMainClaudeSessionId}
            fontSize={resolved.fontSize}
            onFontSizeChange={handleFontSizeChange}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            설정 불러오는 중...
          </div>
        )}
      </div>

      <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
      <BootstrapModal open={bootstrapOpen} onOpenChange={setBootstrapOpen} />
    </div>
  );
}
