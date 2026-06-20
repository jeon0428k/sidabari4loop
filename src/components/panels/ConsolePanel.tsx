import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore, type ConsoleEvent } from "@/store/useAppStore";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import { Button } from "@/components/ui/button";

function formatTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function sourceColor(source: string): string {
  switch (source) {
    case "HOOK":
      return "text-accent-gold";
    case "USER":
      return "text-foreground";
    case "SYSTEM":
      return "text-muted-foreground";
    default:
      return "text-foreground";
  }
}

// 토큰 수를 간결히 (1234 → "1.2k", 72000 → "72k", 1000000 → "1.0M").
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// 점유율에 따른 색: 낮음=흐림, 중간=골드, 높음=빨강.
function usageColor(ratio: number): string {
  if (ratio >= 0.9) return "text-destructive";
  if (ratio >= 0.7) return "text-accent-gold";
  return "text-muted-foreground";
}

function ConsoleLine({ event }: { event: ConsoleEvent }) {
  return (
    <div className="font-mono text-xs leading-normal">
      <span className="text-muted-foreground">[{formatTime(event.timestamp)}]</span>
      <span className={cn("ml-2 font-semibold", sourceColor(event.source))}>
        [{event.source}]
      </span>
      <span className="ml-2 break-words">{event.message}</span>
    </div>
  );
}

/// 하단 패널 타이틀바의 'Hook 콘솔' 탭 우측 액션 — 컨텍스트 점유율 + 콘솔 비우기.
export function ConsoleActions() {
  const clearConsole = useAppStore((s) => s.clearConsole);
  const usage = useAppStore((s) => s.contextUsage);
  const usagePct = usage ? Math.round(usage.ratio * 100) : null;
  return (
    <>
      {usage && usagePct !== null && (
        <span
          className={cn("font-mono text-[11px]", usageColor(usage.ratio))}
          title={`컨텍스트 입력 토큰 ${usage.totalInputTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()}`}
        >
          컨텍스트 {usagePct}% · {fmtTokens(usage.totalInputTokens)}/
          {fmtTokens(usage.contextWindow)}
        </span>
      )}
      <Button size="icon-xs" variant="ghost" onClick={clearConsole} title="콘솔 비우기">
        <Trash2 />
      </Button>
    </>
  );
}

/// 하단 패널 — Hook 콘솔(이벤트 로그). 포커스 단위 "console".
export function ConsolePanel() {
  const { isFocused, onMouseDown } = usePanelFocus("console");
  return (
    <div className="flex h-full flex-col bg-background" onMouseDown={onMouseDown}>
      <div
        className={cn(
          "mx-0.5 mt-0.5 flex items-center justify-between gap-2 rounded-md px-3 py-0.5 transition-colors",
          isFocused ? "bg-secondary" : "bg-card",
        )}
      >
        <span className="text-xs font-semibold text-card-foreground">Hook 콘솔</span>
        <div className="flex items-center gap-2">
          <ConsoleActions />
        </div>
      </div>
      <div className="mx-0.5 min-h-0 flex-1">
        <ConsoleBody />
      </div>
    </div>
  );
}

/// 'Hook 콘솔' 본문 — 이벤트 로그 목록(자동 스크롤).
export function ConsoleBody() {
  const events = useAppStore((s) => s.consoleEvents);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <div ref={scrollRef} className="h-full space-y-0.5 overflow-auto px-3 py-2">
      {events.length === 0 ? (
        <div className="text-xs text-muted-foreground">기록 없음</div>
      ) : (
        events.map((e) => <ConsoleLine key={e.id} event={e} />)
      )}
    </div>
  );
}
