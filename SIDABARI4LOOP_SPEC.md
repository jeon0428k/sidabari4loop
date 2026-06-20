# Sidabari4Loop 사양서

> **프로젝트명**: Sidabari4Loop (코드명/저장소 경로: Sidabari2 — 원본 Sidabari에서 분리)
> **표시명**: Sidabari4Loop
> **식별자**: `kr.co.nullnull.Sidabari4Loop` (Tauri identifier · crate `sidabari4loop`)
> **목적**: Claude Code를 로컬 PTY에서 실행하고, Claude Code가 발생시키는 **Hook 이벤트**를 수신해 정해진 동작을 수행하는 1인용 데스크톱 도구.
> **라이선스**: MIT
> **저작**: 모든 코드·문서 100% Claude Code 작성. 인간 협업자(cx8537)는 요구사항·사양·검수만 담당한다.

---

## 1. 개요

### 1.1 정체성

Sidabari4Loop은 원본 **Sidabari**(Claude Code 기반 EC2 배포·진단 자동화 도구)를 복사해, **EC2/SSH/SFTP/빌드/배포/진단 기능을 전부 제거하고** 두 가지 핵심만 남긴 파생 프로그램이다:

1. **좌측(상단) 메인 패널에서 Claude Code를 PTY로 실행**
2. **Claude Code Hook 이벤트 수신** — 들어온 이벤트에 따라 정해진 동작을 수행

원본 Sidabari와 동일 PC에서 충돌하지 않도록 식별자·저장 경로·훅 설치 마커를 모두 분리했다(§6 참조).

### 1.2 철학 (원본에서 계승)

- **기계적 작업은 자동화, 판단은 사람이.** Hook 게이트는 사람의 결정 지점이다.
- **자동 재시도 금지.** 실패 시 멈추고 사람이 판단한다.
- **추측 금지.** 원인을 코드로 확인한 뒤 고친다 (CLAUDE.md §1.1).

### 1.3 사용자

본인 1명 사용을 가정한다. 룰 엔진 같은 일반화 메커니즘 없이 동작을 코드에 직접 정의한다. MIT로 공개 — 같은 워크플로우를 쓰는 사용자는 그대로 쓰거나 포크할 수 있다.

---

## 2. 기술 스택

### 앱 셸
- **Tauri 2.x**

### 프론트엔드
- **Vite + React 19 + TypeScript**
- **Tailwind CSS v4**, **shadcn/ui (radix-ui)**, **lucide-react**
- **xterm.js v6 + addon-fit + addon-unicode11** (터미널 렌더링)
- **react-resizable-panels** (상/하 분할)
- **Zustand** (상태), **Zod** (IPC 응답 런타임 검증)

### 백엔드 (Rust)
- **Tauri Core** (IPC)
- **portable-pty** (로컬 PTY: Claude Code 실행)
- **notify** (events.jsonl / req-*.json 파일 감시)
- **rusqlite (bundled)** (Hook 이벤트 감사 로그)
- **serde / serde_json** (설정), **uuid**

> 제거됨: russh / russh-sftp / ssh-key / sha2 / rand_core / async-trait / tokio (SSH·SFTP·crypto 전용 의존성).

---

## 3. 동작 설계

### 3.1 메인 Claude Code 패널

- 앱 시작 시 설정(`claude_code_sessions.main`)을 읽어 PTY를 spawn한다.
  - `directory`가 있으면 cwd로 사용 (없으면 백엔드가 사용자 홈으로 폴백).
  - `auto_start=true` → `claude` 실행, `false` → OS 기본 셸(사용자가 수동으로 `claude` 입력).
  - **기본값 `auto_start=true`** — Sidabari4Loop의 본질이 Claude Code 실행이므로.
  - 실행 인자: `skip_permissions`(`--dangerously-skip-permissions`), `chrome`(`--chrome`), `extra_args`(공백 구분 추가 인자)를 `auto_start`일 때 `claude`에 전달. 자율 루프는 권한 프롬프트로 멈추면 안 되므로 보통 `skip_permissions`를 켠다. 인자는 `CommandBuilder`에 개별 전달(셸 인젝션 없음).
- PTY에 `SIDABARI4LOOP_PANEL_ID=main-claude` 환경변수를 주입한다. Hook 스크립트가 이 값으로 어느 패널에서 발생한 이벤트인지 식별한다.
- Windows에서 `claude` 같은 npm shim은 PATH/PATHEXT로 `.cmd`/`.bat`/`.ps1`을 찾아 `cmd.exe /c` 또는 `powershell -File`로 래핑해 실행한다(셸 인젝션 방지를 위해 인자는 개별 전달).
- `claude` 프로세스가 종료되면 OS 기본 셸로 1회 폴백(다음 작업 환경 유지). 셸도 종료되면 [다시 시작] 버튼으로 사용자 명시 액션을 요구한다. **자동 재시도는 하지 않는다.**
- 설정 저장 시 `restartAllClaudes()`로 PTY를 일괄 remount해 새 설정을 즉시 반영한다. remount는 **새 설정 로드가 끝난 뒤에만** 일어난다(옛 spawn으로 먼저 remount되는 race 방지).

### 3.2 Hook 이벤트 수신

Claude Code 훅을 통해 들어오는 신호를 **파일 기반 IPC**로 받는다.

```
<app_data>/sidabari4loop-hooks/
  scripts/append-event.js   (일방향 — node가 events.jsonl에 append)
  scripts/gate.js           (양방향 — req-/resp- 파일 페어)
  events.jsonl              (append-only, Rust watcher가 tail)
  req-<uuid>.json           (gate 요청, 임시)
  resp-<uuid>.json          (gate 응답, 임시)
```

**일방향 이벤트 흐름:**

```
claude가 훅 발생
  → node append-event.js <EventName>   (settings.local.json에 등록된 명령)
  → events.jsonl 한 줄 append (payload + _sidabari4loop 메타: panel_id 등)
  → Rust notify watcher가 tail → classify_event → emit("hook:event", {kind, payload})
  → 감사 로그(SQLite)에 적재
  → 프론트 HookBridge가 수신 → 패널 활성도/도구 갱신 + Hook 콘솔 기록 + (Notification 시) 데스크톱 토스트
```

분류되는 `kind`: `stop` · `pretool` · `posttool` · `notification` · `session-start` · `subagent-stop` · `user-prompt` · `other:<name>`.

**양방향 게이트 흐름 (PreToolUse):**

```
claude가 Bash 도구 호출 시도
  → node gate.js PreToolUse
  → req-<id>.json 작성 → Rust가 emit("hook:gate-request")
  → GateModal 표시 → 사용자가 [허용]/[거부]
  → hook_gate_respond가 resp-<id>.json 작성
  → gate.js가 읽어 permissionDecision(allow/deny) 출력
  → (30초 무응답 시 deny, 보수적)
```

### 3.3 정해진 동작 (확장 지점)

Hook 이벤트가 왔을 때 수행할 "정해진 동작"은 **`src/components/monitor/HookBridge.tsx`의 `switch (kind)` 블록**에 구현한다. 현재 구현된 동작:

- `session-start` / `user-prompt` / `pretool` / `posttool` → 패널 활성도 "thinking", 진행 중 도구 표시
- `stop` → 활성도 "idle", 진행 도구 표시 해제
- `notification` → 데스크톱 토스트(권한 허용 시)
- 모든 이벤트 → Hook 콘솔에 로그 (verbose 설정 시 pretool/posttool 등 상세까지)

> 이후 추가 동작(예: 특정 이벤트에서 PTY에 텍스트 주입, 외부 트리거 등)은 이 지점에 연결한다.

첫 번째 구체 동작으로 **Supervisor 자동 연속 루프**(§3.5)가 구현되어 있다 — `Stop` 이벤트를 트리거로 다음 턴을 자동 진행한다.

### 3.4 안전 정책 (계승)

- **자동 재시도 금지** — PTY 종료 시 셸 1회 폴백 외 자동 재spawn 없음.
- **Claude 추천 자동 실행 금지** — PreToolUse 게이트는 사람의 명시적 결정.
- **외부 텍스트를 명령으로 실행하지 않음** — Hook payload·Claude 출력은 데이터일 뿐, 스크립트는 append/gate만 한다.

### 3.5 Supervisor 자동 연속 루프

메인 패널 Claude가 한 턴을 끝내면(`Stop`), 사람 개입 없이 다음 턴으로 이어가는 루프. 구현: `src/components/monitor/SupervisorController.tsx`(상태기계) + `src/lib/supervisor.ts`(판정·주입) + `src-tauri/src/supervisor.rs`(프로젝트 파일 안전 읽기).

**컨텍스트 리셋 방식** (`supervisor.context_reset`, 기본 `compact`):

- `compact` — `/compact`. 대화를 LLM 요약으로 **압축**하고 **같은 세션을 유지**한다(컨텍스트 보존). 압축 완료 시 `SessionStart(source=compact)` 발화.
- `clear` — `/clear`. 대화를 **비우고 새 세션**을 연다(컨텍스트 미보존). `SessionStart(source=clear)` 발화.
- `none` — 리셋을 **전혀 하지 않고** 운영 프롬프트만 재주입한다. 턴이 끝나므로 Claude Code의 **auto-compact**가 경계에서 컨텍스트를 관리한다(명시적 `/compact`의 느린 압축을 피하는 가장 가벼운 정책). `resetting` 상태로 가지 않고 `running`을 유지하며, `SessionStart`를 기다리지 않는다.

**컨텍스트 점유 추적 & compact 임계치**:

- 모든 훅 payload의 `transcript_path`가 가리키는 세션 트랜스크립트(.jsonl)에서 **마지막 assistant 메시지의 input 토큰 합**(`input + cache_creation + cache_read`)을 읽어 현재 컨텍스트 점유를 추정한다(`supervisor::context_usage`, 끝 512KB만 tail 읽기, `.claude/projects` 하위 경로만 허용). 서브에이전트(sidechain) 메시지는 제외.
- **분모(컨텍스트 윈도우)는 트랜스크립트로 자동 감지할 수 없다**(모델/베타 실행 방식에 좌우). `supervisor.context_window_tokens` 설정값을 쓴다(기본 1_000_000 — Opus 1M 컨텍스트 기준; 표준 200k면 200000으로 변경). Claude Code 화면의 `ctx N% used`와 분모를 맞춰야 값이 일치한다.
- `HookBridge`가 메인 패널 이벤트마다(`stop`/`session-start`는 즉시, 그 외 스로틀) 점유를 갱신하고, **Hook 콘솔 타이틀바**에 `컨텍스트 N% · 72k/200k`로 표시한다(70%↑ 골드, 90%↑ 빨강).
- `compact` 모드에서 턴 종료 시 점유가 `supervisor.compact_threshold_pct`(기본 50) **미만이면 `/compact`를 생략**하고 같은 컨텍스트로 바로 다음 턴을 이어간다(불필요한 느린 압축 회피). 임계치 이상이거나 점유를 측정할 수 없으면 압축한다. `clear` 모드에는 적용되지 않는다(항상 비움).

**상태기계** (`running` ↔ `resetting`):

```
[시작] (타이틀바 ▶) → preflight 통과 → 운영 프롬프트 첫 주입(#1) → running
Stop(main-claude) && running
  → docs/PROGRESS.md 읽기 → 정지조건 판정
     · TASK_COMPLETE 줄 있고 미해결(OPEN) 줄 없음          → 정지(완료)
     · HALT: 줄 있음                                      → 정지(HALT)
     · 최대 반복 도달                                    → 정지(상한)
     · 그 외(continue) → iteration++
         - none    → 운영 프롬프트 재주입 (running 유지, 리셋 없음)
         - compact → 임계치 미만이면 재주입(running 유지), 이상이면 /compact 주입 → resetting
         - clear   → /clear 주입 → resetting
SessionStart(source=compact|clear, main-claude) && resetting
  → 운영 프롬프트 재주입 → running
```

- **시작 전 preflight** (`startLoop`, 계약 §7.1): 운영 프롬프트·실행 디렉토리·메인 세션을 확인한 뒤, **`docs/PROGRESS.md` 존재**와 **이미 종료 상태(TASK_COMPLETE/HALT)가 아님**을 검사한다. 하나라도 실패하면 사유를 로깅하고 시작하지 않는다(준비 안 된 채 시작해 첫 턴에 멈추는 것을 방지). 도구가 기계적으로 확인 가능한 항목만 검사하며, 운영 프롬프트의 5대 요건 충족 여부 등 의미적 검증은 사람 검수의 몫이다.
- **운영 프롬프트**: `supervisor.operating_prompt` 설정값. 첫 주입 + 매 컨텍스트 리셋 후 동일 재주입.
- **주입 방식**: 여러 줄 프롬프트는 브래킷 페이스트(`\x1b[200~…\x1b[201~`)로 한 번에 넣고 짧은 지연(≈300ms) 후 Enter(`\r`)로 제출(조기 제출 방지). 슬래시 명령(`/compact`·`/clear`)도 동일.
- **제출 워치독**: 간헐적으로 paste 직후 Enter가 합쳐지거나 입력창이 paste를 커밋하기 전에 도착해 **글자만 입력되고 제출이 안 되는** 현상이 있다(턴이 시작되지 않아 다음 `Stop`을 무한 대기). 이를 막기 위해 운영 프롬프트 주입 후 **`UserPromptSubmit`(=제출됨) 신호**를 기다린다(설치 훅에 포함). `SUBMIT_CONFIRM_MS`(≈3초) 내 신호가 없으면 **Enter만 재전송**(본문 재전송 X)하며, `MAX_SUBMIT_NUDGES`(기본 2)회까지 시도한다. 신호가 오면 즉시 워치독을 해제해 불필요한 재전송을 막는다. 한도를 넘겨도 **루프를 정지하지 않고** 넛지만 중단한 뒤 `Stop`을 계속 기다린다(`UserPromptSubmit` 훅이 미설치인 환경에서 정상 루프를 오정지시키지 않기 위함 — 이 경우 Hook 콘솔에 [훅 설치] 재실행을 안내). 정상 `Stop`(턴 완료) 시 워치독을 해제한다.
- **리셋 후 대기 이유**: 리셋 완료(`SessionStart(source=compact|clear)`) 전에 주입하면 입력이 유실되므로, 그 이벤트를 받은 뒤에만 재주입한다.
- **리셋 견고화 (모드별로 다름)**: 턴 종료 직후엔 입력 프롬프트가 준비 안 됐을 수 있어 정착 지연(≈400ms) 후, Esc로 잔여 입력 정리 → 슬래시 명령 → 메뉴 인식 지연(≈250ms) → Enter.
  - `clear`: 슬래시 명령이 가끔 즉시 실패(flaky)하므로, `SessionStart(clear)`가 ≈8초 내 안 오면 **재주입 재시도**(최대 3회), 그래도 없으면 정지.
  - `compact`: 압축은 LLM 요약이라 오래 걸리고 **컨텍스트 누적으로 반복마다 더 느려진다**(수 분 관측). 진행 중 `/compact` 재주입은 압축을 방해할 뿐 의미가 없으므로 **재시도하지 않고 기다린다**(최대 ≈30분). 이 한도를 넘으면 압축 지연/중단으로 보고 정지(자동 재시도 금지, CLAUDE.md §1.3 — 사람이 결정).
- **스톨(멈춤) 감지**: `running` 상태에서 Claude가 작업 없이 입력만 기다리며 멈추면 Claude Code가 `Notification(notification_type="idle_prompt")`를 발화한다. 이를 받으면 운영 프롬프트를 **재주입(넛지)**해 자동 복구를 시도하고, 연속 `MAX_STALL_NUDGES`(기본 2)회 넛지해도 (정상 `Stop` 없이) 계속 멈추면 루프를 정지한다. 정상 `Stop`(턴 완료)이 오면 넛지 카운터를 리셋한다. 긴 도구 실행(빌드 등)은 입력창 idle이 아니라 `idle_prompt`가 발화하지 않으므로 오탐하지 않는다.
- **안전장치**: 같은 `Stop` 중복 처리 방지(처리 중 플래그 + state 가드), 최대 반복 상한(`max_iterations`, 기본 500), 리셋 무응답 시 (clear) 재시도 후 / (compact) 대기 한도 후 정지, 스톨 넛지 한도 초과 시 정지, 모든 정지/시도 사유를 Hook 콘솔에 로깅. 타이틀바에 시작/정지 토글 + 반복 카운터(`루프 #N`).
- **Stop 훅 제약**: 턴이 실제로 끝나야 하므로 `Stop` 훅은 **exit 0 + 이벤트만**이어야 한다(강제연속 exit 2 금지). Sidabari4Loop의 `append-event.js`가 항상 `exit 0`이라 충족된다.

---

## 4. UI 설계

### 4.1 레이아웃

상단 툴바 없음. 단일 윈도우 **좌측 진행 사이드바 + 우측 상/하 분할**:

```
┌────────┬─────────────────────────────────────┐
│ 진행   │ 메인 Claude Code   [활동표시]   [⚙] │  ← 타이틀바
│ FND-010│                                     │
│ ✓ ...  │       Claude Code PTY (xterm)       │  (우측 상단 ~70%)
│ ● 현재 │                                     │
│ ○ 대기 ├─────────────────────────────────────┤  ← 드래그 리사이즈
│        │ Hook 콘솔                      [🗑] │
│ (좌측  │  [HH:MM:SS] [HOOK] panel=main ...    │  (우측 하단 ~30%)
│  사이드)│  [HH:MM:SS] [SYSTEM] 설정 저장 ...   │
└────────┴─────────────────────────────────────┘
```

- 분할 비율은 `react-resizable-panels` + localStorage로 저장/복원: 가로(`app-cols`, 진행 사이드바 폭) + 세로(`app-rows`, 메인/콘솔). 중첩 Group(가로 바깥 → 우측 열 안에 세로).
- 백그라운드 컴포넌트: `GateModal`(PreToolUse 게이트), `HookBridge`(이벤트 리스너).

### 4.2 영역별 역할

- **좌측 — 진행 패널**(`ProgressPanel`, 포커스 "progress"): `docs/BUILD_ORDER.md`의 체크박스를 Phase별 목록으로 보여주고 완료(✓)·현재(●)·대기(○)와 완료/전체·%를 표시. 매 `Stop`마다 자동 새로고침 + 🔄 수동(`useBuildProgress` → `parseBuildOrder`). 진행 여부는 `- [x]` 체크박스로만 판정(계약 §2).
- **우측 상단 — 메인 Claude Code 패널**: PTY 렌더링. 타이틀바에 활동 인디케이터(thinking/idle)·🚀 부트스트랩·▶ 루프·⚙ 설정 버튼.
- **우측 하단 — Hook 콘솔**: `consoleEvents`를 시간순으로 표시(`[HOOK]`/`[SYSTEM]`/`[USER]`). 🗑로 비우기.
- **설정 대화상자**(⚙): 실행 디렉토리(+폴더 선택)·`claude` 자동 실행·verbose 훅 로그·위험 도구 게이트 토글·[훅 설치].
- **게이트 모달**: PreToolUse(Bash) 호출 시 허용/거부.

### 4.3 모달은 사람의 결정 게이트

- 이벤트 수신만으로 모달을 자동으로 띄우지 않는다(설정·게이트 외).
- 위험 도구 게이트는 사용자가 설정에서 명시적으로 켰을 때만 발사된다. ESC/외부 클릭은 deny.

---

## 5. 설정

### 5.1 정책

- **JSON 파일**로 저장, **OS 표준 위치**(Tauri `app_config_dir`).
  - Windows: `%APPDATA%\kr.co.nullnull.Sidabari4Loop\config.json`
  - macOS: `~/Library/Application Support/kr.co.nullnull.Sidabari4Loop/config.json`
  - Linux: `~/.config/kr.co.nullnull.Sidabari4Loop/config.json`
- **자격증명을 저장하지 않는다** — Sidabari4Loop 설정에는 비밀이 없다(경로/토글뿐).
- 알 수 없는 필드는 무시(구 Sidabari config 파일과 관용적 호환).

### 5.2 설정 파일 스키마

Rust `src-tauri/src/config.rs` ↔ TS `src/lib/config.ts` 1:1.

```json
{
  "schema_version": 1,
  "claude_code_sessions": {
    "main": {
      "directory": "D:\\my-project",
      "auto_start": true,
      "skip_permissions": false,
      "chrome": false,
      "extra_args": ""
    }
  },
  "ui": {
    "verbose_hook_logs": false,
    "gate_dangerous_tools": false
  },
  "supervisor": {
    "operating_prompt": "",
    "max_iterations": 500
  }
}
```

| 키 | 의미 |
|---|---|
| `claude_code_sessions.main.directory` | 메인 Claude PTY의 cwd. 빈 값이면 사용자 홈. |
| `claude_code_sessions.main.auto_start` | `true`면 `claude` 자동 실행, `false`면 OS 셸. 기본 `true`. |
| `claude_code_sessions.main.skip_permissions` | `claude --dangerously-skip-permissions` (자율 루프용, 위험). 기본 `false`. |
| `claude_code_sessions.main.chrome` | `claude --chrome`. 기본 `false`. |
| `claude_code_sessions.main.extra_args` | claude에 넘길 추가 인자(공백 구분). |
| `ui.verbose_hook_logs` | Hook 콘솔에 PreToolUse/PostToolUse 등 상세 이벤트까지 표시. |
| `ui.gate_dangerous_tools` | PreToolUse(Bash) 게이트 모달 활성. [훅 설치] 시 gate.js 등록 여부에 반영. |
| `supervisor.operating_prompt` | Supervisor 루프가 첫 주입 + 매 컨텍스트 리셋 후 재주입할 운영 프롬프트(§3.5). |
| `supervisor.max_iterations` | 루프 무한 반복 방지 상한. 기본 500. |
| `supervisor.context_reset` | 턴 사이 컨텍스트 리셋 방식. `compact`(기본, 요약·세션 유지) / `clear`(비움·새 세션) / `none`(리셋 없이 재주입, auto-compact가 관리)(§3.5). |
| `supervisor.compact_threshold_pct` | compact 모드에서 `/compact`를 실행할 컨텍스트 점유 임계치(%). 미만이면 압축 생략. 0~100, 기본 50(§3.5). |
| `supervisor.context_window_tokens` | 점유율 계산 분모(토큰). 표준 200000, 1M 컨텍스트 1000000. 기본 1000000(§3.5). |

---

## 6. 독립성 (원본 Sidabari와의 분리)

원본과 같은 PC에서 충돌하지 않도록 다음을 분리했다:

| 항목 | 값 |
|---|---|
| Tauri identifier | `kr.co.nullnull.Sidabari4Loop` → config/`sidabari4loop-hooks`/`audit.sqlite3`/창상태/localStorage 경로 전부 분리 |
| Hook 설치 마커 | `_sidabari4loop_managed_hooks` / 각 훅 `"_sidabari4loop": true` → 같은 프로젝트 `.claude/settings.local.json`에서 원본 훅과 공존 |
| Hook 데이터 폴더 | `<app_data>/sidabari4loop-hooks/` |
| PTY 환경변수 | `SIDABARI4LOOP_PANEL_ID` |
| 설치 백업 확장자 | `.local.json.sidabari4loop-hooks-bak` |
| crate / 표시명 / 창제목 | `sidabari4loop` / Sidabari4Loop / Sidabari4Loop |

> 같은 프로젝트에 두 앱이 모두 훅을 설치한 적이 있다면, 각자 [훅 설치]를 다시 눌러 자기 스크립트 경로로 갱신한다.

---

## 7. 디렉토리 구조

```
src/
├── App.tsx                         # MainLayout + GateModal + HookBridge
├── components/
│   ├── layout/   MainLayout, ResizeHandle
│   ├── panels/   MainClaudePanel(PTY), ConsolePanel(Hook 콘솔)
│   ├── terminal/ PtyTerminal(xterm 래퍼), Terminal(TERMINAL_THEME)
│   ├── modals/   SettingsModal, GateModal
│   ├── monitor/  HookBridge(이벤트 리스너), SupervisorController(루프), ActivityIndicator
│   └── ui/       button, dialog (shadcn)
├── lib/          pty, hooks, config, claudeHooks, supervisor, utils
├── hooks/        usePanelFocus
└── store/        useAppStore (Zustand)

src-tauri/src/
├── main.rs        sidabari4loop_lib::run()
├── lib.rs         플러그인·state·IPC 핸들러 등록
├── pty.rs         로컬 PTY (portable-pty) + Windows shim 해석
├── hooks_bus.rs   Hook IPC (events.jsonl tail + req/resp 게이트)
├── hook_installer.rs  .claude/settings.local.json 훅 등록
├── audit_log.rs   Hook 이벤트 SQLite 감사 로그
├── supervisor.rs  Supervisor 루프용 프로젝트 파일 안전 읽기
└── config.rs      설정 load/save (JSON)

src-tauri/resources/
├── append-event.js  일방향 이벤트 append
└── gate.js          양방향 게이트
```
