import { Group, Panel, useDefaultLayout } from "react-resizable-panels";
import { MainClaudePanel } from "@/components/panels/MainClaudePanel";
import { ConsolePanel } from "@/components/panels/ConsolePanel";
import { ProgressPanel } from "@/components/panels/ProgressPanel";
import { ResizeHandle } from "./ResizeHandle";

// 레이아웃:
//   좌측 — 진행 네비게이션(docs/BUILD_ORDER.md, 전체 높이 사이드바)
//   우측 — 세로 분할: 상단 메인 Claude Code PTY / 하단 Hook 콘솔
// useDefaultLayout: localStorage에 분할 비율 저장/복원. 가로(app-cols)·세로(app-rows) 각각 보존.
const STORAGE: Storage | undefined =
  typeof window !== "undefined" ? window.localStorage : undefined;

export function MainLayout() {
  const cols = useDefaultLayout({ id: "app-cols", storage: STORAGE });
  const rows = useDefaultLayout({ id: "app-rows", storage: STORAGE });

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="min-h-0 flex-1 p-[3px]">
        <Group
          orientation="horizontal"
          defaultLayout={cols.defaultLayout}
          onLayoutChanged={cols.onLayoutChanged}
          style={{ height: "100%" }}
        >
          <Panel id="progress" defaultSize="18%" minSize="10%">
            <ProgressPanel />
          </Panel>
          <ResizeHandle />
          <Panel id="right-col" minSize="40%">
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
          </Panel>
        </Group>
      </div>
    </div>
  );
}
