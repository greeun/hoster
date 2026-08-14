import { describe, it, expect, vi } from 'vitest';
import { Cloudflare } from '../src/cloudflare.js';

function fetchMock(responses: Array<{ url: RegExp; method?: string; body: unknown; status?: number; text?: string }>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const m = responses.find((r) => r.url.test(url) && (!r.method || r.method === method));
    if (!m) throw new Error(`unexpected ${method} ${url}`);
    if (m.text !== undefined) return new Response(m.text, { status: m.status ?? 200 });
    return new Response(JSON.stringify(m.body), { status: m.status ?? 200 });
  }) as unknown as typeof fetch;
}

const base = { apiToken: 't', accountId: 'acc', zoneId: 'zone' };

describe('Cloudflare', () => {
  it('createTunnel: 생성 + 토큰 조회', async () => {
    const f = fetchMock([
      { url: /cfd_tunnel$/, method: 'POST', body: { success: true, result: { id: 'tid' } } },
      { url: /cfd_tunnel\/tid\/token$/, body: { success: true, result: 'tok' } },
    ]);
    const cf = new Cloudflare({ ...base, fetchFn: f });
    expect(await cf.createTunnel('hoster')).toEqual({ id: 'tid', token: 'tok' });
  });

  it('getTunnelToken: 기존 터널 ID로 토큰만 조회한다 (재사용 경로)', async () => {
    const f = fetchMock([{ url: /cfd_tunnel\/existing-id\/token$/, body: { success: true, result: 'reused-token' } }]);
    const cf = new Cloudflare({ ...base, fetchFn: f });
    expect(await cf.getTunnelToken('existing-id')).toBe('reused-token');
  });

  it('findTunnelByName: name/is_deleted 필터로 조회하고 첫 결과를 반환한다', async () => {
    let seenUrl = '';
    const f = vi.fn(async (input: RequestInfo | URL) => {
      seenUrl = String(input);
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ id: 'tid', name: 'hoster', connections: [{ client_id: 'c1' }] }],
        })
      );
    }) as unknown as typeof fetch;
    const cf = new Cloudflare({ ...base, fetchFn: f });

    const found = await cf.findTunnelByName('hoster');

    expect(found).toEqual({ id: 'tid', name: 'hoster', connections: 1 });
    expect(seenUrl).toContain('/accounts/acc/cfd_tunnel?');
    expect(seenUrl).toContain('name=hoster');
    expect(seenUrl).toContain('is_deleted=false');
  });

  it('findTunnelByName: 결과가 없으면 undefined', async () => {
    const f = fetchMock([{ url: /cfd_tunnel\?/, body: { success: true, result: [] } }]);
    const cf = new Cloudflare({ ...base, fetchFn: f });
    expect(await cf.findTunnelByName('hoster')).toBeUndefined();
  });

  it('findTunnelByName: connections 필드가 없어도 0으로 다룬다', async () => {
    const f = fetchMock([{ url: /cfd_tunnel\?/, body: { success: true, result: [{ id: 'tid', name: 'hoster' }] } }]);
    const cf = new Cloudflare({ ...base, fetchFn: f });
    expect(await cf.findTunnelByName('hoster')).toEqual({ id: 'tid', name: 'hoster', connections: 0 });
  });

  it('deleteTunnel: 터널 ID로 DELETE 요청', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify({ success: true, result: {} }));
    }) as unknown as typeof fetch;
    const cf = new Cloudflare({ ...base, fetchFn: f });

    await cf.deleteTunnel('tid');

    expect(calls).toEqual([{ url: 'https://api.cloudflare.com/client/v4/accounts/acc/cfd_tunnel/tid', method: 'DELETE' }]);
  });

  it('setTunnelIngress: 404 폴백 규칙 추가', async () => {
    const f = fetchMock([{ url: /configurations$/, method: 'PUT', body: { success: true, result: {} } }]);
    const cf = new Cloudflare({ ...base, fetchFn: f });
    await cf.setTunnelIngress('tid', [{ hostname: 'hoster.example.com', service: 'http://hoster-deployer:8080' }]);
    const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sent = JSON.parse(call[1].body as string);
    expect(sent.config.ingress.at(-1)).toEqual({ service: 'http_status:404' });
  });

  it('upsertDnsCname: 없으면 POST', async () => {
    const f = fetchMock([
      { url: /dns_records\?/, method: 'GET', body: { success: true, result: [] } },
      { url: /dns_records$/, method: 'POST', body: { success: true, result: {} } },
    ]);
    const cf = new Cloudflare({ ...base, fetchFn: f });
    await cf.upsertDnsCname('demo.example.com', 'tid.cfargotunnel.com');
  });

  it('upsertDnsCname: 있으면 PUT', async () => {
    const f = fetchMock([
      { url: /dns_records\?/, method: 'GET', body: { success: true, result: [{ id: 'rec1' }] } },
      { url: /dns_records\/rec1$/, method: 'PUT', body: { success: true, result: {} } },
    ]);
    const cf = new Cloudflare({ ...base, fetchFn: f });
    await cf.upsertDnsCname('demo.example.com', 'tid.cfargotunnel.com');
    const putCall = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[1]?.method as string) === 'PUT'
    );
    expect(putCall).toBeDefined();
    const sent = JSON.parse(putCall![1].body as string);
    expect(sent).toMatchObject({ type: 'CNAME', name: 'demo.example.com', content: 'tid.cfargotunnel.com', proxied: true });
  });

  it('upsertDnsCname: 서버 측 exact name 필터를 사용해 페이지네이션과 무관하게 정확히 0/1건만 조회한다', async () => {
    // 같은 이름을 가진 레코드가 다른 "페이지"에 있다고 가정해도, name 필터 쿼리 파라미터를 붙여
    // 서버가 이미 좁혀준 결과만 받아야 한다. name 파라미터가 빠진 요청에는 다른(잘못된) 응답을
    // 주도록 만들어, 구현이 실제로 exact name 필터를 붙이는지 검증한다.
    let sawCorrectFilter = false;
    const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname.endsWith('/dns_records') && method === 'GET') {
        const type = url.searchParams.get('type');
        const name = url.searchParams.get('name') ?? url.searchParams.get('name.exact');
        if (type === 'CNAME' && name === 'demo.example.com') {
          sawCorrectFilter = true;
          // 서버가 이미 필터링했으므로 정확히 0/1건만 돌아온다.
          return new Response(JSON.stringify({ success: true, result: [{ id: 'rec-exact' }] }), { status: 200 });
        }
        // name 필터 없이(혹은 다른 값으로) 조회하면, 페이지 1에는 대상이 없는 것처럼 응답한다.
        // 클라이언트 측에서 이 페이지만 보고 "없음"으로 오판하면 실패한다.
        return new Response(
          JSON.stringify({
            success: true,
            result: [{ id: 'decoy-page1' }],
            result_info: { page: 1, per_page: 20, total_count: 2, total_pages: 2 },
          }),
          { status: 200 }
        );
      }
      if (url.pathname.endsWith('/dns_records/rec-exact') && method === 'PUT') {
        return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as unknown as typeof fetch;

    const cf = new Cloudflare({ ...base, fetchFn: f });
    await cf.upsertDnsCname('demo.example.com', 'tid.cfargotunnel.com');
    expect(sawCorrectFilter).toBe(true);

    const getCalls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[1]?.method ?? 'GET') === 'GET'
    );
    expect(getCalls).toHaveLength(1);
  });

  it('deleteDnsRecord: 있으면 DELETE, 없으면 무시', async () => {
    const f = fetchMock([
      { url: /dns_records\?/, method: 'GET', body: { success: true, result: [{ id: 'rec1' }] } },
      { url: /dns_records\/rec1$/, method: 'DELETE', body: { success: true, result: { id: 'rec1' } } },
    ]);
    const cf = new Cloudflare({ ...base, fetchFn: f });
    await cf.deleteDnsRecord('demo.example.com');

    const f2 = fetchMock([{ url: /dns_records\?/, method: 'GET', body: { success: true, result: [] } }]);
    const cf2 = new Cloudflare({ ...base, fetchFn: f2 });
    await expect(cf2.deleteDnsRecord('nope.example.com')).resolves.toBeUndefined();
  });

  // MUST-FIX 리뷰 지시: upsertDnsCname은 type=CNAME으로 조회하지만 deleteDnsRecord는 타입
  // 필터 없이 이름만으로 조회해 첫 번째로 매칭된 레코드(다른 타입일 수 있음)를 지웠다.
  // type 파라미터가 실제로 요청에 포함되는지 검증한다.
  it('deleteDnsRecord: type=CNAME으로 필터링해 조회하고, 그 레코드만 삭제한다', async () => {
    let sawTypeFilter = false;
    const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname.endsWith('/dns_records') && method === 'GET') {
        if (url.searchParams.get('type') === 'CNAME') {
          sawTypeFilter = true;
          return new Response(JSON.stringify({ success: true, result: [{ id: 'cname-rec' }] }), { status: 200 });
        }
        // type 파라미터 없이(버그 발생 시) 조회하면 다른 타입의 레코드가 섞인 것처럼 응답한다 —
        // 구현이 이 응답을 그대로 삭제 대상으로 쓰면 아래 DELETE 목(mock)이 없어 테스트가 실패한다.
        return new Response(JSON.stringify({ success: true, result: [{ id: 'other-type-rec' }] }), { status: 200 });
      }
      if (url.pathname.endsWith('/dns_records/cname-rec') && method === 'DELETE') {
        return new Response(JSON.stringify({ success: true, result: { id: 'cname-rec' } }), { status: 200 });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as unknown as typeof fetch;

    const cf = new Cloudflare({ ...base, fetchFn: f });
    await cf.deleteDnsRecord('demo.example.com');
    expect(sawTypeFilter).toBe(true);
  });

  it('API success:false면 에러', async () => {
    const f = fetchMock([
      { url: /cfd_tunnel$/, method: 'POST', body: { success: false, errors: [{ message: 'nope' }] } },
    ]);
    const cf = new Cloudflare({ ...base, fetchFn: f });
    await expect(cf.createTunnel('x')).rejects.toThrow(/nope/);
  });

  it('API 토큰은 에러 메시지에 노출되지 않는다', async () => {
    const f = fetchMock([
      { url: /cfd_tunnel$/, method: 'POST', body: { success: false, errors: [{ message: 'nope' }] } },
    ]);
    const cf = new Cloudflare({ apiToken: 'super-secret-token', accountId: 'acc', zoneId: 'zone', fetchFn: f });
    await expect(cf.createTunnel('x')).rejects.not.toThrow(/super-secret-token/);
  });

  it('비-JSON 에러 응답(예: 프록시의 HTML 502)은 JSON 파싱 예외 대신 명확한 Error를 던진다', async () => {
    const f = fetchMock([
      { url: /cfd_tunnel$/, method: 'POST', text: '<html><body>502 Bad Gateway</body></html>', status: 502 },
    ]);
    const cf = new Cloudflare({ ...base, fetchFn: f });
    await expect(cf.createTunnel('x')).rejects.toThrow(/502|Cloudflare/);
  });
});
