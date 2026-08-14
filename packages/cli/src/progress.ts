export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/**
 * 커서를 줄 맨 앞으로 되돌리고 그 줄을 지운다. ESC를 `\x1b` 이스케이프로 적는다 —
 * 소스에 제어문자를 그대로 넣으면 편집기/도구를 거치며 깨질 수 있고, 빠뜨리면 화면에
 * "[2K"라는 글자가 그대로 찍힌다.
 */
export const CLEAR_LINE = '\r\x1b[2K';

const FRAME_INTERVAL_MS = 100;

export interface ProgressIo {
  /** 같은 줄을 갱신하는 원시 출력 (TTY 전용). */
  write: (s: string) => void;
  /** 줄 단위 출력. 비-TTY에서는 이것만 사용한다. */
  log: (s: string) => void;
  isTty: boolean;
  now: () => number;
  /** 주기 실행을 시작하고 중지 함수를 돌려준다 — 테스트에서 타이머 없이 제어하기 위해 주입한다. */
  startTicker: (fn: () => void, intervalMs: number) => () => void;
}

export function defaultProgressIo(): ProgressIo {
  return {
    write: (s) => process.stdout.write(s),
    log: (s) => console.log(s),
    isTty: Boolean(process.stdout.isTTY),
    now: () => Date.now(),
    startTicker: (fn, intervalMs) => {
      const t = setInterval(fn, intervalMs);
      // 스피너 타이머가 프로세스 종료를 막지 않도록 한다.
      if (typeof t.unref === 'function') t.unref();
      return () => clearInterval(t);
    },
  };
}

/**
 * 오래 걸리는 단계의 진행 상황을 보여준다. TTY에서는 한 줄을 스피너와 경과 시간으로
 * 갱신하고, 파이프/CI에서는 시작·완료를 한 줄씩 남긴다(제어 문자를 섞지 않는다).
 */
export class ProgressReporter {
  private io: ProgressIo;
  private total: number;
  private frame = 0;
  private startedAt = 0;
  private step = 0;
  private label = '';
  private extra = '';
  private stopTicker?: () => void;

  constructor(io: ProgressIo, total: number) {
    this.io = io;
    this.total = total;
  }

  start(step: number, label: string): void {
    this.step = step;
    this.label = label;
    this.extra = '';
    this.frame = 0;
    this.startedAt = this.io.now();

    if (!this.io.isTty) {
      this.io.log(`${this.prefix()}${label}…`);
      return;
    }
    this.render();
    this.startSpinner();
  }

  /** 재시도 횟수처럼 진행 중 바뀌는 정보를 덧붙인다. */
  note(text: string): void {
    this.extra = text;
    if (!this.io.isTty) {
      this.io.log(`${this.prefix()}${this.label} — ${text}`);
      return;
    }
    this.render();
  }

  succeed(): void {
    this.finish('✓');
  }

  fail(): void {
    this.finish('✗');
  }

  /** 사용자 입력을 받는 동안 스피너를 멈추고 줄을 비운다 — 프롬프트와 겹치지 않게. */
  pause(): void {
    this.stopSpinner();
    if (this.io.isTty) this.io.write(CLEAR_LINE);
  }

  resume(): void {
    if (!this.io.isTty) return;
    this.render();
    this.startSpinner();
  }

  private finish(mark: string): void {
    this.stopSpinner();
    const line = `${mark} ${this.prefix()}${this.label} ${this.elapsed()}`;
    if (!this.io.isTty) {
      this.io.log(line);
      return;
    }
    this.io.write(`${CLEAR_LINE}${line}\n`);
  }

  private startSpinner(): void {
    this.stopTicker = this.io.startTicker(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, FRAME_INTERVAL_MS);
  }

  private stopSpinner(): void {
    this.stopTicker?.();
    this.stopTicker = undefined;
  }

  private render(): void {
    const spin = SPINNER_FRAMES[this.frame];
    const extra = this.extra ? ` — ${this.extra}` : '';
    this.io.write(`${CLEAR_LINE}${spin} ${this.prefix()}${this.label}${extra} ${this.elapsed()}`);
  }

  // 단계 번호가 없는 단일 대기 구간(total 0)에서는 접두사를 붙이지 않는다.
  private prefix(): string {
    return this.total > 0 ? `[${this.step}/${this.total}] ` : '';
  }

  private elapsed(): string {
    return `${((this.io.now() - this.startedAt) / 1000).toFixed(1)}초`;
  }
}

/**
 * 단계 번호가 없는 단일 대기 구간을 감싼다 — deployer 헬스체크(최대 60초)처럼
 * 응답을 기다리는 동안 화면이 멈춘 것처럼 보이는 커맨드에 쓴다.
 * 실패해도 표시만 남기고 예외는 그대로 전파한다.
 */
export async function withSpinner<T>(
  label: string,
  fn: () => Promise<T>,
  io: ProgressIo = defaultProgressIo()
): Promise<T> {
  const reporter = new ProgressReporter(io, 0);
  reporter.start(0, label);
  try {
    const result = await fn();
    reporter.succeed();
    return result;
  } catch (e) {
    reporter.fail();
    throw e;
  }
}
