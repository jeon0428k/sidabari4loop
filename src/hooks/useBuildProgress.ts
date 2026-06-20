import { useCallback, useEffect, useRef, useState } from "react";
import { loadConfig } from "@/lib/config";
import { readProjectText } from "@/lib/supervisor";
import { parseBuildOrder, type BuildOrder } from "@/lib/buildOrder";
import { listenHookEvent, type HookEventEmit } from "@/lib/hooks";
import { useAppStore } from "@/store/useAppStore";

// 진행 목록 데이터 소스 — docs/BUILD_ORDER.md를 읽어 체크박스로 진행 상태를 파싱한다.
// 갱신 시점: 마운트 + 설정 변경(claudeRestartKey) + 매 턴 종료(Stop, main-claude) + 수동 새로고침.
const BUILD_ORDER_REL = "docs/BUILD_ORDER.md";
const PANEL_ID = "main-claude";

export type BuildProgressState = {
  order: BuildOrder | null;
  // null이면 정상. 그 외엔 표시할 사유("없음"/읽기 실패 등).
  error: string | null;
  loading: boolean;
  reload: () => void;
};

export function useBuildProgress(): BuildProgressState {
  const claudeRestartKey = useAppStore((s) => s.claudeRestartKey);
  const [order, setOrder] = useState<BuildOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // 설정에서 읽은 실행 디렉토리 캐시. 설정 변경 시 ""로 비워 재조회한다.
  const dirRef = useRef<string>("");
  // 경쟁 방지 — 가장 최신 reload 요청만 상태에 반영.
  const reqRef = useRef(0);

  const reload = useCallback(async () => {
    const myReq = ++reqRef.current;
    setLoading(true);
    try {
      let dir = dirRef.current;
      if (!dir) {
        const c = await loadConfig();
        dir = c.claude_code_sessions.main.directory.trim();
        dirRef.current = dir;
      }
      if (!dir) {
        if (myReq === reqRef.current) {
          setOrder(null);
          setError("실행 디렉토리 미설정 (설정 → 실행 디렉토리)");
        }
        return;
      }
      const text = await readProjectText(dir, BUILD_ORDER_REL);
      if (myReq !== reqRef.current) return; // 더 최신 요청이 진행 중
      if (text === null) {
        setOrder(null);
        setError("docs/BUILD_ORDER.md 없음 — 부트스트랩(🚀)으로 먼저 생성하세요");
      } else {
        setOrder(parseBuildOrder(text));
        setError(null);
      }
    } catch (e) {
      if (myReq === reqRef.current) {
        setOrder(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (myReq === reqRef.current) setLoading(false);
    }
  }, []);

  // 마운트 + 설정 변경 시: 디렉토리 캐시를 비우고 다시 읽는다.
  useEffect(() => {
    dirRef.current = "";
    void reload();
  }, [claudeRestartKey, reload]);

  // 매 턴 종료(Stop) 시 자동 새로고침 — 구동 Claude가 BUILD_ORDER 체크박스를 갱신했을 수 있다.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listenHookEvent((e: HookEventEmit) => {
      if (e.kind !== "stop") return;
      if (e.payload._sidabari4loop?.panel_id !== PANEL_ID) return;
      void reload();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [reload]);

  return { order, error, loading, reload: () => void reload() };
}
