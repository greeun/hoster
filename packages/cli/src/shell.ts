// NAS(ssh 원격 셸)나 로컬 셸(`sh -c`)로 전달되는 명령 문자열에 사용자 입력/시크릿을
// 안전하게 삽입하기 위한 헬퍼. Nas.exec/docker는 remoteCmd를 셸 인자로 그대로 넘기므로
// 호출부(commands/init.ts)에서 보간되는 모든 값은 반드시 이 헬퍼를 거쳐야 한다.

// POSIX 셸 표준 기법: 작은따옴표로 감싸고, 값에 포함된 작은따옴표는
// `'\''`(닫는 따옴표 + 이스케이프된 리터럴 따옴표 + 여는 따옴표)로 치환한다.
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// 명령 템플릿(`${KEY}` 형태의 플레이스홀더 포함)에 실제 값을 안전하게 치환한다.
// String.replaceAll(문자열, 문자열)은 교체 문자열에 `$&`, `$$` 등이 있으면 특수 패턴으로
// 해석하므로, 시크릿 값에 `$`가 포함될 가능성을 배제할 수 없어 split/join으로 치환한다.
export function substitutePlaceholders(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, val] of Object.entries(values)) {
    out = out.split(`\${${key}}`).join(shQuote(val));
  }
  return out;
}
