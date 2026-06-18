import { useEffect, useRef } from "react";
import { listenHookEvent, type HookEventEmit } from "@/lib/hooks";
import { useAppStore } from "@/store/useAppStore";
import { loadConfig } from "@/lib/config";
import {
  contextUsagePct,
  evaluateLoopSignal,
  getContextUsage,
  injectClear,
  injectCompact,
  injectPrompt,
  readProjectText,
} from "@/lib/supervisor";

type ResetMode = "clear" | "compact" | "none";

// Supervisor 자동 연속 루프 (사양서 §3.5).
//
// 상태기계 (ref로 관리 — 한 번 등록한 listener가 최신 값을 읽도록):
//   running   : 메인 패널 Claude가 한 턴 작업 중. Stop을 기다린다.
//   resetting : 컨텍스트 리셋(/clear 또는 /compact) 주입 후 SessionStart를 기다린다.
//               clear → source=clear, compact → source=compact 발화를 신호로 본다.
//
// 흐름:
//   [시작] 운영 프롬프트 첫 주입 (#1) → running
//   Stop(main-claude) && running
//     → docs/PROGRESS.md 읽어 정지조건 판정
//        complete/halt/최대반복 → 루프 정지(사유 로깅)
//        continue → iteration++ → 컨텍스트 리셋 주입 → resetting
//   SessionStart(source=clear|compact, main-claude) && resetting
//     → 운영 프롬프트 재주입 → running
//
// 안전장치: 같은 Stop 중복 처리 방지(handlingRef + state 가드), 최대 반복 상한,
//   리셋 후 SessionStart 무응답 timeout, 세션 비활성 시 정지.

const PANEL_ID = "main-claude";
// /clear: 슬래시 명령이 가끔 즉시 실패(flaky)하므로 짧은 간격으로 재주입 재시도.
const CLEAR_RETRY_MS = 8000;
const CLEAR_MAX_ATTEMPTS = 3;
// /compact: LLM 요약이라 오래 걸리고, 컨텍스트가 누적되며 반복마다 더 느려진다(수 분 관측).
//   진행 중 재주입은 압축을 방해할 뿐 의미가 없으므로 재시도하지 않고 "기다린다".
//   이 한도를 넘으면 압축 지연/중단으로 보고 사람이 결정하도록 정지(자동 재시도 X, CLAUDE.md §1.3).
const COMPACT_WAIT_MS = 1_800_000; // 30분 (대기 한도 — 정상 압축은 훨씬 빨리 끝남)
// Claude가 작업 없이 입력만 기다리며 멈추면(Notification notification_type="idle_prompt") 스톨로 본다.
//   운영 프롬프트를 재주입해 자동 복구를 시도하고, 연속 이 횟수만큼 넛지해도 (완료 턴 없이)
//   계속 멈추면 루프 정지. 정상 Stop(턴 완료)이 오면 카운터를 리셋한다.
const STALL_NOTIFICATION_TYPE = "idle_prompt";
const MAX_STALL_NUDGES = 2;

export function SupervisorController() {
  const active = useAppStore((s) => s.supervisorActive);
  const mainSid = useAppStore((s) => s.mainClaudeSessionId);
  const setActive = useAppStore((s) => s.setSupervisorActive);
  const setIteration = useAppStore((s) => s.setSupervisorIteration);
  const addEvent = useAppStore((s) => s.addEvent);

  // 최신 값을 listener가 읽도록 ref 미러.
  const activeRef = useRef(active);
  activeRef.current = active;
  const sidRef = useRef<string | null>(mainSid);
  sidRef.current = mainSid;

  const stateRef = useRef<"running" | "resetting">("running");
  const iterRef = useRef(0);
  const handlingRef = useRef(false);
  const stallNudgesRef = useRef(0);
  const resetTimerRef = useRef<number | null>(null);
  const resetAttemptsRef = useRef(0);
  const cfgRef = useRef<{
    prompt: string;
    maxIter: number;
    directory: string;
    resetMode: ResetMode;
    compactThreshold: number;
    contextWindow: number;
  } | null>(null);

  function clearResetTimeout() {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }

  // 루프 정지 — setActive(false)가 아래 active effect의 cleanup도 트리거한다.
  function stopLoop(reason: string) {
    addEvent("SYSTEM", `supervisor: 루프 정지 — ${reason}`);
    clearResetTimeout();
    stateRef.current = "running";
    handlingRef.current = false;
    resetAttemptsRef.current = 0;
    stallNudgesRef.current = 0;
    setActive(false);
  }

  // 컨텍스트 리셋 1회 주입 + 응답(SessionStart) 대기 타이머 무장.
  //  - clear  : 응답 없으면 짧은 간격으로 재주입 재시도(flaky 대비).
  //  - compact: 압축은 장기 작업 — 재주입하지 않고 길게 기다린다. 한도 초과 시 정지.
  async function attemptReset() {
    const sid = sidRef.current;
    const cfg = cfgRef.current;
    if (!sid || !cfg) {
      stopLoop("메인 Claude 세션 비활성 또는 내부 상태 손실");
      return;
    }
    const mode = cfg.resetMode;
    resetAttemptsRef.current += 1;
    try {
      if (mode === "compact") {
        addEvent(
          "SYSTEM",
          `supervisor: /compact 주입 — 압축 완료 대기 (최대 ${Math.round(COMPACT_WAIT_MS / 60000)}분, 재주입 안 함)`,
        );
        await injectCompact(sid);
      } else {
        addEvent(
          "SYSTEM",
          `supervisor: /clear 주입 (시도 ${resetAttemptsRef.current}/${CLEAR_MAX_ATTEMPTS})`,
        );
        await injectClear(sid);
      }
    } catch (e) {
      const cmd = mode === "compact" ? "/compact" : "/clear";
      stopLoop(`${cmd} 주입 실패 (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    armResetTimeout(mode);
  }

  function armResetTimeout(mode: ResetMode) {
    clearResetTimeout();
    const ms = mode === "compact" ? COMPACT_WAIT_MS : CLEAR_RETRY_MS;
    resetTimerRef.current = window.setTimeout(() => {
      if (!activeRef.current || stateRef.current !== "resetting") return;
      if (mode === "compact") {
        // 압축 중 재주입은 방해만 되므로 재시도하지 않고 정지(사람이 결정).
        stopLoop(
          `/compact 후 ${Math.round(COMPACT_WAIT_MS / 60000)}분 내 SessionStart(compact) 없음 — 압축 지연/중단 의심`,
        );
      } else if (resetAttemptsRef.current < CLEAR_MAX_ATTEMPTS) {
        addEvent("SYSTEM", "supervisor: /clear 응답 없음 — 재시도");
        void attemptReset();
      } else {
        stopLoop(`/clear 후 SessionStart(clear) 응답 없음 (${CLEAR_MAX_ATTEMPTS}회 시도)`);
      }
    }, ms);
  }

  async function startLoop() {
    let cfg;
    try {
      cfg = await loadConfig();
    } catch (e) {
      stopLoop(`설정 로드 실패 (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    const prompt = cfg.supervisor.operating_prompt.trim();
    const directory = cfg.claude_code_sessions.main.directory.trim();
    const maxIter = cfg.supervisor.max_iterations;
    const resetMode = cfg.supervisor.context_reset;
    const compactThreshold = cfg.supervisor.compact_threshold_pct;
    const contextWindow = cfg.supervisor.context_window_tokens;
    if (!prompt) {
      stopLoop("운영 프롬프트 미설정 (설정 → Supervisor 루프)");
      return;
    }
    if (!directory) {
      stopLoop("실행 디렉토리 미설정 (설정 → 실행 디렉토리)");
      return;
    }
    const sid = sidRef.current;
    if (!sid) {
      stopLoop("메인 Claude 세션 비활성");
      return;
    }

    // Preflight — 준비 안 된 채 시작 방지 (계약 §7.1). 도구가 기계적으로 확인 가능한 항목만.
    //   · docs/PROGRESS.md 존재 (없으면 첫 턴 종료 즉시 정지하므로 미리 막는다)
    //   · 이미 종료 상태(TASK_COMPLETE/HALT)가 아님 (시작 즉시 정지 방지)
    let progress: string | null;
    try {
      progress = await readProjectText(directory, "docs/PROGRESS.md");
    } catch (e) {
      stopLoop(`preflight: docs/PROGRESS.md 읽기 실패 (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    if (progress === null) {
      stopLoop("preflight: docs/PROGRESS.md 없음 — 부트스트랩으로 먼저 생성하세요");
      return;
    }
    const initSignal = evaluateLoopSignal(progress);
    if (initSignal.decision === "complete") {
      stopLoop("preflight: docs/PROGRESS.md에 이미 TASK_COMPLETE(미해결 없음) — 시작 거부");
      return;
    }
    if (initSignal.decision === "halt") {
      stopLoop(`preflight: docs/PROGRESS.md에 이미 HALT — ${initSignal.reason} — 시작 거부`);
      return;
    }

    cfgRef.current = {
      prompt,
      maxIter,
      directory,
      resetMode,
      compactThreshold,
      contextWindow,
    };
    stateRef.current = "running";
    handlingRef.current = false;
    stallNudgesRef.current = 0;
    iterRef.current = 1;
    setIteration(1);
    // 낡은 운영 프롬프트 경고(차단은 안 함) — 옛 명칭은 현재 계약과 어긋나 루프가 멈추거나
    // 영영 완료되지 않을 수 있다. PROGRESS.md/TASK_COMPLETE로 맞출 것을 알린다.
    if (/MEMORY\.md|EXPERIMENT_COMPLETE/.test(prompt)) {
      addEvent(
        "SYSTEM",
        "경고: 운영 프롬프트에 옛 명칭(MEMORY.md/EXPERIMENT_COMPLETE)이 있습니다 — 현재 계약은 docs/PROGRESS.md · TASK_COMPLETE입니다. 불일치로 루프가 멈추거나 완료되지 않을 수 있어요.",
      );
    }
    addEvent("SYSTEM", "supervisor: 루프 시작 — 운영 프롬프트 주입 (#1)");
    try {
      await injectPrompt(sid, prompt);
    } catch (e) {
      stopLoop(`프롬프트 주입 실패 (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  async function onStop(transcriptPath?: string) {
    if (handlingRef.current) return; // 같은 Stop 중복 처리 방지
    handlingRef.current = true;
    // 턴이 정상적으로 끝났다 = 멈춤에서 회복됨 → 스톨 넛지 카운터 리셋.
    stallNudgesRef.current = 0;
    try {
      const cfg = cfgRef.current;
      if (!cfg) {
        stopLoop("내부 상태 손실 (설정 ref 없음)");
        return;
      }
      let mem: string | null;
      try {
        mem = await readProjectText(cfg.directory, "docs/PROGRESS.md");
      } catch (e) {
        stopLoop(`docs/PROGRESS.md 읽기 실패 (${e instanceof Error ? e.message : String(e)})`);
        return;
      }
      if (mem === null) {
        // 흔한 실패: Claude가 상태 파일을 docs/MEMORY.md 등 다른 이름으로 바꿔 만든 경우.
        // 조용히 "없음"으로 끝내지 말고 원인·해결을 알려준다.
        let hint = "";
        try {
          const legacy = await readProjectText(cfg.directory, "docs/MEMORY.md");
          if (legacy !== null) {
            hint =
              " — docs/MEMORY.md가 대신 있습니다(Claude가 파일명을 바꾼 듯). 운영 프롬프트·CLAUDE.md를" +
              " docs/PROGRESS.md로 통일하고, 그 파일을 docs/PROGRESS.md로 되돌린 뒤 다시 시작하세요.";
          }
        } catch {
          // 힌트는 부가정보일 뿐 — 실패해도 무시.
        }
        stopLoop(`docs/PROGRESS.md 없음${hint}`);
        return;
      }

      const { decision, reason } = evaluateLoopSignal(mem);
      if (decision === "complete") {
        stopLoop(`완료 감지 — ${reason}`);
        return;
      }
      if (decision === "halt") {
        stopLoop(`HALT 감지 — ${reason}`);
        return;
      }

      const next = iterRef.current + 1;
      if (next > cfg.maxIter) {
        stopLoop(`최대 반복(${cfg.maxIter}) 도달`);
        return;
      }
      const sid = sidRef.current;
      if (!sid) {
        stopLoop("메인 Claude 세션 비활성");
        return;
      }
      iterRef.current = next;
      setIteration(next);

      // none 모드: 컨텍스트 리셋(/clear·/compact)을 전혀 하지 않고 운영 프롬프트만 재주입한다.
      // 턴이 끝나므로 Claude Code의 auto-compact가 경계에서 컨텍스트를 관리한다(가장 가벼움).
      if (cfg.resetMode === "none") {
        addEvent("SYSTEM", `supervisor: 계속 — 리셋 없이 프롬프트만 재주입 (#${next})`);
        try {
          await injectPrompt(sid, cfg.prompt);
        } catch (e) {
          stopLoop(`프롬프트 재주입 실패 (${e instanceof Error ? e.message : String(e)})`);
        }
        return;
      }

      // compact 모드: 컨텍스트 점유가 임계치 미만이면 압축을 생략하고
      // 같은 컨텍스트로 다음 턴을 바로 이어간다(불필요한 느린 압축 회피).
      // 측정 불가(transcript 없음/파싱 실패)면 보수적으로 압축한다.
      if (cfg.resetMode === "compact") {
        let pct: number | null = null;
        if (transcriptPath) {
          try {
            pct = contextUsagePct(
              await getContextUsage(transcriptPath, cfg.contextWindow),
            );
          } catch {
            pct = null;
          }
        }
        if (pct !== null && pct < cfg.compactThreshold) {
          addEvent(
            "SYSTEM",
            `supervisor: 계속 — 컨텍스트 ${pct}% < 임계 ${cfg.compactThreshold}%, 압축 생략·재주입 (#${next})`,
          );
          try {
            await injectPrompt(sid, cfg.prompt);
          } catch (e) {
            stopLoop(`프롬프트 재주입 실패 (${e instanceof Error ? e.message : String(e)})`);
          }
          return;
        }
        const pctLabel = pct !== null ? `${pct}%` : "측정불가";
        addEvent(
          "SYSTEM",
          `supervisor: 계속 — 컨텍스트 ${pctLabel} ≥ 임계 ${cfg.compactThreshold}%, 압축 (#${next})`,
        );
      } else {
        addEvent("SYSTEM", `supervisor: 계속 — 새 세션 준비 (#${next})`);
      }

      stateRef.current = "resetting";
      resetAttemptsRef.current = 0;
      await attemptReset();
    } finally {
      handlingRef.current = false;
    }
  }

  // Claude가 작업 없이 입력만 기다리며 멈춤(idle_prompt) → 운영 프롬프트 재주입으로 복구 시도.
  // 연속 MAX_STALL_NUDGES회 넛지해도 (완료 턴 없이) 계속 멈추면 정지.
  async function onStall() {
    if (handlingRef.current) return; // Stop 처리 중이면 그쪽이 재주입하므로 무시.
    const cfg = cfgRef.current;
    const sid = sidRef.current;
    if (!cfg || !sid) {
      stopLoop("멈춤 감지했으나 내부 상태 손실 또는 세션 비활성");
      return;
    }
    if (stallNudgesRef.current >= MAX_STALL_NUDGES) {
      stopLoop(`Claude 멈춤(idle) 지속 — ${MAX_STALL_NUDGES}회 넛지 후에도 미복구`);
      return;
    }
    stallNudgesRef.current += 1;
    addEvent(
      "SYSTEM",
      `supervisor: Claude 멈춤 감지(idle) — 운영 프롬프트 재주입 넛지 (${stallNudgesRef.current}/${MAX_STALL_NUDGES})`,
    );
    try {
      await injectPrompt(sid, cfg.prompt);
    } catch (e) {
      stopLoop(`넛지 재주입 실패 (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  async function onResetReady() {
    clearResetTimeout();
    const cfg = cfgRef.current;
    const sid = sidRef.current;
    if (!cfg || !sid) {
      stopLoop("내부 상태 손실 또는 세션 비활성");
      return;
    }
    stateRef.current = "running";
    const label = cfg.resetMode === "compact" ? "압축 완료" : "새 세션 준비됨";
    addEvent("SYSTEM", `supervisor: ${label} — 운영 프롬프트 재주입 (#${iterRef.current})`);
    try {
      await injectPrompt(sid, cfg.prompt);
    } catch (e) {
      stopLoop(`프롬프트 재주입 실패 (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // 훅 이벤트 listener — 한 번만 등록. 최신 상태는 ref로 읽는다.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    listenHookEvent((e: HookEventEmit) => {
      if (!activeRef.current) return;
      const { kind, payload } = e;
      if (payload._sidabari4loop?.panel_id !== PANEL_ID) return;
      if (kind === "stop" && stateRef.current === "running") {
        void onStop(payload.transcript_path);
      } else if (kind === "session-start" && stateRef.current === "resetting") {
        // 모드별 기대 source: clear → "clear", compact → "compact".
        const expected = cfgRef.current?.resetMode === "compact" ? "compact" : "clear";
        if (payload.source === expected) {
          void onResetReady();
        }
      } else if (
        kind === "notification" &&
        stateRef.current === "running" &&
        payload.notification_type === STALL_NOTIFICATION_TYPE
      ) {
        // 작업해야 할 상태(running)에서 Claude가 입력 대기로 멈춤 = 스톨.
        void onStall();
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => console.warn("[SupervisorController] listen 실패:", err));

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 토글 변화에 반응: on → 루프 시작, off → 타이머/상태 정리.
  useEffect(() => {
    if (active) {
      void startLoop();
    } else {
      clearResetTimeout();
      stateRef.current = "running";
      handlingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return null;
}
