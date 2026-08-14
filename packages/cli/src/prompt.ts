import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

// 토큰/시크릿 입력용 — 터미널에 echo 하지 않는다.
export async function askHidden(question: string): Promise<string> {
  stdout.write(question);
  stdin.setRawMode?.(true);
  return new Promise((resolve) => {
    let buf = '';
    const onData = (ch: Buffer) => {
      const s = ch.toString('utf-8');
      if (s === '\n' || s === '\r') {
        stdin.setRawMode?.(false);
        stdin.off('data', onData);
        stdin.pause();
        stdout.write('\n');
        resolve(buf.trim());
      } else if (s === '') {
        // Ctrl+C: 원본 브리핑의 `else if (s === '')`는 첫 조건과 겹쳐 도달 불가능한
        // 죽은 분기였다 — 사용자가 취소할 수 있도록 Ctrl+C(ETX)를 감지하도록 수정.
        stdin.setRawMode?.(false);
        stdin.off('data', onData);
        stdin.pause();
        stdout.write('\n');
        process.exit(1);
      } else {
        buf += s;
      }
    };
    stdin.resume();
    stdin.on('data', onData);
  });
}
