import { CheckCircle2, Circle, CircleDot, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import { useBuildProgress, type BuildProgressState } from "@/hooks/useBuildProgress";
import { Button } from "@/components/ui/button";
import type { BuildOrder } from "@/lib/buildOrder";

// '진행' 탭 본문 — docs/BUILD_ORDER.md의 체크박스를 Phase별 목록으로 보여주고,
// 완료(✓)·현재(●)·대기(○)를 표시한다. 상단에 완료/전체·퍼센트 요약 바.

function Summary({ order }: { order: BuildOrder }) {
  const { doneSteps, totalSteps } = order;
  const pct = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;
  return (
    <div className="sticky top-0 z-10 bg-background pb-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold text-card-foreground">
          완료 {doneSteps} / 전체 {totalSteps}
        </span>
        <span className="font-mono text-muted-foreground">{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-card">
        <div
          className="h-full rounded-full bg-action-green transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function StepRow({
  text,
  done,
  current,
}: {
  text: string;
  done: boolean;
  current: boolean;
}) {
  const Icon = done ? CheckCircle2 : current ? CircleDot : Circle;
  const iconColor = done
    ? "text-action-green"
    : current
      ? "text-accent-gold"
      : "text-muted-foreground";
  const textColor = done
    ? "text-muted-foreground line-through"
    : current
      ? "text-foreground font-medium"
      : "text-card-foreground";
  return (
    <div className="flex items-start gap-2 py-0.5 pl-1">
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", iconColor)} />
      <span className={cn("text-xs leading-snug break-words", textColor)}>{text}</span>
    </div>
  );
}

// 좌측 네비게이션 패널 — docs/BUILD_ORDER.md 진행 목록. 포커스 단위 "progress".
export function ProgressPanel() {
  const { isFocused, onMouseDown } = usePanelFocus("progress");
  const progress = useBuildProgress();
  return (
    <div className="flex h-full flex-col bg-background" onMouseDown={onMouseDown}>
      <div
        className={cn(
          "mx-0.5 mt-0.5 flex items-center justify-between gap-2 rounded-md px-3 py-0.5 transition-colors",
          isFocused ? "bg-secondary" : "bg-card",
        )}
      >
        <span className="text-xs font-semibold text-card-foreground">진행</span>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={progress.reload}
          title="진행 목록 새로고침 (docs/BUILD_ORDER.md 다시 읽기)"
        >
          <RefreshCw />
        </Button>
      </div>
      <div className="mx-0.5 min-h-0 flex-1">
        <ProgressBody state={progress} />
      </div>
    </div>
  );
}

export function ProgressBody({ state }: { state: BuildProgressState }) {
  const { order, error, loading } = state;

  if (error) {
    return (
      <div className="h-full overflow-auto px-3 py-2 text-xs text-muted-foreground">
        {error}
      </div>
    );
  }
  if (!order) {
    return (
      <div className="h-full overflow-auto px-3 py-2 text-xs text-muted-foreground">
        {loading ? "불러오는 중..." : "기록 없음"}
      </div>
    );
  }
  if (order.totalSteps === 0) {
    return (
      <div className="h-full overflow-auto px-3 py-2 text-xs text-muted-foreground">
        단계 없음 — docs/BUILD_ORDER.md에 "- [ ] 단계" 형식의 체크박스를 추가하세요.
      </div>
    );
  }

  // 평탄화 인덱스로 currentIndex(첫 미완료)와 대조해 '현재' 단계를 강조한다.
  let flat = -1;
  return (
    <div className="h-full overflow-auto px-3 py-2">
      <Summary order={order} />
      <div className="space-y-2">
        {order.phases.map((phase, pi) => (
          <div key={pi}>
            {phase.title && (
              <div className="mb-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {phase.title}
              </div>
            )}
            {phase.steps.map((step, si) => {
              flat += 1;
              return (
                <StepRow
                  key={si}
                  text={step.text}
                  done={step.done}
                  current={flat === order.currentIndex}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
