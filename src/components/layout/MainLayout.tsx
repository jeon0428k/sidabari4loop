import { Group, Panel, useDefaultLayout } from "react-resizable-panels";
import { MainClaudePanel } from "@/components/panels/MainClaudePanel";
import { ConsolePanel } from "@/components/panels/ConsolePanel";
import { ResizeHandle } from "./ResizeHandle";

// 수직 분할 레이아웃:
//   상단 — 메인 Claude Code PTY
//   하단 — Hook 콘솔 (HookBridge가 기록한 이벤트 로그)
// useDefaultLayout: localStorage에 분할 비율 저장/복원 — 재시작 시 사용자 분할 유지.
const STORAGE: Storage | undefined =
  typeof window !== "undefined" ? window.localStorage : undefined;

export function MainLayout() {
  const rows = useDefaultLayout({ id: "app-rows", storage: STORAGE });

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="min-h-0 flex-1 p-[3px]">
        <Group
          orientation="vertical"
          defaultLayout={rows.defaultLayout}
          onLayoutChanged={rows.onLayoutChanged}
          style={{ height: "100%" }}
        >
          <Panel id="main-claude" defaultSize="70%" minSize="30%">
            <MainClaudePanel />
          </Panel>
          <ResizeHandle />
          <Panel id="console" defaultSize="30%" minSize="12%">
            <ConsolePanel />
          </Panel>
        </Group>
      </div>
    </div>
  );
}
