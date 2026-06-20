import { describe, it, expect } from "vitest";
import { parseBuildOrder } from "./buildOrder";

describe("parseBuildOrder", () => {
  it("Phase 헤딩과 체크박스를 그룹·단계로 파싱한다", () => {
    const text = `# HR — 작업 정의 (BUILD_ORDER)

## Phase 1 — 기반
- [x] FND-010 인증/RBAC 골격
- [x] FND-020 DB 마이그레이션 셋업
- [ ] FND-030 공통 에러 핸들러

## Phase 2 — 휴가
- [ ] AP-042 휴가일수 계산
`;
    const r = parseBuildOrder(text);
    expect(r.title).toBe("HR — 작업 정의 (BUILD_ORDER)");
    expect(r.phases).toHaveLength(2);
    expect(r.phases[0].title).toBe("Phase 1 — 기반");
    expect(r.phases[0].steps).toHaveLength(3);
    expect(r.phases[1].steps).toHaveLength(1);
    expect(r.totalSteps).toBe(4);
    expect(r.doneSteps).toBe(2);
    // 첫 미완료 = FND-030 (평탄화 인덱스 2)
    expect(r.currentIndex).toBe(2);
  });

  it("대문자 [X]도 완료로 인식한다", () => {
    const r = parseBuildOrder("## P\n- [X] 끝난 것\n- [ ] 남은 것\n");
    expect(r.doneSteps).toBe(1);
    expect(r.phases[0].steps[0].done).toBe(true);
    expect(r.phases[0].steps[1].done).toBe(false);
  });

  it("'*' 불릿과 들여쓰기도 허용한다", () => {
    const r = parseBuildOrder("## P\n  * [x] 들여쓴 별표 항목\n");
    expect(r.totalSteps).toBe(1);
    expect(r.doneSteps).toBe(1);
  });

  it("헤딩 없이 먼저 나온 체크박스는 기본 그룹에 담는다", () => {
    const r = parseBuildOrder("- [ ] 헤딩 전 항목\n");
    expect(r.phases).toHaveLength(1);
    expect(r.phases[0].title).toBe("");
    expect(r.totalSteps).toBe(1);
  });

  it("모두 완료면 currentIndex는 -1", () => {
    const r = parseBuildOrder("## P\n- [x] a\n- [x] b\n");
    expect(r.doneSteps).toBe(2);
    expect(r.currentIndex).toBe(-1);
  });

  it("단계가 없으면 총 0, currentIndex -1", () => {
    const r = parseBuildOrder("# 제목\n## Phase 1\n설명 문장만 있고 체크박스 없음\n");
    expect(r.totalSteps).toBe(0);
    expect(r.currentIndex).toBe(-1);
    expect(r.phases).toHaveLength(1); // Phase 1 헤딩은 빈 그룹으로 남음
  });

  it("빈 입력도 throw하지 않는다", () => {
    const r = parseBuildOrder("");
    expect(r.title).toBeNull();
    expect(r.phases).toHaveLength(0);
    expect(r.totalSteps).toBe(0);
    expect(r.currentIndex).toBe(-1);
  });

  it("체크박스가 아닌 일반 불릿은 단계로 세지 않는다", () => {
    const r = parseBuildOrder("## P\n- 그냥 메모(체크박스 아님)\n- [ ] 진짜 단계\n");
    expect(r.totalSteps).toBe(1);
  });
});
