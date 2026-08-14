import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { Nas } from '../src/nas.js';

function makeNas() {
  const runner = vi.fn().mockResolvedValue({ code: 0, stdout: 'ok\n', stderr: '' });
  const nas = new Nas({ host: '192.168.1.100', port: 2222, user: 'admin', runner });
  return { nas, runner };
}

describe('Nas', () => {
  it('exec: ssh 인자 구성', async () => {
    const { nas, runner } = makeNas();
    const out = await nas.exec('echo hi');
    expect(out).toBe('ok\n');
    expect(runner).toHaveBeenCalledWith('ssh', ['-p', '2222', 'admin@192.168.1.100', 'echo hi'], undefined);
  });

  it('docker: sudo 절대경로 프리픽스', async () => {
    const { nas, runner } = makeNas();
    await nas.docker('ps');
    expect(runner.mock.calls[0][1][3]).toBe('sudo -n /usr/local/bin/docker ps');
  });

  it('exec: 비0 종료 시 stderr 포함 에러', async () => {
    const runner = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'denied' });
    const nas = new Nas({ host: 'h', port: 1, user: 'u', runner });
    await expect(nas.exec('x')).rejects.toThrow(/denied/);
  });

  it('transferDir: 비 latin1 바이트를 포함한 tar 스트림이 손상 없이 전달된다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hoster-nas-'));
    const payloadDir = join(root, 'payload');
    mkdirSync(payloadDir);

    // 0x80~0xFF 고바이트 바이너리 파일 + UTF-8 한글 파일명: latin1 왕복 시 손상되는 케이스
    const binaryBytes = Buffer.from(Array.from({ length: 128 }, (_, i) => 0x80 + i));
    writeFileSync(join(payloadDir, 'binary.dat'), binaryBytes);
    writeFileSync(join(payloadDir, '한글파일.txt'), 'utf-8 컨텐츠', 'utf-8');

    // tar 아카이브가 두 번의 실행 사이에 달라지지 않도록 mtime을 고정한다.
    const fixedTime = new Date('2024-01-01T00:00:00Z');
    utimesSync(join(payloadDir, 'binary.dat'), fixedTime, fixedTime);
    utimesSync(join(payloadDir, '한글파일.txt'), fixedTime, fixedTime);
    utimesSync(payloadDir, fixedTime, fixedTime);

    const parent = dirname(payloadDir);
    const name = basename(payloadDir);
    // transferDir과 동일한 조건(COPYFILE_DISABLE=1)으로 기준 아카이브를 만든다 —
      // 이 테스트가 검증하는 것은 바이트 무손실 전달이지 macOS 확장속성 동작이 아니다.
    const expectedTar = execFileSync('tar', ['-cf', '-', '-C', parent, name], {
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });

    let captured: Buffer | undefined;
    const runner = vi.fn(async (cmd: string, _args: string[], stdin?: Buffer) => {
      if (cmd !== 'ssh') throw new Error(`예상치 못한 명령: ${cmd}`);
      captured = stdin;
      return { code: 0, stdout: '', stderr: '' };
    });

    const nas = new Nas({ host: 'h', port: 22, user: 'u', runner });
    await nas.transferDir(payloadDir, '/remote/parent');

    expect(runner).toHaveBeenCalledTimes(1);
    expect(captured).toBeInstanceOf(Buffer);
    expect(captured!.equals(expectedTar)).toBe(true);
    // macOS AppleDouble 항목(`._binary.dat` 등)이 원격에 전송되지 않아야 한다.
    expect(captured!.includes(Buffer.from('._'))).toBe(false);
  });
});
