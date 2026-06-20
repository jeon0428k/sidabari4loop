import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import "@xterm/xterm/css/xterm.css";
import { TERMINAL_THEME } from "./Terminal";
import { Button } from "@/components/ui/button";
import {
  listenPtyData,
  listenPtyExit,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
  type SpawnOptions,
} from "@/lib/pty";

type Props = {
  spawn: SpawnOptions;
  onExit?: (code: number | null) => void;
  // 활성 PTY 세션 ID 변경 알림 — 폴백 셸 전환/재시작/언마운트 시 호출.
  // 외부(store 등)가 ptyWrite 대상으로 사용 (사양서 §3.6 분석 요청 텍스트 주입).
  onSessionChange?: (sessionId: string | null) => void;
  // 최초 spawn 시 지연 (ms). 여러 PtyTerminal이 한 frame에 mount될 때 시차를 주어
  // claude CLI의 lock 파일/credentials race를 회피한다 (재시작 시 메인+추가 탭 동시 spawn 케이스).
  spawnDelayMs?: number;
  // xterm scrollback 줄 수. 미지정 시 10000 (cmd.exe `cls` 등 일반 셸 사용 가정).
  // Claude Code 같은 alt-screen 미사용 Ink TUI는 partial redraw로 viewport 초과분이
  // scrollback에 자연스럽게 누적돼 시작 직후부터 scrollbar가 보이는 부작용이 있다.
  // 그런 패널엔 0을 넘겨 scrollback을 비활성화한다 (사용자가 옛 frame을 위로 스크롤해 볼 수 없게 됨).
  scrollback?: number;
  // 초기 글꼴 크기(px). 미지정 시 21. Ctrl+휠 조정의 시작값.
  fontSize?: number;
  // Ctrl+휠로 글꼴 크기가 바뀔 때 호출 — 설정 저장용(상위가 영속화).
  onFontSizeChange?: (size: number) => void;
};

type Status = "starting" | "running" | "exited-fallback" | "stopped" | "error";

// Ctrl+C: 선택 영역 있으면 클립보드 복사(차단), 없으면 \x03 → PTY (사양서 §3.7).
// Ctrl+V: 클립보드 → term.paste()로 paste 경로(브래킷 페이스트 모드 존중) 발화.
//   xterm 기본은 Ctrl+V를 raw \x16(SYN)으로 PTY에 보냄 — paste가 아님. Ctrl+Shift+V는 브라우저
//   paste 이벤트가 발화되어 xterm 내부 paste 경로를 타므로 작동. Ctrl+V도 같은 경로로 라우팅한다.
// Ctrl+A: 전체 선택 (readline의 \x01이 PTY로 가지 않게 차단).
//
// Shift+Enter: 개행(줄바꿈) — xterm 기본은 \r(=Enter, 제출)이라 가로채 Meta+Enter(\x1b\r)를 보낸다.
//   Claude Code 는 Meta+Enter 를 "줄바꿈 삽입"으로 처리한다.
// Home / End (및 Cmd+←/→): 줄 맨 앞/뒤로 커서 이동.
//   윈도우 키보드의 Home/End 는 macOS 에서 Cmd+←/→ 로 들어오는 경우가 많고(관찰함), Cmd+←/→ 는
//   macOS 의 줄 맨앞/맨뒤 관례이기도 하다. 실제 Home/End 키와 Cmd+←/→ 를 모두 받아 커서키 시퀀스를
//   보낸다(애플리케이션 커서키 모드면 \x1bOH/\x1bOF, 아니면 \x1b[H/\x1b[F).
//
// onImeKeydown: 모든 keydown에서 가장 먼저 호출된다. IME 처리 키(keyCode 229)면 true 를 반환해
//   xterm 의 keydown 처리를 건너뛴다(조합 안 된 자모를 keydown 경로로 PTY에 보내지 않게). 이 훅이
//   xterm 의 _keyDown 안에서(=xterm 이 무언가 emit 하기 전에) 실행되므로 IME 상태 플래그가 항상
//   제때 설정된다 — 단어 첫 자모가 새던 타이밍 버그를 막는다.
function attachKeyShortcuts(
  term: XTerminal,
  onImeKeydown: (e: KeyboardEvent) => boolean,
  sendPty: (data: string) => void,
) {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if (onImeKeydown(e)) return false;

    // Shift+Enter → 개행. Claude Code 는 Ctrl+J(\x0a) 를 "줄바꿈 삽입"(chat:newline)으로 처리한다.
    //   주의: return false 로 xterm keydown 을 막아도, 브라우저 기본동작이 헬퍼 textarea 에 줄바꿈을
    //   넣어 input 이벤트 → xterm 이 \r 을 또 보낸다(= 제출). 그래서 preventDefault 로 기본동작까지 막고
    //   Ctrl+J 만 보낸다.
    if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      sendPty("\n");
      return false;
    }
    // Home / End — 실제 키 또는 Cmd+←/→ (윈도우 키보드 리매핑 대응). 다른 보조키 조합은 제외.
    const cmdOnly = e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    const isHome = e.key === "Home" || (e.key === "ArrowLeft" && cmdOnly);
    const isEnd = e.key === "End" || (e.key === "ArrowRight" && cmdOnly);
    if (isHome || isEnd) {
      const app = term.modes.applicationCursorKeysMode;
      sendPty(isHome ? (app ? "\x1bOH" : "\x1b[H") : app ? "\x1bOF" : "\x1b[F");
      return false;
    }

    const mod = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
    if (!mod) return true;
    if (e.key === "c") {
      const selection = term.getSelection();
      if (selection && selection.length > 0) {
        writeText(selection).catch(() => {});
        return false;
      }
      return true;
    }
    if (e.key === "v") {
      readText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch(() => {});
      return false;
    }
    if (e.key === "a") {
      term.selectAll();
      return false;
    }
    return true;
  });
}

export function PtyTerminal({
  spawn,
  onExit,
  onSessionChange,
  spawnDelayMs,
  scrollback,
  fontSize,
  onFontSizeChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unlistenDataRef = useRef<(() => void) | null>(null);
  const unlistenExitRef = useRef<(() => void) | null>(null);
  // primary: props.spawn 명령. fallback: claude 등 종료 후 OS 기본 셸. final: 더 이상 자동 폴백 없음.
  const phaseRef = useRef<"primary" | "fallback" | "final">("primary");
  const disposedRef = useRef(false);
  // prop을 ref로 wrap — useCallback/useEffect deps 흔들지 않으면서 최신 prop 호출.
  const onSessionChangeRef = useRef(onSessionChange);
  onSessionChangeRef.current = onSessionChange;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onFontSizeChangeRef = useRef(onFontSizeChange);
  onFontSizeChangeRef.current = onFontSizeChange;

  const [status, setStatus] = useState<Status>("starting");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function notifySession(id: string | null) {
    sessionIdRef.current = id;
    onSessionChangeRef.current?.(id);
  }

  // 사양서 §1.3 / §5.1 — 자동 재시도는 금지지만 명령 종료 후 셸 폴백은 다른 영역(다음 작업을 위한 환경 유지).
  // 셸도 종료되면 [다시 시작] 버튼으로 사용자 명시 액션 요구.
  const startPty = useCallback(
    async (opts: SpawnOptions, isFallback = false) => {
      const term = termRef.current;
      if (!term || disposedRef.current) return;

      // 이전 listen 해제 (재spawn 시 중복 방지)
      unlistenDataRef.current?.();
      unlistenExitRef.current?.();
      unlistenDataRef.current = null;
      unlistenExitRef.current = null;
      notifySession(null);
      setStatus("starting");

      const preId = crypto.randomUUID();

      try {
        unlistenDataRef.current = await listenPtyData(preId, (chunk) => {
          // cmd.exe `cls`는 \x1b[2J\x1b[H만 보내 xterm scrollback이 남음.
          // \x1b[3J(saved-lines erase)을 주입해 buffer를 깨끗이.
          //
          // 단 alt-screen TUI(claude 등)는 진입 시 \x1b[?1049h\x1b[2J\x1b[H 패턴을 함께 발사.
          // 이때 무조건 \x1b[3J을 주입하면 main buffer의 scrollback도 비워져 사용자가 위로 스크롤할 때
          // 화면이 깨져 보임. 그래서 alt-screen 활성/진입 chunk에서는 보강을 생략.
          const hasClear = chunk.indexOf("\x1b[2J") >= 0;
          const enteringAlt =
            chunk.indexOf("\x1b[?1049h") >= 0 || chunk.indexOf("\x1b[?47h") >= 0;
          const inAlt = term.buffer.active.type === "alternate";
          const shouldAugment = hasClear && !enteringAlt && !inAlt;
          const augmented = shouldAugment
            ? chunk.replace(/\x1b\[2J/g, "\x1b[2J\x1b[3J")
            : chunk;
          term.write(augmented, () => {
            if (shouldAugment) {
              term.refresh(0, term.rows - 1);
            }
          });
        });
        unlistenExitRef.current = await listenPtyExit(preId, (code) => {
          handleExit(code);
        });

        if (disposedRef.current) {
          unlistenDataRef.current?.();
          unlistenExitRef.current?.();
          return;
        }

        const id = await ptySpawn({
          ...opts,
          session_id: preId,
          rows: term.rows,
          cols: term.cols,
        });
        if (disposedRef.current) {
          await ptyKill(id).catch(() => {});
          return;
        }
        notifySession(id);
        setStatus("running");
        if (isFallback) {
          term.writeln(`\x1b[90m[기본 셸로 전환]\x1b[0m`);
        }
      } catch (e) {
        if (disposedRef.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        setStatus("error");
        setErrorMsg(msg);
        term.writeln(`\x1b[31m[pty 시작 실패: ${msg}]\x1b[0m`);
        phaseRef.current = "final";
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function handleExit(code: number | null) {
    const term = termRef.current;
    onExitRef.current?.(code);

    notifySession(null);
    if (!term || disposedRef.current) return;

    term.writeln("");
    term.writeln(`\x1b[90m[프로세스 종료, exit code = ${code ?? "?"}]\x1b[0m`);

    // 폴백 정책: primary가 명시 명령(claude 등)이었으면 OS 기본 셸로 전환.
    // primary가 처음부터 OS 셸이었거나 이미 fallback 단계면 더 자동 spawn 안 함.
    const phase = phaseRef.current;
    const primaryWasShell = !spawn.command || spawn.command.trim() === "";
    if (phase === "primary" && !primaryWasShell) {
      phaseRef.current = "fallback";
      setStatus("exited-fallback");
      void startPty({ command: "", cwd: spawn.cwd }, true);
    } else {
      phaseRef.current = "final";
      setStatus("stopped");
    }
  }

  function handleRestart() {
    if (disposedRef.current) return;
    phaseRef.current = "primary";
    setErrorMsg(null);
    void startPty(spawn);
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    disposedRef.current = false;

    const term = new XTerminal({
      theme: TERMINAL_THEME,
      // Win11 우선 — Cascadia Mono(터미널 기본)를 첫 자리에. App.css `--font-mono`와 동일.
      fontFamily:
        '"Cascadia Mono", "Cascadia Code", ui-monospace, Consolas, "SF Mono", Menlo, "Liberation Mono", monospace',
      fontSize: fontSize ?? 21,
      fontWeight: "300",
      fontWeightBold: "500",
      lineHeight: 1.0,
      cursorBlink: true,
      cursorStyle: "block",
      convertEol: false,
      scrollback: scrollback ?? 10000,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    const unicode11 = new Unicode11Addon();
    term.loadAddon(fit);
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";
    term.open(container);

    try {
      fit.fit();
    } catch {
      // 컨테이너 크기 미정인 경우 무시
    }

    // --- 한글/CJK IME 처리 (macOS WKWebView) ---
    // WKWebView는 한글 입력 시 compositionstart/update/end 이벤트를 발생시키지 않고,
    // Input Events L2의 `input` 이벤트(inputType="insertReplacementText")로 조합 텍스트를 준다
    // (ㅎ→하→한). xterm 6은 이 경로를 처리하지 못해 조합 안 된 호환 자모(U+314E 등)를 PTY로 보낸다.
    // 그래서 textarea의 input 이벤트를 직접 읽어 "미확정(marked) 텍스트 교체" 모델을 PTY 바이트로
    // 번역한다: 이전 미확정만큼 백스페이스(\x7f) 후 새 텍스트 전송. xterm이 보내는 자모는 onData에서
    // 버린다. (조합 이벤트가 정상 발생하는 환경에서는 keyCode!==229라 이 경로가 동작하지 않아 무해.)
    let imeActive = false; // 직전 keydown이 IME 처리(keyCode 229)였는가
    let imeMarked = ""; // 현재 PTY에 보낸 미확정(조합 중) 텍스트
    const cpLen = (s: string) => [...s].length; // 코드포인트 수(백스페이스 횟수)

    // IME keydown 플래그는 반드시 xterm 의 keydown 처리보다 먼저 설정돼야 한다(단어 첫 자모 누수 방지).
    // attachCustomKeyEventHandler 안에서 처리한다.
    attachKeyShortcuts(term, (e) => {
      if (e.keyCode === 229) {
        imeActive = true;
        return true; // IME 키 — xterm 이 keydown 경로로 자모를 보내지 않게 건너뛴다
      }
      // 일반 키(스페이스·엔터·백스페이스 등)는 조합을 확정한다. xterm 이 그대로 처리.
      // imeMarked 는 여기서 비우지 않는다 — 내비게이션/엔터 키는 keydown 직후 IME 가 미확정 텍스트를
      // "확정"하며 같은 텍스트로 insertReplacementText 를 한 번 더 보낸다. 그때 imeMarked 가 남아 있어야
      // "이전만큼 백스페이스 + 재전송" = 무변화(no-op) 가 되어 음절이 중복되지 않는다.
      imeActive = false;
      return false;
    }, (data) => {
      const id = sessionIdRef.current;
      if (id) ptyWrite(id, data).catch(() => {});
    });

    // 비ASCII(코드포인트 > 0x7F) 포함 여부 — IME/조합 입력 판별에 쓴다(일반 ASCII 타이핑 제외).
    const hasNonAscii = (s: string) => [...s].some((c) => c.codePointAt(0)! > 0x7f);
    // IME(조합) 입력 판별: 조합 교체, 비ASCII 삽입, 또는 조합 중 백스페이스.
    const isImeInput = (inputType: string, data: string) =>
      inputType === "insertReplacementText" ||
      inputType === "insertCompositionText" ||
      inputType === "insertFromComposition" ||
      (inputType === "insertText" && hasNonAscii(data)) ||
      (inputType === "deleteContentBackward" && imeMarked.length > 0);

    const ta = term.textarea;
    if (ta) {
      // 첫 자모 누수 방지의 핵심:
      // WKWebView 는 첫 자모에서 (검증함) beforeinput → xterm onData(자모) → input 순으로 발생시킨다.
      // 즉 xterm 이 input 보다 먼저 onData 로 자모를 흘린다. 그래서 그보다 더 앞서는 beforeinput(capture)
      // 에서 imeActive 를 켜둔다 → 뒤이은 xterm onData 가 확실히 드롭된다. 실제 전송은 input 에서 한다.
      ta.addEventListener(
        "beforeinput",
        (e) => {
          const ie = e as InputEvent;
          if (isImeInput(ie.inputType, ie.data ?? "")) imeActive = true;
        },
        true,
      );
      ta.addEventListener(
        "input",
        (e) => {
          const ie = e as InputEvent;
          const data = ie.data ?? "";
          // 일반 ASCII 입력·붙여넣기는 xterm 에 맡긴다.
          if (!imeActive && !isImeInput(ie.inputType, data)) return;

          imeActive = true; // 방어적 재확인
          const isReplace =
            ie.inputType === "insertReplacementText" ||
            ie.inputType === "insertCompositionText" ||
            ie.inputType === "insertFromComposition";
          const id = sessionIdRef.current;
          let send: string;
          if (ie.inputType === "deleteContentBackward") {
            // 조합 중 백스페이스: 미확정만큼 지운다.
            send = "\x7f".repeat(cpLen(imeMarked));
            imeMarked = "";
          } else if (isReplace) {
            // 조합 중 음절 교체: 이전 미확정만큼 지우고 새 음절 전송.
            send = "\x7f".repeat(cpLen(imeMarked)) + data;
            imeMarked = data;
          } else {
            // insertText (새 음절의 첫 자모). 이전 음절은 확정(지우지 않음)하고 새로 시작.
            send = data;
            imeMarked = data;
          }
          if (id && send) ptyWrite(id, send).catch(() => {});
        },
        true,
      );
    }

    // onData listener는 한 번만 등록. sessionId 변경은 ref로.
    term.onData((data) => {
      // IME 활성 중 xterm이 보내는 (조합 안 된) 자모는 버린다 — 위 input 핸들러가 올바른 바이트를 보냄.
      // "비ASCII만" 버린다: 제어문자(\r 엔터, \x7f 백스페이스, \x03 등)와 ESC 시퀀스는 IME 중에도
      // 통과시켜야 한다(엔터가 IME 잔여 활성 상태에서 삼켜지지 않도록).
      if (imeActive && hasNonAscii(data)) return;
      const id = sessionIdRef.current;
      if (id) ptyWrite(id, data).catch(() => {});
    });

    termRef.current = term;
    fitRef.current = fit;

    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      const id = sessionIdRef.current;
      if (id) {
        ptyResize(id, term.rows, term.cols).catch(() => {});
      }
    });
    resizeObserver.observe(container);

    // Ctrl + 마우스 휠로 터미널 글꼴 크기 ±1 조정 (밀면 +, 당기면 -).
    // capture 단계에서 가로채 xterm 기본 스크롤·웹뷰 줌을 막는다(passive:false라 preventDefault 가능).
    const handleWheelZoom = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      const cur = term.options.fontSize ?? 21;
      const next = e.deltaY < 0 ? cur + 1 : cur - 1;
      const clamped = Math.min(48, Math.max(8, next));
      if (clamped === cur) return;
      term.options.fontSize = clamped;
      try {
        fit.fit();
      } catch {
        // 컨테이너 크기 미정인 경우 무시
      }
      const id = sessionIdRef.current;
      if (id) ptyResize(id, term.rows, term.cols).catch(() => {});
      onFontSizeChangeRef.current?.(clamped);
    };
    container.addEventListener("wheel", handleWheelZoom, {
      passive: false,
      capture: true,
    });

    // 첫 spawn — primary. spawnDelayMs가 있으면 시차 후 spawn (claude race 회피).
    phaseRef.current = "primary";
    let initTimer: number | null = null;
    const delay = spawnDelayMs ?? 0;
    if (delay > 0) {
      initTimer = window.setTimeout(() => {
        if (!disposedRef.current) void startPty(spawn);
      }, delay);
    } else {
      void startPty(spawn);
    }

    return () => {
      disposedRef.current = true;
      if (initTimer !== null) window.clearTimeout(initTimer);
      container.removeEventListener("wheel", handleWheelZoom, true);
      resizeObserver.disconnect();
      unlistenDataRef.current?.();
      unlistenExitRef.current?.();
      if (sessionIdRef.current) {
        ptyKill(sessionIdRef.current).catch(() => {});
      }
      notifySession(null);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showRestart = status === "stopped" || status === "error";

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={containerRef} className="h-full w-full" />
      {showRestart && (
        <div className="absolute right-2 top-2 flex items-center gap-2 rounded-md bg-card/90 px-2 py-1 ring-1 ring-foreground/10 backdrop-blur-sm">
          {status === "error" && errorMsg && (
            <span className="text-xs text-destructive">PTY 오류: {errorMsg}</span>
          )}
          {status === "stopped" && (
            <span className="text-xs text-muted-foreground">세션 종료</span>
          )}
          <Button size="xs" variant="outline" onClick={handleRestart}>
            다시 시작
          </Button>
        </div>
      )}
    </div>
  );
}
