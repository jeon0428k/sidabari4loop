// docs/BUILD_ORDER.md 파서 — 진행 목록(전체 단계 + 완료 여부)을 결정론적으로 추출한다.
//
// 계약(SIDABARI4LOOP_CONTRACT.md §2): BUILD_ORDER.md는 Phase 헤딩 아래에 체크박스 목록으로
// 단계를 적고, 구동 Claude가 끝낸 단계를 '- [ ]' → '- [x]'로 갱신한다. 그래서 완료 여부를
// 자유 형식 추측 없이 체크박스로만 판정한다(TASK_COMPLETE/OPEN 마커를 정규식으로 검출하는 것과 동일 철학).

export type BuildStep = { text: string; done: boolean };
export type BuildPhase = { title: string; steps: BuildStep[] };
export type BuildOrder = {
  /// 문서 제목(첫 H1). 없으면 null.
  title: string | null;
  phases: BuildPhase[];
  totalSteps: number;
  doneSteps: number;
  /// 평탄화한 전체 단계에서 '첫 미완료' 단계의 인덱스. 모두 완료/단계 없음이면 -1.
  currentIndex: number;
};

const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
// 체크박스 항목: 불릿(- 또는 *) + [ ]/[x]/[X] + 설명. 들여쓰기 허용.
const CHECKBOX_RE = /^\s*[-*]\s*\[([ xX])\]\s+(.*\S)\s*$/;

/// BUILD_ORDER.md 텍스트를 파싱한다. 어떤 입력이든 throw하지 않고 최선의 구조를 반환한다.
export function parseBuildOrder(text: string): BuildOrder {
  const lines = text.split(/\r?\n/);
  let title: string | null = null;
  const phases: BuildPhase[] = [];
  let current: BuildPhase | null = null;

  const ensurePhase = (): BuildPhase => {
    if (!current) {
      // 헤딩 없이 먼저 나온 체크박스를 담을 기본 그룹.
      current = { title: "", steps: [] };
      phases.push(current);
    }
    return current;
  };

  for (const line of lines) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = heading[2].trim();
      if (level === 1 && title === null) {
        // 첫 H1은 문서 제목으로 쓰고 Phase로 만들지 않는다.
        title = content;
      } else {
        current = { title: content, steps: [] };
        phases.push(current);
      }
      continue;
    }
    const check = CHECKBOX_RE.exec(line);
    if (check) {
      const done = check[1] === "x" || check[1] === "X";
      ensurePhase().steps.push({ text: check[2].trim(), done });
    }
  }

  let totalSteps = 0;
  let doneSteps = 0;
  let currentIndex = -1;
  let flatIndex = 0;
  for (const phase of phases) {
    for (const step of phase.steps) {
      totalSteps += 1;
      if (step.done) doneSteps += 1;
      else if (currentIndex === -1) currentIndex = flatIndex;
      flatIndex += 1;
    }
  }

  return { title, phases, totalSteps, doneSteps, currentIndex };
}
