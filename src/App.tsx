import "./App.css";
import { MainLayout } from "@/components/layout/MainLayout";
import { GateModal } from "@/components/modals/GateModal";
import { HookBridge } from "@/components/monitor/HookBridge";
import { SupervisorController } from "@/components/monitor/SupervisorController";

function App() {
  return (
    <>
      <MainLayout />
      <GateModal />
      <HookBridge />
      <SupervisorController />
    </>
  );
}

export default App;
