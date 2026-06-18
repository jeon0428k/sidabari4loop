import { useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  type Config,
  type ContextResetMode,
} from "@/lib/config";
import { installClaudeHooks } from "@/lib/claudeHooks";
import { DEFAULT_OPERATING_PROMPT } from "@/lib/supervisor";
import { useAppStore } from "@/store/useAppStore";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// 설정 대화상자. 카테고리별 탭:
//  - 실행: 메인 Claude 실행 디렉토리(cwd)/자동 실행/실행 인자
//  - 훅·로그: verbose 로그·위험 도구 게이트 토글, [훅 설치]
//  - Supervisor: 운영 프롬프트·컨텍스트 리셋·임계치·윈도우·최대 반복
export function SettingsModal({ open, onOpenChange }: Props) {
  const restartAllClaudes = useAppStore((s) => s.restartAllClaudes);
  const addEvent = useAppStore((s) => s.addEvent);

  const [directory, setDirectory] = useState("");
  const [autoStart, setAutoStart] = useState(false);
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [chrome, setChrome] = useState(false);
  const [extraArgs, setExtraArgs] = useState("");
  const [verbose, setVerbose] = useState(false);
  const [gate, setGate] = useState(false);
  const [operatingPrompt, setOperatingPrompt] = useState("");
  const [maxIterations, setMaxIterations] = useState(500);
  const [contextReset, setContextReset] = useState<ContextResetMode>("compact");
  const [compactThreshold, setCompactThreshold] = useState(50);
  const [contextWindow, setContextWindow] = useState(1_000_000);
  const [configPath, setConfigPath] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 터미널 글꼴 크기는 이 모달에서 편집하지 않는다(Ctrl+휠 전용). 로드값을 보존해 저장 시 그대로 기록.
  const fontSizeRef = useRef(21);

  // 열릴 때마다 현재 설정을 다시 읽어 폼 초기화.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus(null);
    loadConfig()
      .then((c) => {
        if (cancelled) return;
        setDirectory(c.claude_code_sessions.main.directory);
        setAutoStart(c.claude_code_sessions.main.auto_start);
        setSkipPermissions(c.claude_code_sessions.main.skip_permissions);
        setChrome(c.claude_code_sessions.main.chrome);
        setExtraArgs(c.claude_code_sessions.main.extra_args);
        setVerbose(c.ui.verbose_hook_logs);
        setGate(c.ui.gate_dangerous_tools);
        fontSizeRef.current = c.ui.terminal_font_size;
        setOperatingPrompt(c.supervisor.operating_prompt);
        setMaxIterations(c.supervisor.max_iterations);
        setContextReset(c.supervisor.context_reset);
        setCompactThreshold(c.supervisor.compact_threshold_pct);
        setContextWindow(c.supervisor.context_window_tokens);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStatus(`설정 로드 실패: ${e instanceof Error ? e.message : String(e)}`);
      });
    getConfigPath()
      .then((p) => {
        if (!cancelled) setConfigPath(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function pickDirectory() {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") setDirectory(picked);
    } catch (e) {
      setStatus(`폴더 선택 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function buildConfig(): Config {
    return {
      schema_version: 1,
      claude_code_sessions: {
        main: {
          directory: directory.trim(),
          auto_start: autoStart,
          skip_permissions: skipPermissions,
          chrome: chrome,
          extra_args: extraArgs.trim(),
        },
      },
      ui: {
        verbose_hook_logs: verbose,
        gate_dangerous_tools: gate,
        terminal_font_size: fontSizeRef.current,
      },
      supervisor: {
        operating_prompt: operatingPrompt,
        max_iterations: Math.max(1, Math.floor(maxIterations) || 1),
        context_reset: contextReset,
        compact_threshold_pct: Math.min(100, Math.max(0, Math.floor(compactThreshold) || 0)),
        context_window_tokens: Math.max(1, Math.floor(contextWindow) || 1),
      },
    };
  }

  // 코드에 내장된 기본 운영 프롬프트(현재 계약 기준)를 입력란에 채운다.
  function loadDefaultPrompt() {
    setOperatingPrompt(DEFAULT_OPERATING_PROMPT);
    setStatus("기본 운영 프롬프트를 불러왔습니다 — [저장] 해야 적용됩니다.");
  }

  async function handleSave() {
    setBusy(true);
    setStatus(null);
    try {
      await saveConfig(buildConfig());
      // 저장 즉시 반영: PTY 일괄 재시작 (새 cwd/auto_start/ENV 적용).
      restartAllClaudes();
      addEvent("SYSTEM", "설정 저장 — Claude PTY 재시작");
      onOpenChange(false);
    } catch (e) {
      setStatus(`저장 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleInstallHooks() {
    const dir = directory.trim();
    if (!dir) {
      setStatus("훅 설치 실패 — 실행 디렉토리를 먼저 지정하세요.");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      // 게이트 토글 상태를 그대로 settings.local.json에 반영.
      const report = await installClaudeHooks(dir, gate);
      const where = report.created ? "새로 생성" : "기존 파일 갱신";
      const backup = report.backed_up_path ? " (백업 생성됨)" : "";
      setStatus(
        `훅 설치 완료 — ${where}: ${report.installed_path}${backup}. 등록: ${report.events_added.join(", ")}`,
      );
      addEvent("SYSTEM", `훅 설치: ${report.installed_path}`);
    } catch (e) {
      setStatus(`훅 설치 실패 — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // 탭 본문 공통 클래스 — 좌측 세로 탭 옆에서 남은 폭을 채우고(flex-1 min-w-0),
  // 짧으면 스크롤 없음, 아주 작은 창에서만 세로 스크롤(가로는 항상 숨김).
  const tabBody =
    "min-w-0 flex-1 grid content-start min-h-[18rem] max-h-[68vh] gap-3 overflow-x-hidden overflow-y-auto py-1 pr-1 pl-1 text-sm";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-accent-gold">설정</DialogTitle>
          <DialogDescription>
            메인 Claude Code 실행 설정과 훅 동작을 구성합니다. 저장 시 PTY가 재시작되어 즉시
            반영됩니다.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="run" orientation="vertical" className="flex-row gap-4">
          <TabsList className="h-auto w-40 shrink-0 flex-col items-stretch justify-start gap-1">
            <TabsTrigger value="run" className="w-full flex-none justify-start">
              실행
            </TabsTrigger>
            <TabsTrigger value="hooks" className="w-full flex-none justify-start">
              훅 · 로그
            </TabsTrigger>
            <TabsTrigger value="loop" className="w-full flex-none justify-start">
              Supervisor 루프
            </TabsTrigger>
          </TabsList>

          {/* ── 실행 ───────────────────────────── */}
          <TabsContent value="run" className={tabBody}>
            {/* 실행 디렉토리 */}
            <div className="grid gap-1.5">
              <label className="text-card-foreground">실행 디렉토리 (cwd)</label>
              <div className="flex items-center gap-2">
                <input
                  value={directory}
                  onChange={(e) => setDirectory(e.target.value)}
                  placeholder="비우면 사용자 홈에서 실행"
                  className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground"
                />
                <Button size="sm" variant="ghost" onClick={pickDirectory} title="폴더 선택">
                  <FolderOpen /> 찾기
                </Button>
              </div>
            </div>

            {/* claude 자동 실행 */}
            <label className="flex items-center gap-2 text-card-foreground">
              <input
                type="checkbox"
                checked={autoStart}
                onChange={(e) => setAutoStart(e.target.checked)}
              />
              <span>
                시작 시 <span className="font-mono">claude</span> 자동 실행
                <span className="text-muted-foreground"> (끄면 OS 기본 셸)</span>
              </span>
            </label>

            {/* claude 실행 인자 */}
            <div className="ml-6 grid gap-2 border-l border-foreground/15 pl-3">
              <label className="flex items-center gap-2 text-card-foreground">
                <input
                  type="checkbox"
                  checked={skipPermissions}
                  onChange={(e) => setSkipPermissions(e.target.checked)}
                  disabled={!autoStart}
                />
                <span>
                  <span className="font-mono">--dangerously-skip-permissions</span>
                  <span className="text-destructive"> (권한 프롬프트 없이 실행 · 위험)</span>
                </span>
              </label>
              <label className="flex items-center gap-2 text-card-foreground">
                <input
                  type="checkbox"
                  checked={chrome}
                  onChange={(e) => setChrome(e.target.checked)}
                  disabled={!autoStart}
                />
                <span className="font-mono">--chrome</span>
              </label>
              <div className="grid gap-1">
                <label className="text-card-foreground">추가 인자 (공백 구분)</label>
                <input
                  value={extraArgs}
                  onChange={(e) => setExtraArgs(e.target.value)}
                  disabled={!autoStart}
                  placeholder="예: --model opus"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs placeholder:text-muted-foreground disabled:opacity-50"
                />
              </div>
            </div>
          </TabsContent>

          {/* ── 훅 · 로그 ──────────────────────── */}
          <TabsContent value="hooks" className={tabBody}>
            <label className="flex items-center gap-2 text-card-foreground">
              <input
                type="checkbox"
                checked={verbose}
                onChange={(e) => setVerbose(e.target.checked)}
              />
              <span>
                훅 이벤트 verbose 로그
                <span className="text-muted-foreground"> (PreToolUse/PostToolUse 등 상세)</span>
              </span>
            </label>

            <label className="flex items-center gap-2 text-card-foreground">
              <input
                type="checkbox"
                checked={gate}
                onChange={(e) => setGate(e.target.checked)}
              />
              <span>
                위험 도구 게이트
                <span className="text-muted-foreground"> (Bash 호출 시 허용/거부 모달)</span>
              </span>
            </label>

            <div className="h-px bg-foreground/20" />

            {/* 훅 설치 */}
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-card-foreground">Claude Code 훅</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleInstallHooks}
                  disabled={busy}
                  title="실행 디렉토리의 .claude/settings.local.json에 훅 등록"
                >
                  훅 설치
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                실행 디렉토리의 <span className="font-mono">.claude/settings.local.json</span>에
                훅을 등록해 SessionStart/Stop/PreToolUse 등의 이벤트를 이 앱이 수신합니다.
              </p>
            </div>
          </TabsContent>

          {/* ── Supervisor 루프 ───────────────── */}
          <TabsContent value="loop" className={tabBody}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-card-foreground">운영 프롬프트</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={loadDefaultPrompt}
                disabled={busy}
                title="현재 계약 기준 기본 운영 프롬프트를 입력란에 불러옵니다 (현재 내용을 덮어씁니다)"
              >
                기본값 불러오기
              </Button>
            </div>
            <textarea
              value={operatingPrompt}
              onChange={(e) => setOperatingPrompt(e.target.value)}
              rows={10}
              placeholder="턴 종료 시 컨텍스트 리셋 후 매번 재주입할 운영 프롬프트"
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs placeholder:text-muted-foreground"
            />

            <label className="flex flex-wrap items-center gap-2 text-card-foreground">
              <span>컨텍스트 리셋</span>
              <select
                value={contextReset}
                onChange={(e) => setContextReset(e.target.value as ContextResetMode)}
                className="rounded-md border border-input bg-background px-2 py-1 text-sm"
              >
                <option value="compact">/compact — 요약 압축 (컨텍스트 보존)</option>
                <option value="clear">/clear — 비움 (새 세션)</option>
                <option value="none">none — 리셋 없이 재주입 (auto-compact가 관리)</option>
              </select>
            </label>

            <label className="flex flex-wrap items-center gap-2 text-card-foreground">
              <span>compact 임계치</span>
              <input
                type="number"
                min={0}
                max={100}
                value={compactThreshold}
                onChange={(e) => setCompactThreshold(Number(e.target.value))}
                disabled={contextReset !== "compact"}
                className="w-20 rounded-md border border-input bg-background px-2 py-1 text-sm disabled:opacity-50"
              />
              <span className="text-muted-foreground">
                % 이상일 때만 /compact (미만이면 압축 생략·재주입)
              </span>
            </label>

            <label className="flex flex-wrap items-center gap-2 text-card-foreground">
              <span>컨텍스트 윈도우</span>
              <input
                type="number"
                min={1}
                step={1000}
                value={contextWindow}
                onChange={(e) => setContextWindow(Number(e.target.value))}
                className="w-28 rounded-md border border-input bg-background px-2 py-1 text-sm"
              />
              <span className="text-muted-foreground">
                토큰 (점유율 분모 — 표준 200000, 1M 컨텍스트 1000000)
              </span>
            </label>

            <label className="flex flex-wrap items-center gap-2 text-card-foreground">
              <span>최대 반복</span>
              <input
                type="number"
                min={1}
                value={maxIterations}
                onChange={(e) => setMaxIterations(Number(e.target.value))}
                className="w-24 rounded-md border border-input bg-background px-2 py-1 text-sm"
              />
              <span className="text-muted-foreground">회 (무한 루프 방지 상한)</span>
            </label>

            <p className="text-xs text-muted-foreground">
              메인 패널 타이틀바의 ▶ 버튼으로 루프를 시작합니다. 턴 종료(Stop) 시
              <span className="font-mono"> docs/PROGRESS.md</span>를 읽어{" "}
              <span className="font-mono">TASK_COMPLETE</span>/<span className="font-mono">HALT:</span>면
              정지, 아니면 위에서 고른 방식(<span className="font-mono">/compact</span>,{" "}
              <span className="font-mono">/clear</span>, <span className="font-mono">none</span>)으로 처리한 뒤 위 프롬프트를 재주입합니다.
              compact 모드는 컨텍스트 점유가 위 임계치 이상일 때만 압축하고, 미만이면 압축을 건너뛰고
              같은 컨텍스트로 바로 다음 턴을 이어갑니다(점유율은 Hook 콘솔 타이틀바에 표시).
              none 모드는 리셋 없이 프롬프트만 재주입하며, 컨텍스트는 Claude Code의 auto-compact가 관리합니다.
            </p>
          </TabsContent>
        </Tabs>

        {/* 공통 피드백 — 어느 탭에서나 보이도록 탭 밖에 둔다 */}
        {status && (
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background p-2 text-xs text-card-foreground">
            {status}
          </pre>
        )}

        {configPath && (
          <p className="text-xs break-all text-muted-foreground">
            설정 파일: <span className="font-mono">{configPath}</span>
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            취소
          </Button>
          <Button onClick={handleSave} disabled={busy}>
            저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
