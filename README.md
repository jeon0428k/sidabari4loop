# Sidabari4Loop

> **Claude Code 실행 + Hook 이벤트 처리 데스크톱 도구 (1인용)**
>
> Claude Code를 로컬 PTY에서 실행하고, Claude Code가 발생시키는 **Hook 이벤트**를 수신해 정해진 동작을 수행하기 위한 Tauri 데스크톱 앱.

![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows_11-0078D6?style=flat-square&logo=windows11&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?style=flat-square&logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-stable-000000?style=flat-square&logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)
![Authored by Claude Code](https://img.shields.io/badge/Authored_by-Claude_Code-D97757?style=flat-square&logo=anthropic&logoColor=white)

---

## 무엇을 해 주는가

Sidabari4Loop은 두 가지에 집중합니다:

1. **메인 패널에서 Claude Code를 PTY로 실행** — 설정한 디렉토리에서 `claude`를 띄우고, 터미널 UI(xterm.js)로 상호작용.
2. **Claude Code Hook 이벤트 수신** — `SessionStart`/`Stop`/`PreToolUse`/`PostToolUse`/`Notification` 등의 훅을 받아 패널 활성도 표시·데스크톱 알림·위험 도구 게이트·콘솔 로그·감사 로그(SQLite)로 처리.

> 원본 **[Sidabari](https://github.com/cx8537/sidabari)**(Claude Code 기반 EC2 배포·진단 자동화)에서 EC2/SSH/SFTP/빌드/배포/진단을 모두 제거하고 위 두 핵심만 남긴 파생 프로그램입니다.

핵심 철학 (원본 계승):

- **자동 재시도 금지.** 실패 시 멈추고 사람이 판단.
- **Claude 추천 자동 실행 금지.** PreToolUse 게이트는 사람의 결정 지점.
- **추측 금지.** 원인을 코드로 확인한 뒤 고친다.

자세한 동작 사양은 [SIDABARI4LOOP_SPEC.md](SIDABARI4LOOP_SPEC.md), 작업 규칙·보안 정책은 [CLAUDE.md](CLAUDE.md)를 참고하세요.

---

## 저작 기록 (Authorship)

> **이 프로젝트의 모든 코드와 문서는 [Claude Code](https://www.anthropic.com/claude-code)가 100% 작성·유지보수합니다.** 인간 협업자(`cx8537`)는 요구사항 정의·사양 결정·검수를 담당하며, **코드를 직접 손대지 않습니다.**

| 역할 | 담당 |
|---|---|
| 코드 작성 / 리팩토링 / 유지보수 | Claude Code |
| 모든 문서 (`README.md`, `SIDABARI4LOOP_SPEC.md`, `CLAUDE.md`) | Claude Code |
| 사양 결정 · 요구사항 · 검수 | cx8537 (인간) |

매 세션 시작 시 [CLAUDE.md](CLAUDE.md)가 절대 원칙(추측 금지·자동 재시도 금지·보안 규칙)으로 적용됩니다. 커밋 메시지에는 `Co-Authored-By: Claude` 트레일러로 표기됩니다.

---

## 사용 대상

- Claude Code를 **로컬 PTY에서 직접 운전**하면서 훅 이벤트로 동작을 자동화하고 싶은 1인 개발자.
- 턴 경계(`Stop`)·세션 시작·도구 호출 같은 훅을 받아 **활동 표시·데스크톱 알림·위험 도구 게이트·감사 로그**를 한 화면에서 보고 싶은 사람.
- 비슷한 워크플로를 쓰는 분이라면 그대로 쓰거나, 포크해 본인 환경에 맞게 고치셔도 됩니다(MIT).

1차 검증은 **Windows 11** 기준입니다. macOS/Linux는 코드상 호환되나 미검증입니다.

---

## 주요 기능

- **단일 윈도우 상/하 분할** — 상단: 메인 Claude Code PTY, 하단: Hook 콘솔. 경계 드래그로 비율 조절(localStorage 저장).
- **로컬 PTY로 Claude Code 실행** (`portable-pty`, Windows ConPTY / Unix PTY 추상). Windows npm shim(`.cmd`/`.ps1`)은 자동 래핑.
- **Claude Code 훅 통합** — 일방향 이벤트(events.jsonl tail)와 양방향 게이트(req/resp 파일 페어).
- **위험 도구 게이트** — `PreToolUse(Bash)` 호출 시 허용/거부 모달(옵트인).
- **감사 로그** — Hook 이벤트를 SQLite(`audit.sqlite3`)에 적재.
- **설정 대화상자** — 실행 디렉토리·`claude` 자동 실행·verbose 훅 로그·게이트 토글·[훅 설치]·Supervisor 운영 프롬프트/리셋 모드.
- **Supervisor 자율 루프** — Claude의 턴 종료(`Stop`) 직후 운영 프롬프트를 재주입해 `docs/PROGRESS.md` 기준으로 **다음 한 단계**를 자동 진행. 컨텍스트가 임계치를 넘으면 `/compact`·`/clear`로 정리(또는 `none`), `TASK_COMPLETE`/`HALT` 마커에서 자동 정지. **시작·정지는 항상 사람이** 결정.
- **부트스트랩(🚀)** — 새 프로젝트에 루프를 태우기 전, `docs/PROGRESS.md`·`docs/BUILD_ORDER.md`를 **1회** 생성(루프는 OFF, `CLAUDE.md` 전제). 운영 계약은 [SIDABARI4LOOP_CONTRACT.md](SIDABARI4LOOP_CONTRACT.md).

---

## 기술 스택

### 앱 셸
![Tauri](https://img.shields.io/badge/Tauri_2.x-24C8DB?style=for-the-badge&logo=tauri&logoColor=white)

### 프론트엔드
![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![React](https://img.shields.io/badge/React_19-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_v4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)
![Zustand](https://img.shields.io/badge/Zustand-443E38?style=for-the-badge)
![Zod](https://img.shields.io/badge/Zod-3068B7?style=for-the-badge&logo=zod&logoColor=white)

추가: xterm.js v6 (+ addon-fit, addon-unicode11), react-resizable-panels, shadcn/ui(radix-ui), lucide-react, @fontsource-variable/geist, @tauri-apps/api · plugin-clipboard-manager · plugin-dialog · plugin-notification · plugin-opener · plugin-window-state.

### 백엔드 (Rust)
![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite_(rusqlite_bundled)-003B57?style=for-the-badge&logo=sqlite&logoColor=white)

crate: portable-pty, notify, rusqlite(bundled), serde · serde_json, uuid.

---

## 사전 준비

- **Node.js**: 20 이상 권장.
- **Rust toolchain**: stable (`rustup`). Windows는 MSVC 빌드 도구 + WebView2.
- **OS**: 1차 검증은 Windows 11. macOS/Linux는 코드상 호환되나 미검증.
- **Claude Code CLI**: `claude` 명령이 PATH에 있어야 메인 패널에서 자동 spawn 가능.

---

## 개발 셋업

```sh
# 1) 의존성 설치
npm install

# 2) Tauri 사전 요구사항 점검
npx @tauri-apps/cli info

# 3) 개발 모드 실행 (vite dev + Rust 컴파일 + Tauri 윈도우)
npm run tauri dev
```

빠른 빌드/타입 확인만 필요하면:

```sh
npm run build      # tsc + vite 프론트엔드 빌드
cargo check --manifest-path src-tauri/Cargo.toml
```

---

## 빌드 (배포 산출물)

```sh
npm run tauri build
```

산출물 위치 (Windows 기준):

- `src-tauri/target/release/sidabari4loop.exe` — 단일 실행파일
- `src-tauri/target/release/bundle/` — MSI / NSIS 인스톨러

설치 파일 없이 exe만 원하면 `npm run tauri build -- --no-bundle`.

---

## 사용 흐름

1. ⚙ **설정**에서 실행 디렉토리를 지정하고 `claude` 자동 실행을 켠 뒤 저장 → 그 디렉토리에서 `claude`가 PTY로 뜸.
2. ⚙ 설정 → **[훅 설치]** — 해당 디렉토리의 `.claude/settings.local.json`에 훅을 등록.
3. Claude Code가 작업하면 하단 **Hook 콘솔**에 `session 시작` → `PreToolUse`(verbose 시) → `turn 종료` 등의 이벤트가 흐름.
4. (옵션) **위험 도구 게이트**를 켜면 `Bash` 호출 시 허용/거부 모달이 뜸.
5. (옵션) 🚀 **부트스트랩** — `CLAUDE.md`가 있는 새 프로젝트에 작업 상태 파일(`docs/PROGRESS.md`·`docs/BUILD_ORDER.md`)을 1회 생성(루프는 켜지 않음).
6. (옵션) ▶ **Supervisor 루프 시작** — 턴이 끝날 때마다 다음 단계를 자동 진행. `docs/PROGRESS.md`에 `TASK_COMPLETE`/`HALT`가 적히면 자동 정지(언제든 ■로 수동 정지).

---

## 프로젝트 구조

```
src/                       # React 프론트엔드
├── App.tsx                # MainLayout + GateModal + HookBridge
├── components/
│   ├── layout/            # MainLayout, ResizeHandle
│   ├── panels/            # MainClaudePanel(PTY), ConsolePanel(Hook 콘솔)
│   ├── terminal/          # PtyTerminal, Terminal(TERMINAL_THEME)
│   ├── modals/            # SettingsModal, GateModal
│   ├── monitor/           # HookBridge, ActivityIndicator
│   └── ui/                # button, dialog (shadcn)
├── lib/                   # pty, hooks, config, claudeHooks, utils
└── store/                 # Zustand 전역 상태

src-tauri/src/             # Rust 백엔드
├── main.rs / lib.rs       # 진입점·IPC 핸들러 등록
├── pty.rs                 # 로컬 PTY (portable-pty) + Windows shim 해석
├── hooks_bus.rs           # Hook IPC (events.jsonl tail + req/resp 게이트)
├── hook_installer.rs      # .claude/settings.local.json 훅 등록
├── audit_log.rs           # SQLite 감사 로그
└── config.rs              # 설정 load/save (JSON)

src-tauri/resources/       # append-event.js, gate.js (훅 스크립트)
CLAUDE.md                  # 작업 규칙 + 보안 + UI 가이드
SIDABARI4LOOP_SPEC.md        # 동작 사양서
```

---

## 설정

- 위치 (OS 표준, Tauri `app_config_dir`):
  - Windows: `%APPDATA%\kr.co.nullnull.Sidabari4Loop\config.json`
  - macOS: `~/Library/Application Support/kr.co.nullnull.Sidabari4Loop/config.json`
  - Linux: `~/.config/kr.co.nullnull.Sidabari4Loop/config.json`
- 앱 내 ⚙ [설정] 대화상자에서 편집. 저장 시 PTY가 일괄 재시작되어 즉시 반영.
- **자격증명을 저장하지 않습니다** — 설정에는 경로/토글뿐.

스키마는 [SIDABARI4LOOP_SPEC.md §5.2](SIDABARI4LOOP_SPEC.md), 코드는 `src-tauri/src/config.rs` / `src/lib/config.ts`.

---

## 보안 정책 요약

- 외부 텍스트(사용자 입력·Hook payload·Claude 출력)를 셸 명령 문자열로 직접 조합하지 않음 (CommandBuilder 개별 인자).
- 훅 설치 디렉토리 경로 검증 + `settings.local.json` 백업 후 병합 (Sidabari4Loop 관리 영역만 교체).
- Tauri command 입력 검증 + 위험 도구 게이트(사람의 결정).
- 감사 로그(SQLite) 권한 `0600`, 훅 디렉토리/스크립트 `0700` (Unix).
- 자세한 정책: [CLAUDE.md §1.2](CLAUDE.md).

---

## 문서

| 문서 | 용도 |
|------|------|
| [SIDABARI4LOOP_SPEC.md](SIDABARI4LOOP_SPEC.md) | 동작 사양서 (Hook 흐름 / UI / 설정 스키마) |
| [SIDABARI4LOOP_CONTRACT.md](SIDABARI4LOOP_CONTRACT.md) | Supervisor 자율 루프 운영 계약 (상태 파일 경로·마커·훅 요건, 모든 프로젝트 공통) |
| [CLAUDE.md](CLAUDE.md) | 작업 규칙·보안 가이드·UI 스타일 가이드 (Claude Code 작업 시 1차 참조) |

---

## 상태

- 핵심 기능(PTY 실행 · 훅 수신/콘솔 · 위험 도구 게이트 · 감사 로그 · 설정/훅 설치)은 동작합니다.
- **Supervisor 자율 루프**와 **부트스트랩(🚀)**을 포함합니다 — 운영 계약은 [SIDABARI4LOOP_CONTRACT.md](SIDABARI4LOOP_CONTRACT.md).
- Windows 11 기준 1차 검증 완료, 활발히 개발 중인 1인용 도구입니다.

---

## 라이선스

**MIT License** — [LICENSE](LICENSE) 파일 참조. 그대로 쓰거나, 포크해 본인 환경에 맞게 고치거나, 상업적으로 활용하셔도 자유입니다.

### 라이선스 범위

- **이 저장소의 자체 코드·문서** — Rust/TypeScript 소스, 훅 스크립트(`append-event.js`·`gate.js`), 문서(`README.md`·`SIDABARI4LOOP_SPEC.md`·`SIDABARI4LOOP_CONTRACT.md`·`CLAUDE.md`)는 모두 **MIT**입니다. 저작권은 `cx8537`이 보유하며, 코드·문서는 Claude Code가 작성했습니다(자세한 내용은 [LICENSE](LICENSE) 상단의 저작 기록 주석).
- **서드파티 의존성**은 각자의 라이선스를 그대로 따릅니다 — 본 프로젝트의 MIT가 의존성에 적용되지 않습니다:
  - Tauri 및 Rust crates(portable-pty · notify · rusqlite 등): 대개 MIT 또는 Apache-2.0 (각 crate 라이선스 확인)
  - React · TypeScript · Vite · Tailwind CSS · Zustand · Zod · xterm.js 등 프런트엔드: 각 MIT
  - Geist 폰트(`@fontsource-variable/geist`): **SIL Open Font License 1.1**
  - 번들된 SQLite(rusqlite `bundled`): **Public Domain**
  - 배포 산출물에 포함되는 의존성의 라이선스 고지 의무는 각 라이선스 조건을 따릅니다.
- **원본 프로젝트** — 이 도구는 [cx8537/sidabari](https://github.com/cx8537/sidabari)(EC2 배포·진단 자동화, MIT)에서 SSH/SFTP/빌드/배포/진단을 제거·분리한 파생물입니다.

### 무보증 (AS IS)

이 도구는 **로컬에서 임의 프로그램(`claude`·셸)을 PTY로 실행**하고, **사용자 프로젝트의 `.claude/settings.local.json`에 훅을 설치**합니다. MIT의 무보증·무책임 조항(제공자는 어떤 손해에도 책임지지 않음)을 충분히 인지하고, **신뢰할 수 있는 디렉토리·명령에 대해서만** 사용하세요.
