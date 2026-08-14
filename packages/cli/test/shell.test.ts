import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shQuote, substitutePlaceholders } from '../src/shell.js';

describe('shQuote', () => {
  it('일반 값은 작은따옴표로 감싼다', () => {
    expect(shQuote('hello')).toBe("'hello'");
  });

  it('작은따옴표가 포함된 값을 안전하게 이스케이프한다', () => {
    expect(shQuote(`it's`)).toBe(`'it'\\''s'`);
  });

  // CARRY-OVER (Task 10 리뷰): Nas.exec/docker는 remoteCmd를 셸 이스케이프 없이 그대로
  // ssh에 전달한다. 이 테스트는 악성 값(따옴표+세미콜론 포함)이 shQuote를 거치면
  // "리터럴 인자 하나"로만 전달되고, 별도 명령으로 실행되지 않음을 실제 셸(`sh -c`)로 증명한다.
  it('악성 값이 리터럴 인자로 전달되고 별도 명령으로 실행되지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoster-shquote-'));
    const marker = join(dir, 'injected');
    const malicious = `x'; touch ${marker}; echo '`;

    const cmd = `printf '%s' ${shQuote(malicious)}`;
    const out = execFileSync('sh', ['-c', cmd], { encoding: 'utf-8' });

    // 1) 값이 손상 없이 리터럴로 왕복한다 (원격 셸이 이 문자열을 그대로 데이터로 받는다는 증거)
    expect(out).toBe(malicious);
    // 2) 삽입된 `touch` 명령이 별도로 실행되지 않았다 (인젝션 실패 증명)
    expect(existsSync(marker)).toBe(false);
  });

  it('빈 문자열도 안전하게 처리한다', () => {
    const out = execFileSync('sh', ['-c', `printf '%s' ${shQuote('')}`], { encoding: 'utf-8' });
    expect(out).toBe('');
  });
});

describe('substitutePlaceholders', () => {
  it('플레이스홀더를 shQuote된 값으로 치환한다', () => {
    const out = substitutePlaceholders('echo ${HMAC_SECRET}', { HMAC_SECRET: 'abc' });
    expect(out).toBe("echo 'abc'");
  });

  it('값에 $가 포함되어도 다른 자리표시자를 오염시키지 않는다 (replaceAll 특수패턴 회피)', () => {
    const out = substitutePlaceholders('${A} ${B}', { A: '$&weird$$', B: 'plain' });
    expect(out).toBe("'$&weird$$' 'plain'");
  });

  it('여러 플레이스홀더를 모두 치환한다', () => {
    const out = substitutePlaceholders('${A}-${B}-${A}', { A: '1', B: '2' });
    expect(out).toBe("'1'-'2'-'1'");
  });
});
