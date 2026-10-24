'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../static/manage.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../static/manage.js'), 'utf8');
const incidentId = '7e4af80c-51ce-4c18-a18b-fc825fc05776';
const admin = {username: 'admin01', role: 'admin'};
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }

class Element {
  constructor(tag = 'div', hidden = false) {
    this.tagName = tag; this.hidden = hidden; this.children = [];
    this.textContent = ''; this.value = ''; this.disabled = false;
    this.classList = {toggle() {}};
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  querySelectorAll(tag) {
    return this.children.flatMap(child => child instanceof Element
      ? [...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)] : []);
  }
}

function boot(url = '/', options = {}) {
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    elements.set(match[3], new Element(match[1], /\bhidden\b/.test(match[2])));
  }
  const location = new URL(url, 'http://localhost:18001');
  const calls = [];
  let signedIn = options.signedIn !== false;
  let contextCalls = 0;
  const response = body => ({ok: true, status: 200,
    headers: {get: () => 'application/json'}, json: async () => body});
  async function fetch(resource) {
    calls.push(resource);
    if (resource === '/api/auth/context') {
      contextCalls++;
      if (options.context && contextCalls === 1) return options.context;
      if (options.failOnce && contextCalls === 1) throw new Error('offline');
      return response({csrf_token: 'csrf', user: signedIn ? admin : null});
    }
    if (resource === '/api/auth/logout') { signedIn = false; return response({ok: true}); }
    if (resource === '/api/auth/login') { signedIn = true; return response({csrf_token: 'new-csrf', user: admin}); }
    if (resource.startsWith('/api/incidents?')) return response({total: 60, items: [{
      id: incidentId, rule_id: 'login_failures', target_id: 'portal-login',
      status: 'closed', detected_at: '2026-10-24T00:00:00Z'
    }]});
    if (resource.startsWith('/api/incidents/')) return response({
      id: incidentId, rule_id: 'login_failures', target_id: 'portal-login',
      status: 'closed', jobs: [], evidence: [], actions: [], closure: {reasons: []}
    });
    if (resource === '/api/dashboard') return response({
      as_of: '2026-10-24T00:00:00Z', servers: [],
      incident_counts: {new: 0, accepted: 0, in_progress: 0, closed: 0}
    });
    if (resource.startsWith('/api/observability?')) return response({
      window_minutes: {'15m':15,'1h':60,'6h':360,'24h':1440}[new URL(resource, location).searchParams.get('window')],
      step_seconds: 30,
      as_of: '2026-10-24T00:00:00Z',
      metrics: Object.fromEntries(['requests', 'errors', 'app_ms', 'db_ms'].map(k => [k, {status: 'no_data'}])),
      details: Object.fromEntries(['app_routes','app_p95_routes','proxy_requests','proxy_errors','proxy_p95','upstream_p95']
        .map(k => [k, {status: 'ok', items: [{route: '/health', value: 2, points: [[Date.parse('2026-10-24T00:00:00Z'), 2]]}]}])),
      alerts: {status: 'ok', items: [{name: 'PortalProbeFailed', severity: 'critical'}]},
      targets: {status: 'ok', items: [{job: 'ec2-node', instance: 'service:9100', up: true}]},
      resources: {items: [{instance:'service:9100',status:'ok',cpu:30,memory:40,disk:50,history:
        Object.fromEntries(['cpu','memory','disk'].map(k=>[k,{status:'ok',value:30,
          points:[[Date.parse('2026-10-24T00:00:00Z'),30]],summary:{mean:25,max:30,samples:2}}]))}]}, logs: {'portal-nginx': {status: 'ok', items: []}, 'portal-api': {status: 'ok', items: []}}
    });
    throw new Error('unexpected request: ' + resource);
  }
  vm.runInNewContext(script, {
    document: {getElementById: id => elements.get(id),
      createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag)},
    fetch, location, history: {replaceState: (_, __, value) => { location.href = new URL(value, location).href; }},
    URLSearchParams, AbortController, setTimeout, clearTimeout, window: {}, console
  });
  return {get: id => elements.get(id), calls, location, response};
}

test('인증 확인이 끝나기 전에는 로그인 화면과 업무 화면을 표시하지 않는다', async () => {
  let resolve;
  const context = new Promise(done => { resolve = done; });
  const app = boot('/', {context});
  assert.equal(app.get('login').hidden, true);
  assert.equal(app.get('workspace').hidden, true);
  assert.equal(app.get('session-loading').hidden, false);
  resolve(app.response({csrf_token: 'csrf', user: admin}));
  await settle();
  assert.equal(app.get('login').hidden, true);
  assert.equal(app.get('workspace').hidden, false);
  assert.equal(app.get('session-loading').hidden, true);
});

test('경보·수집 대상·경로별 프록시 지표를 관리자 화면에 표시한다', async () => {
  const app = boot('/');
  await settle();
  assert.ok(app.calls.includes('/api/observability?window=15m'));
  assert.equal(app.get('detail-metrics').children.length, 6, app.get('metrics-time').textContent);
  assert.ok(app.get('alert-target-status').children.some(row =>
    row.textContent.includes('PortalProbeFailed')));
  assert.ok(app.get('alert-target-status').children.some(row =>
    row.textContent.includes('ec2-node')));
});

test('새로고침 후 처리 이력의 페이지를 URL에서 복원한다', async () => {
  const app = boot('/?view=closed&page=3');
  await settle();
  assert.ok(app.calls.includes('/api/incidents?status=closed&page=3'));
  assert.equal(app.get('title').textContent, '처리 이력');
  assert.equal(app.location.search, '?view=closed&page=3');
  assert.ok(!app.calls.includes('/api/dashboard'));
});

test('상세 진입 후 새로고침해도 사건과 원래 목록 페이지를 유지한다', async () => {
  const app = boot('/?view=closed&page=3');
  await settle();
  app.get('list').querySelectorAll('button').find(b => b.textContent === '상세 보기').onclick();
  await settle();
  assert.equal(app.location.pathname, '/incidents/' + incidentId);
  const reloaded = boot(app.location.href);
  await settle();
  assert.ok(reloaded.calls.includes('/api/incidents/' + incidentId));
  assert.equal(reloaded.get('title').textContent, '사건 상세');
  reloaded.get('detail').querySelectorAll('button').find(b => b.textContent === '목록으로').onclick();
  await settle();
  assert.ok(reloaded.calls.includes('/api/incidents?status=closed&page=3'));
});

test('비로그인 상태에는 인증 확인 후 로그인 화면을 표시한다', async () => {
  const app = boot('/', {signedIn: false});
  await settle();
  assert.equal(app.get('login').hidden, false);
  assert.equal(app.get('workspace').hidden, true);
  assert.equal(app.get('session-loading').hidden, true);
  assert.deepEqual(app.calls, ['/api/auth/context']);
});

test('연결 실패를 로그아웃으로 오인하지 않고 재시도로 세션을 복원한다', async () => {
  const app = boot('/?view=closed&page=2', {failOnce: true});
  await settle();
  assert.equal(app.get('login').hidden, true);
  assert.equal(app.get('workspace').hidden, true);
  assert.equal(app.get('session-retry').hidden, false);
  await app.get('session-retry').onclick();
  await settle();
  assert.equal(app.get('workspace').hidden, false);
  assert.equal(app.get('session-loading').hidden, true);
  assert.ok(app.calls.includes('/api/incidents?status=closed&page=2'));
});

test('잘못된 페이지 값은 기본 페이지로 복원한다', async () => {
  const app = boot('/?view=closed&page=-1');
  await settle();
  assert.ok(app.calls.includes('/api/incidents?status=closed&page=1'));
  assert.equal(app.location.search, '?view=closed');
});

test('로그아웃은 상세 URL을 초기화하고 로그인 화면으로 전환한다', async () => {
  const app = boot('/incidents/' + incidentId + '?view=closed&page=2');
  await settle();
  await app.get('logout').onclick();
  await settle();
  assert.equal(app.get('login').hidden, false);
  assert.equal(app.get('workspace').hidden, true);
  assert.equal(app.location.pathname, '/');
  assert.equal(app.location.search, '');
});


test('조회 기간을 변경하면 API와 URL에 같은 기간을 적용한다', async () => {
 const app=boot('/');await settle();
 app.get('metric-window').value='6h';app.get('metric-window').onchange();await settle();
 assert.ok(app.calls.includes('/api/observability?window=6h'));
 assert.equal(app.location.search,'?window=6h');
 assert.ok(app.get('metrics-time').textContent.includes('간격 표본'));
 const reload=boot(app.location.href);await settle();
 assert.equal(reload.get('metric-window').value,'6h');
 assert.ok(reload.calls.includes('/api/observability?window=6h'));
});
test('허용하지 않는 조회 기간은 기본값으로 복원한다', async () => {
 const app=boot('/?window=unbounded');await settle();
 assert.equal(app.get('metric-window').value,'15m');
 assert.ok(app.calls.includes('/api/observability?window=15m'));
 assert.equal(app.location.search,'');
});

test('서버 자원 추이와 표본 요약을 함께 표시한다', async () => {
 const app=boot('/');await settle();
 const resources=app.get('resources');
 assert.equal(resources.querySelectorAll('svg').length,3);
 assert.ok(resources.querySelectorAll('small').some(x=>x.textContent.includes('표본 평균')));
});
