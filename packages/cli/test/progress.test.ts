import { describe, it, expect, vi } from 'vitest';
import { ProgressReporter, SPINNER_FRAMES, CLEAR_LINE, withSpinner } from '../src/progress.js';

// 타이머 없이 스피너 프레임 갱신을 제어하기 위한 가짜 티커.
function fakeTicker() {
  let cb: (() => void) | undefined;
  let stopped = false;
  return {
    start: (fn: () => void) => {
      cb = fn;
      stopped = false;
      return () => {
        stopped = true;
      };
    },
    tick: (n = 1) => {
      for (let i = 0; i < n; i++) cb?.();
    },
    get stopped() {
      return stopped;
    },
  };
}

function makeIo(isTty: boolean) {
  const writes: string[] = [];
  const logs: string[] = [];
  let clock = 0;
  const ticker = fakeTicker();
  const io = {
    write: (s: string) => writes.push(s),
    log: (s: string) => logs.push(s),
    isTty,
    now: () => clock,
    startTicker: ticker.start,
  };
  return { io, writes, logs, ticker, advance: (ms: number) => (clock += ms) };
}

describe('ProgressReporter — TTY', () => {
  it('start: 단계 번호와 라벨을 같은 줄에 스피너와 함께 출력한다', () => {
    const { io, writes, ticker } = makeIo(true);
    const p = new ProgressReporter(io, 12);

    p.start(3, 'stack 전송');
    ticker.tick();

    const last = writes[writes.length - 1];
    expect(last).toContain('[3/12]');
    expect(last).toContain('stack 전송');
    expect(last.startsWith('\r')).toBe(true);
    // 줄바꿈 없이 같은 줄을 갱신해야 한다.
    expect(writes.join('')).not.toContain('\n');
  });

  it('스피너 프레임이 tick마다 순환한다', () => {
    const { io, writes, ticker } = makeIo(true);
    const p = new ProgressReporter(io, 3);

    p.start(1, '작업');
    ticker.tick(3);

    const frames = writes.filter((w) => SPINNER_FRAMES.some((f) => w.includes(f)));
    const used = SPINNER_FRAMES.filter((f) => frames.some((w) => w.includes(f)));
    expect(used.length).toBeGreaterThan(1);
  });

  it('succeed: 경과 시간과 체크 표시로 줄을 마감한다', () => {
    const { io, writes, ticker, advance } = makeIo(true);
    const p = new ProgressReporter(io, 12);

    p.start(7, 'deployer 이미지 전송');
    advance(4200);
    p.succeed();

    const out = writes.join('');
    // 줄 지우기 시퀀스에 ESC가 실제로 포함되어야 한다 — 빠지면 "[2K"가 글자로 찍힌다.
    expect(out).toContain(CLEAR_LINE);
    expect(CLEAR_LINE).toBe('\r\x1b[2K');
    expect(out).toContain('✓');
    expect(out).toContain('[7/12]');
    expect(out).toContain('4.2초');
    expect(out.endsWith('\n')).toBe(true);
    expect(ticker.stopped).toBe(true);
  });

  it('fail: 실패 표시로 마감하고 티커를 멈춘다', () => {
    const { io, writes, ticker } = makeIo(true);
    const p = new ProgressReporter(io, 12);

    p.start(2, '연결 확인');
    p.fail();

    expect(writes.join('')).toContain('✗');
    expect(ticker.stopped).toBe(true);
  });

  it('note: 재시도 같은 부가 정보를 같은 줄에 덧붙인다', () => {
    const { io, writes, ticker, advance } = makeIo(true);
    const p = new ProgressReporter(io, 12);

    p.start(12, 'healthz 확인');
    p.note('재시도 2/6');
    advance(18_000);
    ticker.tick();

    const last = writes[writes.length - 1];
    expect(last).toContain('재시도 2/6');
    expect(last).toContain('18.0초');
  });

  it('pause: 프롬프트 중에는 스피너를 멈추고 줄을 비운다', () => {
    const { io, writes, ticker } = makeIo(true);
    const p = new ProgressReporter(io, 12);

    p.start(3, '터널 생성');
    p.pause();

    expect(ticker.stopped).toBe(true);
    // 입력 줄과 겹치지 않도록 현재 줄을 지워야 한다.
    expect(writes[writes.length - 1]).toMatch(/^\r\s*\r?$|\[2K/);

    const before = writes.length;
    p.resume();
    ticker.tick();
    expect(writes.length).toBeGreaterThan(before);
  });
});

describe('withSpinner', () => {
  it('단일 대기 구간을 감싸고 결과를 그대로 돌려준다', async () => {
    const { io, logs } = makeIo(false);

    const result = await withSpinner('롤백 중', async () => 'done', io);

    expect(result).toBe('done');
    // 단계 번호가 없는 대기 구간이므로 [n/m] 접두사를 붙이지 않는다.
    expect(logs.join('\n')).not.toMatch(/\[\d+\/\d+\]/);
    expect(logs[0]).toContain('롤백 중');
    expect(logs[logs.length - 1]).toContain('✓');
  });

  it('실패하면 실패 표시 후 예외를 그대로 전파한다', async () => {
    const { io, logs } = makeIo(false);

    await expect(
      withSpinner('배포 중', async () => {
        throw new Error('boom');
      }, io)
    ).rejects.toThrow('boom');

    expect(logs.join('\n')).toContain('✗');
  });

  it('TTY에서는 스피너를 돌리고 완료 시 줄을 마감한다', async () => {
    const { io, writes, ticker } = makeIo(true);

    const p = withSpinner('대기', async () => {
      ticker.tick(2);
      return 1;
    }, io);
    await p;

    expect(writes.join('')).toContain('대기');
    expect(writes.join('')).toContain('✓');
    expect(ticker.stopped).toBe(true);
  });
});

describe('ProgressReporter — 비-TTY', () => {
  it('스피너를 쓰지 않고 시작/완료를 한 줄씩만 남긴다', () => {
    const { io, writes, logs, advance } = makeIo(false);
    const p = new ProgressReporter(io, 12);

    p.start(5, 'DNS 설정');
    advance(1500);
    p.succeed();

    expect(writes).toEqual([]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain('[5/12] DNS 설정');
    expect(logs[1]).toContain('1.5초');
  });

  it('note도 줄 단위로 남긴다', () => {
    const { io, logs } = makeIo(false);
    const p = new ProgressReporter(io, 12);

    p.start(12, 'healthz 확인');
    p.note('재시도 3/6');

    expect(logs.some((l) => l.includes('재시도 3/6'))).toBe(true);
  });

  it('티커를 시작하지 않는다', () => {
    const startTicker = vi.fn(() => () => {});
    const p = new ProgressReporter(
      { write: () => {}, log: () => {}, isTty: false, now: () => 0, startTicker },
      3
    );
    p.start(1, '작업');
    expect(startTicker).not.toHaveBeenCalled();
  });
});
