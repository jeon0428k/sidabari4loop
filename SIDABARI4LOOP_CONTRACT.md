# Sidabari4Loop 운영 계약 (SIDABARI4LOOP_CONTRACT.md)

> **이 문서는 동결된 계약이다.** Sidabari4Loop이 자율 루프로 운전하는 **모든 프로젝트**는
> 여기 정의된 기계적 규약을 그대로 따라야 한다. 프로젝트마다 바꾸는 것은 *내용물*뿐이며,
> 아래 경로·마커·훅 규약은 프로젝트별로 재협상하지 않는다(일반화의 핵심 — drift 방지).
>
> 모든 규약은 추측이 아니라 **실제 코드에서 검증된 동작**이다. 각 항목에 근거 파일·줄을 남긴다.
> 계약을 바꾸려면 이 문서와 해당 코드를 같은 변경에 포함한다.

---

## 0. 두 층 — 불변 계약 vs 내용물

| 층 | 성격 | 누가 정하나 | 예 |
|---|---|---|---|
| **기계적 계약** | Sidabari4Loop이 직접 읽고/강제 → **불변, 모든 프로젝트 동일** | 이 문서(동결) | `docs/PROGRESS.md` 경로, 마커 문자열, Stop·SessionStart 훅 |
| **내용물** | 프로젝트마다 새로 작성 | 부트스트랩(Phase 0) | BUILD_ORDER 본문, 운영 프롬프트 본문, env |

Sidabari4Loop에 새 프로젝트를 태우는 일 = **내용물을 이 계약에 맞춰 한 번 차려놓는 것**이다.
그 셋업 절차가 §7의 부트스트랩이다.

---

## 1. 상태 파일 — `docs/PROGRESS.md` (**하드 필수**)

Sidabari4Loop은 매 턴 종료(Stop) 직후 프로젝트의 `docs/PROGRESS.md`를 읽는다.
경로는 **고정**이다 — 다른 이름/위치는 인식하지 못한다.

> 근거: `src/components/monitor/SupervisorController.tsx`
> `readProjectText(cfg.directory, "docs/PROGRESS.md")` → `null`이면 `stopLoop("docs/PROGRESS.md 없음")`.

- 이 파일이 **없으면 첫 턴이 끝나는 순간 루프가 정지**한다.
- 대화(컨텍스트)는 `/clear`·`/compact`로 비워지므로, **상태의 진실은 대화가 아니라 이 파일**이어야 한다.
- 이름이 `MEMORY.md`가 아니라 `PROGRESS.md`인 이유: Sidabari4Loop/Claude의 자동 메모리(`MEMORY.md`)와
  혼동을 피하기 위해서다. 이 파일은 *자율 루프의 진행 상태 원본*이다.

### 1.1 종료 신호 마커 (정확한 형식 — 코드 검출 규칙)

루프 지속 여부는 `docs/PROGRESS.md` 내용을 줄 단위로 보고 판정한다.

> 근거: `src/lib/supervisor.ts` `evaluateLoopSignal()`
> ```ts
> const hasComplete = lines.some((l) => /TASK_COMPLETE/.test(l));
> const hasOpen     = lines.some((l) => /^\s*(?:[-*]\s+)?OPEN(?:\[\w+\])?:/.test(l));
> const haltLine    = lines.find((l) => /^\s*(?:[-*]\s+)?HALT:/.test(l));
> if (hasComplete && !hasOpen) → complete (완료 정지)
> if (haltLine)                → halt     (정지)
> else                         → continue (다음 턴)
> ```
>
> OPEN·HALT 검출은 **안전 게이트**라, 위험 방향(놓침)으로 잘 안 틀리도록 **관대하게** 매칭한다:
> 줄 앞 들여쓰기·`- `/`* ` 불릿 허용, ID는 임의 길이, 단 **콜론(`:`)은 필수**.

| 신호 | 코드가 찾는 것 | 맞는 예 | **틀린 예 (검출 안 됨)** |
|---|---|---|---|
| **완료** | 아무 줄에 `TASK_COMPLETE` 포함, **그리고 미해결(OPEN) 줄이 하나도 없음** | `상태: TASK_COMPLETE` | — |
| **미해결** | 줄이 (불릿/들여쓰기 후) `OPEN` + 선택적 `[ID]` + **`:`** 로 시작 | `OPEN: 로그인 검증 미구현`<br>`OPEN[01]: 결제 테스트 부재`<br>`- OPEN: 토큰 갱신 누락` | `## OPEN ISSUES`(콜론 ❌)<br>`OPEN ISSUES`(콜론 ❌)<br>`이건 open: 아님`(줄 시작 ❌) |
| **정지** | 줄이 (불릿/들여쓰기 후) `HALT:` 로 시작 | `HALT: 외부 API 키 없음 — 사람 필요`<br>`- HALT: 빌드 깨짐` | `## HALT`(콜론 ❌) |

> ⚠️ **여전히 주의:** 미해결 항목을 `## OPEN ISSUES` **헤딩**으로만 적고 그 아래에 콜론 없는 문장으로
> 나열하면 코드는 "미해결 없음"으로 본다. 미해결은 반드시 **`OPEN:` / `OPEN[ID]:` 줄**(불릿 가능)로 적는다.

규칙 요약:
- 일을 더 해야 하면 → `TASK_COMPLETE`를 **두지 않는다**(미해결 `OPEN:` 줄만 둔다).
- 모든 일이 끝났을 때만 → 마지막 턴에서 모든 `OPEN:` 줄을 제거하고 `TASK_COMPLETE`를 남긴다.
- 사람 개입이 필요해 멈춰야 하면 → `HALT: <이유>` 줄을 남긴다.

### 1.2 진행 포인터 (도구는 안 읽지만 규약상 필수)

`## 다음 할 일` 섹션에 **'다음 한 단계'를 명확히** 적는다. Sidabari4Loop은 이 섹션을 직접
파싱하지 않지만, 운영 프롬프트(§3)가 "매 턴 읽고 다음 한 단계를 수행"하도록 시키므로 사실상
필수다. 한 단계는 **턴 하나에 끝날 크기**여야 한다.

---

## 2. 작업 정의 — `docs/BUILD_ORDER.md` (운영 프롬프트가 참조)

'다음 한 단계'를 결정할 수 있는 단계/순서 정의. **Sidabari4Loop이 직접 읽지는 않는다** —
운영 프롬프트가 "BUILD_ORDER를 참고해 다음 단계를 정하라"고 시킬 때만 의미를 가진다.
따라서 파일명은 권장값이며, 운영 프롬프트가 가리키는 이름과 일치하기만 하면 된다.

---

## 3. 운영 프롬프트 (Sidabari4Loop **설정**에 저장 — 파일 아님)

매 턴 동일하게 재주입되는 고정 프롬프트. **docs 파일이 아니라 설정값**이다.

> 근거: `src/lib/config.ts` `supervisor.operating_prompt`. 매 턴 bracketed-paste로 주입
> (`src/lib/supervisor.ts` `injectPrompt`).

운영 프롬프트는 반드시 다음 5가지를 Claude에게 지시해야 한다:

1. **한 단계만** 하고 턴을 끝낸다(여러 단계 몰아서 ❌).
2. 매 턴 시작에 `docs/PROGRESS.md`를 읽는다.
3. 작업 후 `docs/PROGRESS.md`를 갱신하고 커밋한 뒤 양보한다(상태는 파일에 남긴다).
4. 사용자에게 묻지 않는다(무인 진행 — 결정 불가 항목은 `OPEN:` 또는 `HALT:`로 PROGRESS에 남긴다).
5. 완료 시 `TASK_COMPLETE`(미해결 0), 정지 필요 시 `HALT:`를 **PROGRESS에 기록**한다(§1.1 형식).

---

## 4. 훅 인터페이스

Sidabari4Loop은 Claude Code의 훅 이벤트로 턴 경계를 인식한다.

| 이벤트 | 용도 | 비고 |
|---|---|---|
| **Stop** | 턴 종료 → PROGRESS 읽고 다음 턴 판정 | 필수 |
| **SessionStart(source=clear)** | `/clear` 완료 신호 → 운영 프롬프트 재주입 | clear 모드일 때 |
| **SessionStart(source=compact)** | `/compact` 완료 신호 → 운영 프롬프트 재주입 | compact 모드일 때 |

> 근거: `SupervisorController.tsx` listener — `kind==="stop"`, `kind==="session-start" && payload.source===expected`.

이 훅들은 Sidabari4Loop이 프로젝트의 `settings.local.json`에 자동 설치한다(`_sidabari4loop` 마커로
관리 영역만 병합, 사용자 설정 보존).

### 4.1 ⚠️ Stop 훅 비켜서기 (프로젝트별 1순위 점검)

프로젝트에 **강제연속 Stop 훅(`exit 2`)**이 있으면 턴이 실제로 끝나지 않아 Sidabari4Loop이
다음 턴을 줄 **경계 자체가 생기지 않는다**. 그런 훅이 있으면 가드로 비켜서게 한다:

```
환경변수 SIDABARI4LOOP=1 이면 → exit 0 (연속 안 함)
그 외 → 기존 동작
```

강제연속 Stop 훅이 없으면 그대로 두면 된다.

---

## 5. 실행 설정 (프로젝트별)

> 근거: `src/lib/config.ts` `ClaudeCodeSessionSchema`.

| 설정 | 플래그 | 비고 |
|---|---|---|
| `directory` | (실행 경로) | 절대경로 |
| `skip_permissions` | `--dangerously-skip-permissions` | **무인 루프용. 보안 주의 — §5.1** |
| `chrome` | `--chrome` | 브라우저 QA 필요할 때만 |
| `extra_args` | (자유 인자) | 공백 구분 |

env(프로젝트별 환경변수)는 **현재 설정 스키마에 없다**. 필요하면 별도 추가 작업이다.

### 5.1 보안 주의 — skip_permissions는 게이트를 끈다

`--dangerously-skip-permissions`를 켜면 PreToolUse 게이트(사람 허용/거부)가 **완전히 무력화**된다.
즉 "사람이 결정한다"(CLAUDE.md §1.3)는 안전장치가 사라지고, 그 자리를 **운영 프롬프트 + PROGRESS
계약에 대한 신뢰**가 대신한다. 자율 루프의 본질상 의도된 트레이드오프지만, 이 모드에서는
Claude가 추천한 모든 도구 호출이 사람 확인 없이 실행됨을 명확히 인지하고 켠다.

---

## 6. 컨텍스트 정책

> 근거: `src/lib/config.ts` `SupervisorConfigSchema`, `SupervisorController.tsx` `onStop`.

| 설정 | 기본값 | 의미 |
|---|---|---|
| `context_reset` | `compact` | 턴 사이 리셋 방식: `clear`(새 세션) / `compact`(요약 압축, 같은 세션) / `none`(리셋 없이 재주입) |
| `compact_threshold_pct` | `50` | (compact 모드) 점유 이 % 미만이면 압축 생략하고 프롬프트만 재주입 |
| `context_window_tokens` | `1000000` | 점유율 분모. 표준 200000, 1M 컨텍스트 1000000 |

- `none` 모드: `/clear`·`/compact`를 전혀 하지 않고 운영 프롬프트만 재주입한다. 턴이 끝나므로
  Claude Code의 **auto-compact가 경계에서 컨텍스트를 관리**한다. 명시적 `/compact`의 느린 압축을
  피하는 가장 가벼운 정책 — 큰 Phase 경계에서만 가끔 `clear`/`compact`를 쓰고 싶을 때 적합하다.
- `compact` 모드 + 임계치: 점유가 임계 미만이면 압축 없이 다음 턴을 바로 잇는다(느린 압축 회피).
- `/compact`는 LLM 요약이라 느리고 누적될수록 더 느려진다(수 분 관측). 진행 중 재주입은
  방해만 되므로 재시도하지 않고 길게 기다린다(최대 30분, 초과 시 정지 — 사람 결정).

---

## 7. 시작 전 절차 (부트스트랩 → 검수 → preflight → 루프 ON)

```
0. [전제] 프로젝트 루트에 CLAUDE.md가 있어야 한다 (스택·구조·범위 = 무엇을 만드는지).
   부트스트랩은 CLAUDE.md를 만들지 않고 읽는다.
1. 빈/새 프로젝트에 Sidabari4Loop 연결 — 루프 OFF
2. [부트스트랩 1턴, 루프 OFF] 부트스트랩 프롬프트 주입
      · 권장: 메인 패널 🚀 버튼 → 프로젝트명(폴더명 자동)·추가 메모(선택) → [주입] (루프 OFF 유지)
      · 또는 수동: templates/bootstrap-prompt.md를 채워 첫 프롬프트로 붙여넣기
      → Claude가 CLAUDE.md를 읽어 docs/PROGRESS.md·docs/BUILD_ORDER.md 생성 후 멈춤
        (CLAUDE.md가 없으면 멈추고 보고 — 추측 금지)
3. [사람 검수 게이트] 산출물이 계약(특히 §1.1 마커 형식)에 맞는지 확인
4. 설정에 operating_prompt 입력 (§3의 5대 요건 포함)
5. [preflight] 아래 체크리스트 통과 확인
6. Supervisor 루프 ON → 운영 프롬프트 주입 → 자율 루프 시작
```

부트스트랩(Phase 0)은 **반드시 루프 밖**에서 한다. 루프가 켜진 채로 하면 스캐폴드가
완성되기 전에 도구가 다음 턴을 밀어넣거나 "PROGRESS 없음"으로 정지한다.

### 7.1 Preflight 체크리스트 (루프 ON 직전)

- [ ] 루트에 `CLAUDE.md`가 있는가 (스택·범위 — 부트스트랩·매 턴의 전제)
- [ ] `docs/PROGRESS.md`가 존재하는가
- [ ] `docs/PROGRESS.md`에 `TASK_COMPLETE`가 **미리 들어있지 않은가**(있으면 시작 즉시 완료 오판)
- [ ] 미해결 항목이 있다면 `OPEN:` / `OPEN[ID]:` **줄 형식**으로 적혀 있는가(콜론 없는 헤딩 ❌)
- [ ] `## 다음 할 일`에 '다음 한 단계'가 적혀 있는가
- [ ] `operating_prompt`가 설정됐고 §3의 5대 요건을 담고 있는가
- [ ] 프로젝트에 가드 없는 강제연속(`exit 2`) Stop 훅이 없는가(있으면 §4.1 가드)
- [ ] `directory`가 올바른 절대경로인가
- [ ] (무인 실행이면) `skip_permissions`의 보안 함의(§5.1)를 인지했는가

---

## 부록 A — 동결 결정 이력

일반화 과정에서 확정해 동결한 결정과 근거. 바꾸려면 이 문서 + 해당 코드를 같이 변경한다.

1. **완료 마커 = `TASK_COMPLETE`** — 기존 `EXPERIMENT_COMPLETE`는 실험/LMS 특화 잔재라 제거.
   변경 지점: `src/lib/supervisor.ts` `evaluateLoopSignal`.
2. **미해결 형식 = `OPEN:` 줄 토큰 (관대 매칭)** — 마크다운 섹션 파싱은 안전 게이트에 부적합
   (경계 모호성이 위험 방향 오판을 키움). 줄 단위 명시 토큰을 유지하되, 들여쓰기·불릿·임의 ID를
   허용해 인체공학을 개선. 정규식 `^\s*(?:[-*]\s+)?OPEN(?:\[\w+\])?:`.
3. **상태 파일 = `docs/PROGRESS.md` 고정** — 경로 설정화는 drift를 부르므로 단일 표준으로 고정.
   이름은 자동 메모리(`MEMORY.md`)와의 혼동을 피해 `MEMORY.md` → `PROGRESS.md`로 변경.
