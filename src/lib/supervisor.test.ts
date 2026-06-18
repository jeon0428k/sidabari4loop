import { describe, expect, it } from "vitest";
import { evaluateLoopSignal } from "./supervisor";

// evaluateLoopSignal은 자율 루프의 안전 게이트다(계약 §1.1). false negative(미해결/HALT를
// 못 잡음)는 "완료 오판·정지" 또는 "멈춰야 하는데 계속함"으로 이어져 위험하므로,
// 위험 방향으로 잘 안 틀리는지 다양한 입력으로 고정한다.

describe("evaluateLoopSignal — 완료(TASK_COMPLETE)", () => {
  it("TASK_COMPLETE가 있고 미해결(OPEN) 줄이 없으면 complete", () => {
    expect(evaluateLoopSignal("작업 끝\n상태: TASK_COMPLETE").decision).toBe("complete");
  });

  it("구 마커 EXPERIMENT_COMPLETE는 더 이상 complete로 인식하지 않는다(LMS 잔재 제거)", () => {
    expect(evaluateLoopSignal("EXPERIMENT_COMPLETE").decision).toBe("continue");
  });
});

describe("evaluateLoopSignal — 미해결(OPEN) 게이트가 완료를 차단", () => {
  it("OPEN: 줄이 있으면 TASK_COMPLETE가 있어도 continue", () => {
    expect(evaluateLoopSignal("TASK_COMPLETE\nOPEN: 로그인 검증 미구현").decision).toBe(
      "continue",
    );
  });

  it("OPEN[01]: (ID 포함)도 차단", () => {
    expect(evaluateLoopSignal("TASK_COMPLETE\nOPEN[01]: 결제 테스트 부재").decision).toBe(
      "continue",
    );
  });

  it("- OPEN: (불릿)·들여쓰기도 차단 (관대 매칭)", () => {
    expect(evaluateLoopSignal("TASK_COMPLETE\n  - OPEN: 토큰 갱신 누락").decision).toBe(
      "continue",
    );
  });

  it("임의 길이 ID OPEN[1]: 도 차단", () => {
    expect(evaluateLoopSignal("TASK_COMPLETE\nOPEN[1]: 한자리 ID").decision).toBe("continue");
  });

  it("콜론 없는 ## OPEN ISSUES 헤딩은 미해결로 보지 않는다(알려진 한계 — 문서화)", () => {
    // 미해결을 헤딩/산문으로만 두면 차단되지 않음. 미해결은 반드시 OPEN: 줄로 적어야 한다.
    expect(evaluateLoopSignal("TASK_COMPLETE\n## OPEN ISSUES").decision).toBe("complete");
  });

  it("소문자 open: 이나 줄 중간의 open: 은 미해결로 보지 않는다", () => {
    expect(evaluateLoopSignal("TASK_COMPLETE\n이건 open: 아님").decision).toBe("complete");
  });
});

describe("evaluateLoopSignal — 정지(HALT)", () => {
  it("HALT: 줄이 있으면 halt, reason에 해당 줄을 담는다", () => {
    const r = evaluateLoopSignal("진행 중\nHALT: 외부 API 키 없음");
    expect(r.decision).toBe("halt");
    expect(r.reason).toBe("HALT: 외부 API 키 없음");
  });

  it("- HALT: (불릿)도 halt", () => {
    expect(evaluateLoopSignal("- HALT: 빌드 깨짐").decision).toBe("halt");
  });

  it("콜론 없는 ## HALT 는 정지로 보지 않는다", () => {
    expect(evaluateLoopSignal("## HALT").decision).toBe("continue");
  });

  it("TASK_COMPLETE(미해결 없음)와 HALT가 함께 있으면 complete가 우선", () => {
    // 완료 판정이 먼저 평가된다. 둘 다 종료 신호이므로 어느 쪽이든 루프는 멈춘다.
    expect(evaluateLoopSignal("TASK_COMPLETE\nHALT: 어쩌구").decision).toBe("complete");
  });
});

describe("evaluateLoopSignal — 계속(continue)", () => {
  it("아무 마커도 없으면 continue", () => {
    expect(evaluateLoopSignal("# 진행 상태\n## 다음 할 일\n- 첫 단계").decision).toBe(
      "continue",
    );
  });

  it("빈 문자열도 continue", () => {
    expect(evaluateLoopSignal("").decision).toBe("continue");
  });

  it("CRLF 줄바꿈도 정상 처리한다", () => {
    expect(evaluateLoopSignal("TASK_COMPLETE\r\nOPEN: 남음").decision).toBe("continue");
  });
});
