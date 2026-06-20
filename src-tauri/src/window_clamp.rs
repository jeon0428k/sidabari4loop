// 창이 화면 밖/과대 크기로 복원되는 것을 막는 보정 플러그인.
//
// 배경: tauri-plugin-window-state 는 종료 시 창 위치·크기를 저장하고 시작 시 복원한다.
// 그러나 복원 로직에 두 가지 빈틈이 있다 (plugin v2.4.1 restore_state):
//   - POSITION: 저장된 (위치, 크기)가 "어떤 모니터와 교차(intersects)"하면 복원한다.
//     교차는 일부만 겹쳐도 참이라, 창 대부분이 화면 밖이어도 그대로 복원된다.
//   - SIZE: 모니터 경계와 무관하게 "무조건" 복원된다.
// 결과: 큰 외장 디스플레이에서 저장한 좌표/크기를 작은 화면(예: 노트북 단독)에서 그대로 복원하면
// 창이 화면 밖으로 나가거나 화면보다 커져 보이지 않는다. (멀티 디스플레이/Win11 이식 시 재발 가능)
//
// 이 플러그인은 window-state 가 복원한 크기가 OS 에 "적용된 뒤"(WindowEvent::Resized) 메인 창이
// 현재 모니터 작업영역(work_area) 안에 완전히 들어오도록 위치·크기를 보정한다.
//
// 왜 Resized 시점인가: window-state 의 set_size 복원은 on_window_ready 직후 같은 틱에 읽으면
// 아직 OS 에 적용 전이라 기본 크기를 읽는 레이스가 있다(검증함). 적용이 끝난 뒤 오는 Resized 에서
// outer_size 가 정확하므로 그때 보정한다. plugin() 의 doc 주석에 시점·수렴·한계를 정리.
//
// 등록 순서: lib.rs 에서 이 플러그인을 window-state "뒤에" 등록한다(현재는 이벤트 기반이라 순서
// 의존은 약하지만, 의미상 복원의 후처리이므로 뒤에 둔다).
//
// CLAUDE.md §1.3: 자동 재시도가 아니다. 창이 화면을 넘을 때만 1회 보정하고 수렴한다(무한 루프 없음).
// 실패해도 멈추지 않고 stderr 로그만 남긴다.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{PhysicalPosition, PhysicalSize, Runtime, Window, WindowEvent};

/// 보정 대상 창 라벨. tauri.conf.json 의 메인 창 라벨("main").
const MAIN_WINDOW_LABEL: &str = "main";

/// 물리 픽셀(physical pixel) 단위의 사각형. 위치(x, y)와 크기(w, h).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// 작업영역(`area`) 안에 창(`win`)이 완전히 보이도록 위치·크기를 보정한 사각형을 돌려준다.
/// 변경이 필요 없으면 입력 `win` 과 동일한 값을 반환한다.
///
/// 먼저 창 크기를 작업영역 크기로 제한(최소 1px)한 뒤, 그 크기 기준으로 오른쪽·아래 경계를 넘지
/// 않도록 당기고 왼쪽·위 경계에 맞춘다. 따라서 결과 창은 항상 작업영역 안에 완전히 포함된다.
/// 작업영역 크기가 비정상(0 이하)이면 보정 불가로 보고 `win` 을 그대로 반환한다.
pub fn clamp_rect(win: Rect, area: Rect) -> Rect {
    if area.w <= 0 || area.h <= 0 {
        return win;
    }
    // 크기를 [1, 작업영역] 으로 제한.
    let w = win.w.clamp(1, area.w);
    let h = win.h.clamp(1, area.h);
    // 위치를 [작업영역 시작, 작업영역 끝 - 크기] 으로 제한 (w <= area.w 이므로 max >= min 보장).
    let x = win.x.clamp(area.x, area.x + area.w - w);
    let y = win.y.clamp(area.y, area.y + area.h - h);
    Rect { x, y, w, h }
}

/// 메인 창을 현재(없으면 주) 모니터 작업영역 안으로 보정한다. 실패해도 앱은 계속 동작.
fn clamp_window<R: Runtime>(window: &Window<R>) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }

    // 최대화/전체화면/최소화 상태에서는 OS가 기하를 관리하므로 건드리지 않는다.
    // (보정하면 그 상태와 싸워 깜빡임이 생긴다.)
    if matches!(window.is_maximized(), Ok(true))
        || matches!(window.is_fullscreen(), Ok(true))
        || matches!(window.is_minimized(), Ok(true))
    {
        return;
    }

    // 현재 모니터 우선, 없으면 주 모니터. 둘 다 없으면 보정 불가 — 건드리지 않는다.
    let monitor = match window.current_monitor() {
        Ok(Some(m)) => m,
        _ => match window.primary_monitor() {
            Ok(Some(m)) => m,
            _ => {
                eprintln!("[window-clamp] 모니터 정보를 얻을 수 없어 창 보정을 건너뜀");
                return;
            }
        },
    };

    let size = match window.outer_size() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[window-clamp] outer_size 조회 실패: {e}");
            return;
        }
    };
    let pos = match window.outer_position() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[window-clamp] outer_position 조회 실패: {e}");
            return;
        }
    };

    let area = monitor.work_area();
    let win = Rect {
        x: pos.x,
        y: pos.y,
        w: size.width as i32,
        h: size.height as i32,
    };
    let fixed = clamp_rect(
        win,
        Rect {
            x: area.position.x,
            y: area.position.y,
            w: area.size.width as i32,
            h: area.size.height as i32,
        },
    );
    if fixed == win {
        return;
    }

    // 크기를 먼저 줄인 뒤 위치를 옮긴다 (크기 변경이 위치 계산에 영향을 주지 않도록).
    if fixed.w != win.w || fixed.h != win.h {
        if let Err(e) = window.set_size(PhysicalSize {
            width: fixed.w as u32,
            height: fixed.h as u32,
        }) {
            eprintln!("[window-clamp] set_size 실패: {e}");
        }
    }
    if fixed.x != win.x || fixed.y != win.y {
        if let Err(e) = window.set_position(PhysicalPosition {
            x: fixed.x,
            y: fixed.y,
        }) {
            eprintln!("[window-clamp] set_position 실패: {e}");
        }
    }
    eprintln!(
        "[window-clamp] 창이 화면 밖/과대 크기로 복원되어 보정: pos({},{}) size({}x{}) -> pos({},{}) size({}x{})",
        win.x, win.y, win.w, win.h, fixed.x, fixed.y, fixed.w, fixed.h
    );
}

/// window-state 플러그인 "뒤에" 등록해, 복원으로 적용된 크기가 화면을 넘으면 보정하는 플러그인.
///
/// 보정 시점은 `WindowEvent::Resized` 다. window-state 의 `set_size` 복원은 OS 가 실제로 적용한
/// "뒤에" Resized 가 발생하므로, 이때 `outer_size` 는 정확한 값을 돌려준다.
/// (on_window_ready 에서 즉시 읽으면 복원 set_size 가 아직 적용 전이라 기본 크기를 읽는 레이스가 있다.)
///
/// 수렴: 보정으로 set_size 하면 다시 Resized 가 오지만, 그땐 이미 작업영역 안이라 clamp 가 no-op →
/// 한 번에 멈춘다(무한 루프 없음).
///
/// 한계: 크기는 맞지만 위치만 화면을 일부 벗어난 경우는 다루지 않는다(Resized 가 안 옴). window-state
/// 가 위치 복원 시 모니터 교차를 요구하므로 실사용에서 위치만 완전히 벗어나는 경우는 드물다.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("window-clamp")
        .on_window_ready(|window| {
            window.clone().on_window_event(move |event| {
                if let WindowEvent::Resized(_) = event {
                    clamp_window(&window);
                }
            });
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::{clamp_rect, Rect};

    // 작업영역: 시작(0,0), 크기 1440x900 으로 고정한 기본 케이스 모음.
    const AREA: Rect = Rect {
        x: 0,
        y: 0,
        w: 1440,
        h: 900,
    };

    #[test]
    fn 완전히_안에_있으면_변경없음() {
        let win = Rect {
            x: 100,
            y: 100,
            w: 800,
            h: 600,
        };
        assert_eq!(clamp_rect(win, AREA), win);
    }

    #[test]
    fn 오른쪽_아래로_넘치면_끌어당김() {
        // (1000,700)에 800x600 → 오른쪽/아래가 작업영역 밖. 크기는 유지, 위치만 당김.
        let win = Rect {
            x: 1000,
            y: 700,
            w: 800,
            h: 600,
        };
        // 1440-800=640, 900-600=300
        assert_eq!(
            clamp_rect(win, AREA),
            Rect {
                x: 640,
                y: 300,
                w: 800,
                h: 600
            }
        );
    }

    #[test]
    fn 왼쪽_위로_넘치면_맞춤() {
        let win = Rect {
            x: -200,
            y: -100,
            w: 800,
            h: 600,
        };
        assert_eq!(
            clamp_rect(win, AREA),
            Rect {
                x: 0,
                y: 0,
                w: 800,
                h: 600
            }
        );
    }

    #[test]
    fn 크기가_작업영역보다_크면_줄이고_시작점에_붙임() {
        // 실제 버그 재현: 큰 디스플레이 좌표(150,872)+큰 크기(3170x2438)를 작은 화면에 복원.
        let win = Rect {
            x: 150,
            y: 872,
            w: 3170,
            h: 2438,
        };
        assert_eq!(
            clamp_rect(win, AREA),
            Rect {
                x: 0,
                y: 0,
                w: 1440,
                h: 900
            }
        );
    }

    #[test]
    fn 작업영역_원점이_음수여도_보정() {
        // 보조 모니터가 주 모니터 왼쪽에 있어 작업영역 x가 음수인 경우.
        let win = Rect {
            x: 0,
            y: 0,
            w: 800,
            h: 600,
        };
        let area = Rect {
            x: -1920,
            y: 0,
            w: 1920,
            h: 1080,
        };
        // 창이 작업영역(-1920..0) 밖(오른쪽)이므로 오른쪽 경계로 당김: x = -1920+1920-800 = -800.
        assert_eq!(
            clamp_rect(win, area),
            Rect {
                x: -800,
                y: 0,
                w: 800,
                h: 600
            }
        );
    }

    #[test]
    fn 작업영역_크기_비정상이면_원본유지() {
        let win = Rect {
            x: 150,
            y: 872,
            w: 3170,
            h: 2438,
        };
        let area = Rect {
            x: 0,
            y: 0,
            w: 0,
            h: 0,
        };
        assert_eq!(clamp_rect(win, area), win);
    }
}
