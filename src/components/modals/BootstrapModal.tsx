import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { loadConfig } from "@/lib/config";
import {
  buildBootstrapPrompt,
  injectPrompt,
  readProjectText,
} from "@/lib/supervisor";
import { useAppStore } from "@/store/useAppStore";

// 부트스트랩(Phase 0) 모달 — 자율 루프 작업 상태 파일(docs/PROGRESS.md·docs/BUILD_ORDER.md)을
// 생성하는 프롬프트를 1회 주입한다.
//
// 전제(계약): CLAUDE.md가 이미 있어야 한다 — 스택·범위는 거기서 읽는다. 부트스트랩은 CLAUDE.md를
// 만들지 않는다. 그래서 모달은 프로젝트명(자동 채움) + 선택 메모만 받는다.
//
// 안전 원칙:
//   - 루프를 켜지 않는다(주입만 — 검수 후 사람이 ▶를 누른다).
//   - CLAUDE.md가 없으면 주입을 막는다(전제 미충족).
//   - docs/PROGRESS.md가 이미 있으면 덮어쓰기 확인을 받는다.

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// 실행 디렉토리 경로에서 마지막 폴더명을 뽑아 기본 프로젝트명으로 쓴다(Windows \\ / 둘 다 처리).
function folderName(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

export function BootstrapModal({ open, onOpenChange }: Props) {
  const mainSid = useAppStore((s) => s.mainClaudeSessionId);
  const addEvent = useAppStore((s) => s.addEvent);

  const [dir, setDir] = useState("");
  const [projectName, setProjectName] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  // 열릴 때마다 실행 디렉토리를 읽어 프로젝트명을 폴더명으로 자동 채운다.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus(null);
    setNeedsConfirm(false);
    setNote("");
    loadConfig()
      .then((c) => {
        if (cancelled) return;
        const d = c.claude_code_sessions.main.directory.trim();
        setDir(d);
        setProjectName(folderName(d));
      })
      .catch(() => {
        if (!cancelled) {
          setDir("");
          setProjectName("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function handleInject() {
    if (!mainSid) {
      setStatus("메인 Claude 세션이 비활성입니다. 먼저 claude를 실행하세요.");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      // 전제·덮어쓰기 검사는 실행 디렉토리를 알 때만 한다. (홈에서 실행 중이면 건너뛰고,
      // 프롬프트 내부의 "CLAUDE.md 없으면 멈춰라" 지시가 폴백이 된다.)
      if (dir) {
        const claudeMd = await readProjectText(dir, "CLAUDE.md");
        if (claudeMd === null) {
          setStatus(
            "CLAUDE.md가 없습니다 — 부트스트랩은 CLAUDE.md(스택·구조·범위)를 전제로 합니다. 루트에 먼저 두세요.",
          );
          setBusy(false);
          return;
        }
        if (!needsConfirm) {
          const existing = await readProjectText(dir, "docs/PROGRESS.md");
          if (existing !== null) {
            setNeedsConfirm(true);
            setStatus(
              "이미 docs/PROGRESS.md가 있습니다. 부트스트랩은 기존 상태 파일을 덮어쓸 수 있습니다. 그래도 진행하려면 [그래도 주입]을 누르세요.",
            );
            setBusy(false);
            return;
          }
        }
      }

      const prompt = buildBootstrapPrompt({ projectName, note });
      await injectPrompt(mainSid, prompt);
      addEvent(
        "SYSTEM",
        "부트스트랩 프롬프트 주입 — Claude가 docs/PROGRESS.md·docs/BUILD_ORDER.md 생성 후 멈춥니다. 검수 뒤 ▶로 루프를 시작하세요.",
      );
      onOpenChange(false);
    } catch (e) {
      setStatus(`주입 실패 — ${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-accent-gold">새 프로젝트 부트스트랩</DialogTitle>
          <DialogDescription>
            자율 루프가 쓰는 <span className="font-mono">docs/PROGRESS.md</span>,{" "}
            <span className="font-mono">docs/BUILD_ORDER.md</span>를 생성하는 프롬프트를 1회
            주입합니다. 스택·범위는 <span className="font-mono">CLAUDE.md</span>에서 읽으므로 미리
            있어야 합니다. <span className="text-card-foreground">루프는 시작하지 않습니다</span> —
            파일 생성 후 검수하고 ▶를 누르세요.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-1 text-sm">
          <label className="grid gap-1">
            <span className="text-card-foreground">
              프로젝트명 <span className="text-muted-foreground">(PROGRESS.md 제목용 · 폴더명 자동)</span>
            </span>
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="예: 사다바리 LMS"
              className="rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground"
            />
          </label>
          <label className="grid gap-1">
            <span className="text-card-foreground">
              추가 지시 <span className="text-muted-foreground">(선택 · 이번 부트스트랩에만)</span>
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="예: 우선 MVP 범위만, 결제는 나중 Phase로"
              className="resize-y rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground"
            />
          </label>

          {status && <p className="text-xs break-words text-muted-foreground">{status}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            취소
          </Button>
          <Button onClick={() => void handleInject()} disabled={busy}>
            {needsConfirm ? "그래도 주입" : "주입"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
