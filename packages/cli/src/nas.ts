import { execFile } from 'node:child_process';
import { basename, dirname } from 'node:path';

type Runner = (
  cmd: string,
  args: string[],
  stdin?: Buffer
) => Promise<{ code: number; stdout: string; stderr: string }>;

// 로컬 tar 생성처럼 원시 바이트 보존이 필요한 경로 전용 러너.
// stdout을 문자열로 왕복시키면(특히 latin1 변환) 0x80 이상 바이트가 손상되므로 Buffer로 직접 받는다.
type BufferRunner = (
  cmd: string,
  args: string[],
  stdin?: Buffer
) => Promise<{ code: number; stdout: Buffer; stderr: string }>;

function exitCodeOf(err: (Error & { code?: unknown }) | null): number {
  if (!err) return 0;
  return typeof err.code === 'number' ? err.code : 1;
}

const defaultRunner: Runner = (cmd, args, stdin) =>
  new Promise((resolve) => {
    const child = execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: exitCodeOf(err), stdout, stderr });
    });
    if (stdin && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });

const defaultBufferRunner: BufferRunner = (cmd, args, stdin) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
        // macOS bsdtar는 확장속성을 별도 AppleDouble 항목(`._<파일명>`)으로 아카이브에 넣는다.
        // 그대로 전송하면 NAS 스택 디렉터리에 쓰레기 파일이 남으므로 생성 자체를 막는다.
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      },
      (err, stdout, stderr) => {
        resolve({ code: exitCodeOf(err), stdout, stderr: stderr.toString('utf-8') });
      }
    );
    if (stdin && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });

export class Nas {
  private host: string;
  private port: number;
  private user: string;
  private runner: Runner;
  private bufferRunner: BufferRunner;

  constructor(opts: {
    host: string;
    port: number;
    user: string;
    runner?: Runner;
    bufferRunner?: BufferRunner;
  }) {
    this.host = opts.host;
    this.port = opts.port;
    this.user = opts.user;
    this.runner = opts.runner ?? defaultRunner;
    this.bufferRunner = opts.bufferRunner ?? defaultBufferRunner;
  }

  async exec(remoteCmd: string, stdin?: Buffer): Promise<string> {
    const r = await this.runner('ssh', ['-p', String(this.port), `${this.user}@${this.host}`, remoteCmd], stdin);
    if (r.code !== 0) throw new Error(`ssh 실패 (${r.code}): ${r.stderr || r.stdout}`);
    return r.stdout;
  }

  async docker(args: string): Promise<string> {
    return this.exec(`sudo -n /usr/local/bin/docker ${args}`);
  }

  async transferDir(localDir: string, remoteParent: string): Promise<void> {
    const parent = dirname(localDir);
    const name = basename(localDir);
    const tar = await this.bufferRunner('tar', ['-cf', '-', '-C', parent, name]);
    if (tar.code !== 0) throw new Error(`tar 실패: ${tar.stderr}`);
    // tar.stdout은 이미 Buffer이므로 문자열 경유 없이 그대로 전달한다.
    await this.exec(`tar -C ${remoteParent} -xf -`, tar.stdout);
  }
}
