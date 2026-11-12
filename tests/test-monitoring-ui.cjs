'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'static/schutz-ui/index.html'),'utf8');
const code=fs.readFileSync(path.join(root,'static/schutz-ui/app.js'),'utf8');
const contextCode=fs.readFileSync(path.join(root,'static/schutz-ui/incident-context.js'),'utf8');
const snapshot=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/monitoring-ui.json'),'utf8'));
snapshot.observability.resources.items[0].server_role='service';
const settle=async()=>{for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r))};
class El{
 constructor(tag='div'){this.tagName=tag;this.children=[];this.parentNode=null;this.attrs={};this.hidden=false;this.disabled=false;this.value='';this.open=false;this.handlers={}}
 get id(){return this.attrs.id||''}set id(v){this.attrs.id=String(v)}
 get form(){let p=this.parentNode;while(p&&p.tagName!=='form')p=p.parentNode;return p}
 get isConnected(){let p=this;while(p.parentNode)p=p.parentNode;return p.tagName==='document'}
 focus(){let p=this;while(p.parentNode)p=p.parentNode;p.activeElement=this}
 select(){this.selected=true}
 insertBefore(child,before){child.remove();child.parentNode=this;this.children.splice(this.children.indexOf(before),0,child)}
 dispatchEvent(e){this.dispatch(e.type)}
 get textContent(){return this.children.map(c=>typeof c==='string'?c:c.textContent).join('')}
 set textContent(v){this.children=[String(v??'')]}
 append(...children){for(const c of children){if(c instanceof El){c.remove();c.parentNode=this}this.children.push(c)}}
 prepend(...children){for(const c of [...children].reverse()){if(c instanceof El){c.remove();c.parentNode=this}this.children.unshift(c)}}
 remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(c=>c!==this);this.parentNode=null}}
 replaceWith(node){const parent=this.parentNode;if(!parent)return;parent.insertBefore(node,this);this.remove()}
 replaceChildren(...children){this.children=[];this.append(...children)}
 after(...children){const p=this.parentNode;if(!p)return;const i=p.children.indexOf(this);for(const c of children){if(c instanceof El){c.remove();c.parentNode=p}}p.children.splice(i+1,0,...children)}
 setAttribute(k,v){this.attrs[k]=String(v);if(k==='hidden')this.hidden=true}
 getAttribute(k){return this.attrs[k]??null}
 get dataset(){const data={};for(const[k,v]of Object.entries(this.attrs))if(k.startsWith('data-'))data[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v;return new Proxy(data,{set:(o,k,v)=>{o[k]=v;this.attrs['data-'+k.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())]=String(v);return true}})}
 get classList(){return {add:(...cs)=>{this.attrs.class=[...new Set([...this.classes(),...cs])].join(' ')},remove:c=>{this.attrs.class=this.classes().filter(x=>x!==c).join(' ')},toggle:(c,on)=>{on=on??!this.classes().includes(c);this.attrs.class=[...this.classes().filter(x=>x!==c),...(on?[c]:[])].join(' ')},contains:c=>this.classes().includes(c)}}
 classes(){return (this.attrs.class||'').split(/\s+/).filter(Boolean)}
 set className(v){this.attrs.class=v}get className(){return this.attrs.class||''}
 descendants(){return this.children.filter(x=>x instanceof El).flatMap(x=>[x,...x.descendants()])}
 querySelectorAll(s){return this.descendants().filter(e=>matches(e,s))}
 querySelector(s){return this.querySelectorAll(s)[0]||null}
 set innerHTML(s){this.children=[];const fragment=parse(s);for(const c of [...fragment.children])this.append(c)}
 addEventListener(k,fn){(this.handlers[k]??=[]).push(fn)}
 dispatch(k){if(this.disabled&&k==='click')return;const e={preventDefault(){},target:this,key:'Enter'};this['on'+k]?.(e);for(const fn of this.handlers[k]||[])fn(e)}
 contains(other){return other===this||this.descendants().includes(other)}
 showModal(){this.open=true}close(){this.open=false}requestSubmit(){this.onsubmit?.({preventDefault(){}})}
}
function simple(e,s){if(!(e instanceof El))return false;const nth=s.match(/:nth-child\((\d+)\)/);if(nth){const siblings=e.parentNode.children.filter(c=>c instanceof El);if(siblings.indexOf(e)!==Number(nth[1])-1)return false;s=s.replace(nth[0],'')}if(s.endsWith(':last-child')){if(e.parentNode.children.filter(x=>x instanceof El).at(-1)!==e)return false;s=s.replace(':last-child','')}const id=s.match(/#([\w-]+)/);if(id&&e.attrs.id!==id[1])return false;for(const c of s.matchAll(/\.([\w-]+)/g))if(!e.classes().includes(c[1]))return false;const tag=s.match(/^[\w-]+/);return !tag||tag[0]===e.tagName}
function matches(e,s){const tokens=s.replace(/>/g,' > ').trim().split(/\s+/);let i=tokens.length-1,node=e;if(!simple(node,tokens[i--]))return false;while(i>=0){if(tokens[i]==='>'){node=node.parentNode;if(!simple(node,tokens[--i]))return false;i--}else{node=node.parentNode;while(node&&!simple(node,tokens[i]))node=node.parentNode;if(!node)return false;i--}}return true}
function parse(s){const root=new El('document'),stack=[root];for(const token of s.match(/<[^>]*>|[^<]+/g)||[]){if(token.startsWith('<!'))continue;if(token.startsWith('</')){if(stack.length>1)stack.pop();continue}if(token.startsWith('<')){const tag=token.match(/^<([\w-]+)/)?.[1];if(!tag)continue;const e=new El(tag);for(const a of token.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)){if(a[1]===tag)continue;e.setAttribute(a[1],a[2]??'')}stack.at(-1).append(e);if(!/\/>$/.test(token)&&!['meta','link','img','input','br','hr'].includes(tag))stack.push(e)}else stack.at(-1).append(token)}return root}
function boot(options={}){const doc=parse(html);doc.getElementById=id=>doc.querySelector('#'+id);doc.createElement=t=>new El(t);doc.createElementNS=(_,t)=>new El(t);const calls=[];const location=new URL('http://127.0.0.1:18701/'+(options.hash||''));let signed=options.signed!==false,incidentStatus=options.incidentStatus||'closed';const id=snapshot.incidents[0].id;
const detail=()=>({...snapshot.incidents[0],monitoring:options.monitoring,target_display:options.monitoring?'수집 대상 경보':undefined,status:incidentStatus,jobs:snapshot.incidents[0].jobs.map(j=>({...j,attempts:1,history:[],mode:'live'})),evidence:[],actions:[],closure:{reasons:[],eligible:true},...options.detail});
const response=(body,status=200)=>({ok:status<400,status,json:async()=>body});
async function fetch(p,opts={}){calls.push({path:p,opts});if(p==='/local/status')return options.production?response({},404):response({mode:'live',writes_enabled:options.writes??false});if(p==='/api/management/capabilities'){if(options.capabilityOffline)return response({},503);return response({mode:'live',writes_enabled:options.serverWrites!==false})}if(p==='/api/auth/context')return response({user:signed?{username:'admin01',role:'admin'}:null,csrf_token:'csrf-value'});if(p==='/api/auth/login'){signed=true;return response({user:{username:'admin01',role:'admin'},csrf_token:'new-csrf'})}if(p==='/api/auth/logout'){signed=false;return response({status:'logged_out'})}if(options.expired)return response({message:'만료'},401);if(p.startsWith('/api/dashboard/incident-overview?'))return response(options.overview||{},options.offline?503:200);if(p==='/api/dashboard'){if(options.offline)throw Error('offline');return response({as_of:snapshot.observability.as_of,incident_counts:options.incidentCounts||snapshot.incident_counts,servers:options.servers||[{target_id:'app',status:'normal',last_checked_at:snapshot.observability.as_of}]})}if(p.startsWith('/api/observability')){if(options.offline)throw Error('offline');return response({...snapshot.observability,...options.observability,logs:options.observability?.logs||{'portal-api':{status:'ok',items:[{collected_at:snapshot.observability.as_of,fields:{route:'/health',event_type:'health_check_completed'}}]},'portal-nginx':{status:'ok',items:[]}}})}if(p.startsWith('/api/incidents?'))return response(options.listResponse||{items:[detail()],total:1,page:1});if(opts.method==='POST'&&options.failWrite)return response({message:'상태가 변경되었습니다.'},options.failWrite);if(p==='/api/incidents/'+id)return response(detail());if(p==='/api/incidents/'+options.relatedError?.id)return response({message:'원본 조회 실패'},options.relatedError.status);if(p.startsWith('/api/incidents/')&&options.related?.[p.slice('/api/incidents/'.length)])return response(options.related[p.slice('/api/incidents/'.length)]);if(p.endsWith('/accept')){incidentStatus='accepted';return response(detail())}if(p.endsWith('/actions')){incidentStatus='in_progress';return response({status:incidentStatus})}if(p.endsWith('/close')){incidentStatus='closed';return response(detail())}throw Error('unexpected '+p)}
const handlers={};const stack=[{hash:location.hash,state:null}];let pos=0;
 const history={state:null,replaceState(value,_,hash){this.state=value;location.hash=hash;stack[pos]={hash:location.hash,state:value}},pushState(value,_,hash){this.state=value;location.hash=hash;stack.splice(pos+1);stack.push({hash:location.hash,state:value});pos++},back(){if(pos===0)return;pos--;location.hash=stack[pos].hash;this.state=stack[pos].state;for(const fn of handlers.popstate||[])fn()},forward(){if(pos>=stack.length-1)return;pos++;location.hash=stack[pos].hash;this.state=stack[pos].state;for(const fn of handlers.popstate||[])fn()}};
 const win={document:doc,Event:class{constructor(type){this.type=type}},scrollY:options.scrollY||0,addEventListener(k,fn){(handlers[k]??=[]).push(fn)},scrollTo(position){this.scrollY=position.top}};
 vm.runInNewContext(contextCode,{window:win});vm.runInNewContext(fs.readFileSync(path.join(root,'static/schutz-ui/drafts.js'),'utf8'),{window:win});
 vm.runInNewContext(code,{document:doc,fetch,location,history,URLSearchParams,AbortController,setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},window:win,navigator:options.navigator||{},console});return {doc,calls,location,id,history,stack,handlers}}
test('실제 응답 수치로 대시보드를 표시하고 시작 시 상태 변경 요청을 보내지 않는다',async()=>{const a=boot();await settle();assert.equal(a.doc.querySelector('.app').hidden,false);assert.match(a.doc.querySelectorAll('.kpi')[2].textContent,/13/);assert.match(a.doc.querySelectorAll('.service')[1].textContent,/4.75/);assert.match(a.doc.querySelector('.notice').textContent,/조회 전용/);assert.equal(a.calls.filter(c=>c.opts.method==='POST').length,0)});
test('비로그인 시 화면 데이터를 숨기고 로그인 요청에 CSRF를 보낸다',async()=>{const a=boot({signed:false});await settle();assert.equal(a.doc.querySelector('.app').hidden,true);a.doc.querySelector('#username').value='admin01';a.doc.querySelector('#password').value='local-test';await a.doc.querySelector('#login-form').onsubmit({preventDefault(){}});await settle();const call=a.calls.find(c=>c.path==='/api/auth/login');assert.equal(call.opts.headers['X-CSRF-Token'],'csrf-value');assert.equal(a.doc.querySelector('#password').value,'');assert.equal(a.doc.querySelector('.app').hidden,false)});
test('시간 구간과 화면 위치를 복원하고 선택 기간을 API에 전달한다',async()=>{const a=boot({hash:'#view=resources&window=6h'});await settle();assert(a.calls.some(c=>c.path==='/api/observability?window=6h'));assert.match(a.doc.querySelector('.view-panel').textContent,/서버 리소스/)});
test('로그 메뉴에서 실제 응답 로그를 표시한다',async()=>{const a=boot({hash:'#view=logs'});await settle();assert.match(a.doc.querySelector('.view-panel').textContent,/health_check_completed/)});
test('연결 실패를 정상 0건으로 표시하지 않는다',async()=>{const a=boot({offline:true});await settle();assert.match(a.doc.querySelectorAll('.kpi')[0].textContent,/미확인/);assert.match(a.doc.querySelector('.notice').textContent,/일부 조회에 실패/)});
test('명시적으로 허용된 사건 접수에 CSRF를 전달하며 API 상태로 화면을 갱신한다',async()=>{const a=boot({writes:true,incidentStatus:'new'});await settle();a.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();const btn=a.doc.querySelectorAll('#detail-body button').find(b=>b.textContent==='사건 접수');assert(btn);btn.dispatch('click');await settle();const call=a.calls.find(c=>c.path.endsWith('/accept'));assert.equal(call.opts.headers['X-CSRF-Token'],'csrf-value');assert.equal(call.opts.body,'{}');assert.match(a.doc.querySelector('#detail-body').textContent,/조치 내용/)});
test('조회 전용에서는 사건 접수 버튼을 제공하지 않는다',async()=>{const a=boot({incidentStatus:'new'});await settle();a.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();assert(!a.doc.querySelectorAll('#detail-body button').some(b=>b.textContent==='사건 접수'));assert.match(a.doc.querySelector('#detail-body').textContent,/조회 전용/)});
test('조치 기록과 사건 종료 요청에 입력·CSRF를 전달한다',async()=>{const a=boot({writes:true,incidentStatus:'accepted'});await settle();a.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();let form=a.doc.querySelector('#detail-body form');a.doc.querySelector('#action-content').value='점검 결과 확인';form.requestSubmit();await settle();const action=a.calls.find(c=>c.path.endsWith('/actions'));assert.deepEqual(JSON.parse(action.opts.body),{content:'점검 결과 확인'});form=a.doc.querySelectorAll('#detail-body form').at(-1);a.doc.querySelector('#resolution').value='정상 점검 근거 확인';form.requestSubmit();await settle();const close=a.calls.find(c=>c.path.endsWith('/close'));assert.deepEqual(JSON.parse(close.opts.body),{resolution:'정상 점검 근거 확인'});assert.equal(close.opts.headers['X-CSRF-Token'],'csrf-value');assert.match(a.doc.querySelector('#detail-body').textContent,/종료/)});
test('서비스 모니터링은 하위 메뉴 없이 상세 화면으로 바로 이동한다',async()=>{const a=boot();await settle();const nav=a.doc.querySelectorAll('.nav>a')[2];assert.equal(a.doc.querySelector('.nav .sub'),null);assert.equal(nav.getAttribute('aria-expanded'),null);nav.dispatch('click');await settle();assert.match(a.location.hash,/view=services/);assert.match(a.location.hash,/service=app/);assert.equal(a.doc.querySelector('.heading h1').textContent,'서비스 모니터링');assert.equal(a.doc.querySelectorAll('.service-tabs button').length,3);assert.equal(a.doc.querySelector('.service-tabs').getAttribute('aria-orientation'),'horizontal');assert.match(a.doc.querySelector('.service-analysis-head').textContent,/FastAPI/)});
test('화면 안 FastAPI·DB·Nginx 버튼은 각각 다른 지표를 표시한다',async()=>{const a=boot({hash:'#view=services&service=app'});await settle();assert.match(a.doc.querySelector('.view-panel').textContent,/HTTP 요청량/);assert(!a.doc.querySelector('.view-panel').textContent.includes('업스트림 응답시간'));a.doc.querySelectorAll('.service-tabs button')[1].dispatch('click');assert.match(a.doc.querySelector('.view-panel').textContent,/DB 작업시간/);assert(!a.doc.querySelector('.view-panel').textContent.includes('경로별 요청량'));a.doc.querySelectorAll('.service-tabs button')[2].dispatch('click');assert.match(a.doc.querySelector('.view-panel').textContent,/업스트림 응답시간/);assert.match(a.location.hash,/service=proxy/)});
test('수집 표는 연결 정보를 같은 행에 표시하고 실패 사유와 미제공을 구분한다',async()=>{
 const items=[{job:'ec2-node',instance:'monitor:12345',up:false,failure_reason:'연결 시간 초과',last_scrape_at:'2026-11-05T15:21:07Z'},{job:'portal-db-health',instance:'service:8081',up:true}];
 const resources={items:[{server_role:'monitoring',instance:'monitor:12345'}]};
 const a=boot({hash:'#view=collectors',observability:{targets:{status:'ok',items},resources}});await settle();
 const rows=a.doc.querySelectorAll('.phase3-target-table tbody tr');
 assert.equal(rows.length,2);
 assert.match(rows[0].textContent,/모니터링 서버 자원.*수집 실패연결 시간 초과.*monitor:12345.*KST/);
 assert.match(rows[1].textContent,/수집 성공.*미제공/);
 assert.equal(a.doc.querySelectorAll('.read-detail').length,0);
});
test('브라우저 뒤로·앞으로가기로 이전 메뉴를 복원한다',async()=>{const a=boot();await settle();const nav=a.doc.querySelectorAll('.nav>a');nav[4].dispatch('click');await settle();nav[6].dispatch('click');await settle();assert.match(a.doc.querySelector('.view-panel').textContent,/계정 · 사용 범위/);a.history.back();await settle();assert.match(a.location.hash,/view=collectors/);assert.match(a.doc.querySelector('.view-panel').textContent,/수집 대상 목록/);a.history.back();await settle();assert.equal(a.doc.querySelector('.dashboard-view').hidden,false);a.history.forward();await settle();assert.match(a.location.hash,/view=collectors/)});
test('상세 팝업 뒤로가기는 팝업만 닫고 앞으로가기로 다시 열린다',async()=>{const a=boot();await settle();const initial=a.location.hash;a.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();assert(a.doc.querySelector('#detail').open);assert.match(a.location.hash,/overlay=incident-/);a.history.back();await settle();assert.equal(a.doc.querySelector('#detail').open,false);assert.equal(a.location.hash,initial);a.history.forward();await settle();assert.equal(a.doc.querySelector('#detail').open,true);a.doc.querySelector('#detail-close').dispatch('click');await settle();assert.equal(a.doc.querySelector('#detail').open,false);assert.equal(a.location.hash,initial)});
test('종 알림은 작은 패널이며 긴 연결 주소는 포함하지 않는다',async()=>{const a=boot();await settle();a.doc.querySelector('.notify').dispatch('click');const panel=a.doc.querySelector('.alert-popover');assert.equal(panel.hidden,false);assert.match(panel.textContent,/현재 발생 중인 Prometheus 경보는 없습니다/);assert(!panel.textContent.includes('10.20.10.62'));panel.querySelectorAll('button').find(b=>b.textContent.includes('수집 상태 보기')).dispatch('click');await settle();assert.equal(panel.hidden,true);assert.match(a.location.hash,/view=collectors/)});

test('서버에서 비활성화한 사건 처리는 조회 전용으로 유지한다',async()=>{const a=boot({production:true,serverWrites:false,incidentStatus:'new'});await settle();a.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();assert.match(a.doc.querySelector('#detail-body').textContent,/조회 전용/);assert(!a.calls.some(c=>c.opts.method==='POST'));});

test('현황은 양쪽 서버의 게이지 여섯 개를 동시에 표시한다',async()=>{const a=boot();await settle();assert.equal(a.doc.querySelectorAll('.dashboard-gauge').length,6);assert.match(a.doc.querySelector('.dashboard-hosts').textContent,/서비스 서버.*모니터링 서버/);assert.equal(a.doc.querySelectorAll('.resources .resource-scrubber').length,0);});
test('운영 사건 그래프에 실제 조회 집계를 표시한다',async()=>{const start='2026-10-31T00:00:00Z',end='2026-10-31T00:15:00Z';const a=boot({overview:{start,end,buckets:[{start,detected:2,closed:1},{start:end,detected:0,closed:0}],types:{delay:1,collection:1,other:0}}});await settle();assert.match(a.doc.querySelector('.incident-trend').textContent,/발생 2건.*사건 종료 1건/);assert.match(a.doc.querySelector('.incident-breakdown').textContent,/응답 지연1건 \(50%\)/);});
test('누락 표본과 긴 수집 간격을 선으로 이어 붙이지 않는다',async()=>{const original=snapshot.observability.resources.items[0].history.cpu.points;try{const t=Date.parse(snapshot.observability.as_of);snapshot.observability.resources.items[0].history.cpu.points=[[t-180000,1.81],[t-150000,null],[t-120000,1.83],[t,1.82]];const a=boot({hash:'#view=resources'});await settle();assert.equal(a.doc.querySelector('.resource-compare-metric').querySelectorAll('polyline').length,3);}finally{snapshot.observability.resources.items[0].history.cpu.points=original}});
test('수집이 지연되면 현재값은 숨기고 과거 표본과 지연 상태를 구분한다',async()=>{const host=snapshot.observability.resources.items[0],old=host.status;try{host.status='stale';const a=boot({hash:'#view=resources'});await settle();assert.match(a.doc.querySelector('.resource-compare-host').textContent,/수집 지연/);assert.match(a.doc.querySelector('.resource-compare-values').textContent,/현재미확인/);assert(a.doc.querySelector('.resource-compare-metric polyline'));}finally{host.status=old}});

test('달력은 시간 입력 없이 여러 날짜를 조회하고 선택 범위를 URL에 보존한다',async()=>{
 const a=boot({hash:'#view=resources'});await settle();
 a.doc.querySelectorAll('.periods button').find(e=>e.dataset.window==='custom').dispatch('click');
 const kstDay=t=>new Date(t+9*3600000).toISOString().slice(0,10);
 const start=kstDay(Date.now()-10*86400000),end=kstDay(Date.now()-2*86400000);
 a.doc.querySelector('#range-start').value=start;
 a.doc.querySelector('#range-end').value=end;
 a.doc.querySelector('.calendar-form').requestSubmit();await settle();
 const call=a.calls.find(c=>c.path.startsWith('/api/observability?window=custom'));
 assert(call);
 const query=new URLSearchParams(call.path.split('?')[1]);
 assert.equal(Date.parse(query.get('start')),Date.parse(start+'T00:00+09:00'));
 assert.equal(query.get('end'),end+'T14:59:59.999999Z');
 const hash=new URLSearchParams(a.location.hash.slice(1));
 assert.equal(hash.get('start'),query.get('start'));assert.equal(hash.get('end'),query.get('end'));
 assert(a.doc.querySelector('.resource-compare'));
});
test('최근 1년을 한 번에 조회하고 잘못된 시간은 제출하지 않는다',async()=>{
 const a=boot();await settle();
 a.doc.querySelectorAll('.periods button').find(e=>e.dataset.window==='custom').dispatch('click');
 a.doc.querySelectorAll('.calendar-presets button').find(b=>b.textContent==='최근 1년').dispatch('click');
 const form=a.doc.querySelector('.calendar-form'),time=a.doc.querySelector('#range-start-time');
 const correct=time.value;
 time.value='25:00';form.requestSubmit();
 assert.match(a.doc.querySelector('.calendar-error').textContent,/24시간제/);
 assert(!a.calls.some(c=>c.path.includes('window=custom')));
 time.value=correct;form.requestSubmit();await settle();
 const call=a.calls.find(c=>c.path.startsWith('/api/dashboard/incident-overview?window=custom'));
 assert(call);
 const query=new URLSearchParams(call.path.split('?')[1]);
 assert.equal(Date.parse(query.get('end'))-Date.parse(query.get('start')),365*86400000);
});
test('메인 성능 지표를 A·B·C 순서로 표시하고 미수집을 구분한다',async()=>{const a=boot();await settle();const cards=a.doc.querySelectorAll('.services .service');assert.equal(cards.length,5);assert(cards.every(c=>c.querySelectorAll('.service-aux>div').length===2));assert.match(cards[0].textContent,/앱 응답시간 p95/);assert.match(cards[1].textContent,/앱 DB 작업시간 p95/);assert.match(cards[1].querySelector('.service-aux').textContent,/연결 수미수집활성 세션미수집/);assert.match(cards[2].textContent,/\/health 프록시 응답 p95/);assert.equal(cards[0].querySelector('polyline').getAttribute('stroke'),'#087dff');assert.equal(cards[1].querySelector('polyline').getAttribute('stroke'),'#8b5cf6');assert.equal(cards[2].querySelector('polyline').getAttribute('stroke'),'#14b8a6');assert.match(a.doc.querySelector('.service-metric-group-title').textContent,/직원 포털 A/);
assert.match(cards[3].textContent,/홈페이지 B.*앱 응답시간 p95.*미수집/);
assert.match(cards[4].textContent,/커뮤니티 C.*앱 응답시간 p95.*미수집/);
assert.equal(cards[3].querySelector('.service-chart polyline'),null);
assert.equal(cards[4].querySelector('.service-chart polyline'),null);
cards[4].dispatch('click');await settle();assert.match(a.location.hash,/service=community/);
assert.match(a.doc.querySelector('.loki-status').textContent,/Loki/);});
test('기능 점검 정상과 지표 조회 실패를 별도 표시한다',async()=>{const metric=snapshot.observability.metrics.app_ms,old=metric.status;try{metric.status='unavailable';const a=boot();await settle();const c=a.doc.querySelector('.service');assert.match(a.doc.querySelector('.service-health-card.service-app .service-badge').textContent,/정상/);assert.match(c.querySelector('.svc-data').textContent,/조회 실패/);}finally{metric.status=old}});
test('경로별 프록시 지표가 없으면 5xx를 0으로 만들지 않는다',async()=>{const data=snapshot.observability.details.proxy_errors,old=data.items;try{data.items=[];const a=boot();await settle();assert.match(a.doc.querySelectorAll('.service')[2].querySelector('.service-aux').textContent,/\/health 5xx데이터 없음/);}finally{data.items=old}});
test('카드에서 상세로 이동하며 서비스 탭·축 모드와 키보드 시각 조회를 지원한다',async()=>{const a=boot();await settle();a.doc.querySelector('.service').dispatch('click');await settle();assert.equal(a.doc.querySelectorAll('.service-tabs button').length,3);assert.match(a.location.hash,/service=app/);a.doc.querySelectorAll('.service-modes button')[1].dispatch('click');assert.match(a.doc.querySelector('.service-detail-chart .service-axis').textContent,/변화 확대/);a.doc.querySelectorAll('.service-tabs button')[1].dispatch('click');assert.match(a.doc.querySelector('.service-analysis-head').textContent,/PostgreSQL/);assert.match(a.doc.querySelector('.service-detail-chart .service-axis').textContent,/전체 표시 범위/);a.doc.querySelectorAll('.service-tabs button')[1].onkeydown({key:'Home',preventDefault(){}});assert.match(a.doc.querySelector('.service-detail-chart .service-axis').textContent,/변화 확대/);const slider=a.doc.querySelector('.service-scrubber');slider.value=0;slider.oninput();assert.match(slider.getAttribute('aria-valuetext'),/ms/);assert.equal(a.doc.querySelectorAll('.service-statistics>div').length,5);});
test('홈페이지와 커뮤니티 상세는 현재 HTTP 점검과 결측 상태를 표시한다',async()=>{
 const checked_at='2026-11-12T00:00:00Z';
 const a=boot({hash:'#view=services&service=homepage',observability:{service_probes:{
  'homepage-health':{success:true,checked_at},'homepage-organization':{success:false,checked_at},
  'community-health':{success:true,checked_at}
 }}});
 await settle();
 const panel=()=>a.doc.querySelector('.service-analysis-panel');
 assert.match(panel().textContent,/홈페이지 B/);
 assert.match(panel().textContent,/앱 응답시간 p95 추이/);
 assert.match(panel().textContent,/응답시간 요약/);
 assert.match(panel().textContent,/요청량미수집5xx 서버 오류미수집/);
 assert.equal(panel().querySelector('.service-detail-chart svg'),null);
 assert.match(panel().textContent,/조직도 조회 기능 점검 점검 이상/);
 assert.equal(a.doc.querySelectorAll('.service-tabs button').length,0);
 assert.equal(a.doc.querySelector('#service-group-homepage').getAttribute('aria-pressed'),'true');
 a.doc.querySelector('#service-group-community').dispatch('click');
 assert.match(a.location.hash,/service=community/);
 assert.match(panel().textContent,/커뮤니티 C/);
 assert.match(panel().textContent,/질문 목록 조회 기능 점검 확인 불가/);
 assert.match(panel().textContent,/앱 응답시간 p95 추이/);
 assert.equal(panel().querySelector('.service-detail-chart svg'),null);
 a.doc.querySelector('#service-group-portal').dispatch('click');
 assert.match(a.location.hash,/service=app/);
 assert.equal(a.doc.querySelectorAll('.service-tabs button').length,3);
});
test('홈페이지 실측 지표를 메인과 상세에 표시하고 서버 카드에 공유 서비스를 안내한다',async()=>{
 const checked_at=snapshot.observability.as_of;
 const at=Date.parse(checked_at);
 const metrics={...snapshot.observability.metrics,
  homepage_ms:{status:'ok',value:8,points:[[at-30000,5],[at,8]]},
  homepage_requests:{status:'ok',value:2},homepage_errors:{status:'ok',value:0}};
 const a=boot({observability:{metrics}});
 await settle();
 const card=a.doc.querySelector('.service-homepage');
 assert.match(card.textContent,/8 ms/);
 assert.match(card.textContent,/요청량2 건\/초5xx 서버 오류0 건\/초/);
 assert.match(a.doc.querySelector('.dashboard-hosts').textContent,/실행 서비스 · 직원 포털 A · 홈페이지 B · 커뮤니티 C/);
 card.dispatch('click');
 await settle();
 const panel=a.doc.querySelector('.service-analysis-panel');
 assert.match(panel.textContent,/8 ms/);
 assert(panel.querySelector('.service-detail-chart polyline'));
});
test('서비스 그래프는 결측과 긴 간격을 연결하지 않으며 표본 통계를 계산한다',async()=>{const metric=snapshot.observability.metrics.app_ms,old=metric.points;try{const t=Date.parse(snapshot.observability.as_of);metric.points=[[t-180000,1],[t-150000,null],[t-120000,3],[t,2]];const a=boot({hash:'#view=services&service=app'});await settle();assert.equal(a.doc.querySelector('.service-detail-chart').querySelectorAll('polyline').length,3);const stats=a.doc.querySelector('.service-statistics').textContent;assert.match(stats,/표본 평균2 ms/);assert.match(stats,/최대3 ms/);assert.match(stats,/최소1 ms/);assert.match(a.doc.querySelector('.service-analysis-panel').textContent,/전체 요청의 통계가 아닙니다/);}finally{metric.points=old}});

test('통계 아이콘은 기준 색상별 원형을 지정하고 현재값에 실제 표본 시각을 표시한다',async()=>{const a=boot({hash:'#view=services&service=app'});await settle();for(const kind of ['current','mean','max','min','spread'])assert(a.doc.querySelector('.service-stat-'+kind+' svg'));const last=snapshot.observability.metrics.app_ms.points.filter(p=>Number.isFinite(p[1])).at(-1),time=new Date(last[0]).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});assert.equal(a.doc.querySelector('.service-stat-time').textContent,'('+time+')');});

test('경보 근거와 복구 조건을 사건 상세에서 확인한다',async()=>{const a=boot({incidentStatus:'in_progress',monitoring:{alert_name:'MonitoringTargetDown',state:'normal',last_evaluated_at:snapshot.observability.as_of,recovery_confirmed:true}});await settle();a.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();const text=a.doc.querySelector('#detail-body').textContent;assert.match(text,/Prometheus 경보/);assert.match(text,/MonitoringTargetDown/);assert.match(text,/복구 신호 확인/);assert.match(text,/수집 대상 경보/);assert(!a.calls.some(c=>c.opts.method==='POST'));});


test('운영 관리자 권한을 서버에서 확인하고 접수 버튼을 제공한다',async()=>{const a=boot({production:true,incidentStatus:'new'});await settle();a.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();assert(a.calls.some(c=>c.path==='/api/management/capabilities'));assert(a.doc.querySelectorAll('#detail-body button').some(b=>b.textContent==='사건 접수'));assert(!a.calls.some(c=>c.opts.method==='POST'));});
test('권한 조회 실패 시 처리 버튼을 숨긴다',async()=>{const a=boot({production:true,capabilityOffline:true,incidentStatus:'new'});await settle();a.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();assert.match(a.doc.querySelector('#detail-body').textContent,/조회 전용/);assert(!a.calls.some(c=>c.opts.method==='POST'));});
test('실시간 경보와 미종료 사건을 구분하고 사건 목록으로 이동한다',async()=>{const a=boot({production:true,incidentStatus:'new'});await settle();a.doc.querySelector('.notify').dispatch('click');await settle();const panel=a.doc.querySelector('.alert-popover');assert.match(panel.textContent,/실시간 경보0건/);assert.match(panel.textContent,/미종료 사건/);assert.match(panel.textContent,/모의 사건이나 복구 후 미종료 사건/);panel.querySelectorAll('button').find(b=>b.textContent==='미종료 사건 보기 →').dispatch('click');await settle();assert.match(a.location.hash,/view=incidents/);assert(!a.calls.some(c=>c.opts.method==='POST'));});
test('종 알림 조회 실패를 경보 0건으로 표시하지 않는다',async()=>{const a=boot({production:true,offline:true});await settle();a.doc.querySelector('.notify').dispatch('click');await settle();const panel=a.doc.querySelector('.alert-popover');assert.match(panel.textContent,/실시간 경보미확인/);assert.match(panel.textContent,/미종료 사건미확인/);assert(!panel.textContent.includes('실시간 경보0건'));});

const drafts=require('../static/schutz-ui/drafts.js');
test('알림 시험 초안은 실제 장애 복구로 서술하지 않는다',()=>{const d={id:'unit',target_id:'delivery-test',synthetic:true,rule_id:'notification_delivery_test',status:'in_progress',jobs:[],closure:{eligible:true,reasons:[]}};const draft=drafts.buildDraft(d);assert.match(draft.action,/실제 장애 복구를 의미하지 않/);assert.match(draft.action,/모의/);assert.equal(draft.ready,true);});
test('Prometheus 미복구 초안은 종료 가능으로 만들지 않는다',()=>{const draft=drafts.buildDraft({id:'unit',target_id:'app',rule_id:'monitoring_target_down',status:'in_progress',monitoring:{state:'unknown'},jobs:[],closure:{eligible:false,reasons:['PROMETHEUS_RECOVERY_NOT_CONFIRMED']}});assert.equal(draft.recovered,false);assert.equal(draft.ready,false);assert.match(draft.resolution,/종료 조건이 아직 충족되지 않/);});


const pastID='11111111-2222-4333-8444-555555555555';
function contextJob(overrides={}){return {kind:'ai',status:'succeeded',mode:'live',attempts:1,history:[{outcome:'succeeded',finished_at:'2026-10-23T00:15:00Z'}],input_evidence:[{id:'probe:app:1',kind:'check',occurred_at:'2026-10-23T00:00:00Z',payload:{status_code:500,probe_success:false}},{id:'history:'+pastID,kind:'historical_context',occurred_at:'2026-10-21T00:10:00Z',payload:{incident_id:pastID,target_id:'app',rule_id:'availability_failure',synthetic:true,detected_at:'2026-10-21T00:00:00Z',closed_at:'2026-10-21T00:10:00Z',action_notes:['서비스 설정을 확인하고 상태를 재점검함']}}],result:{summary:'약 99분이라는 AI 원문은 원본과 대조해야 합니다.',hypotheses:['원인 미확인'],evidence_ids:['probe:app:1','history:'+pastID],next_checks:['기능 점검 확인'],limitations:'과거 조치의 효과는 미검증'},...overrides}}
async function contextDetail(job,extra={}){const a=boot({detail:{jobs:[job],detected_at:'2026-10-23T00:00:00Z',closed_at:'2026-10-23T00:12:00Z',...extra}});await settle();a.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();return a}
test('현재 근거·과거 조치·AI 가설을 분리하고 실제 입력·인용 건수를 표시한다',async()=>{const a=await contextDetail(contextJob());const body=a.doc.querySelector('#detail-body');assert.match(body.textContent,/01 현재 사건의 분석 입력 근거/);assert.match(body.textContent,/02 참고한 과거 사건/);assert.match(body.textContent,/AI 분석 결과/);assert.match(body.textContent,/현재 근거 1건 · AI 인용 1건/);assert.match(body.querySelector('.context-stats').textContent,/참고 이력1건AI 과거 인용1건/);assert.match(body.textContent,/관리자 조치 기록/);assert.match(body.textContent,/HTTP 500/);assert.match(body.textContent,/조치 효과나 현재 원인이 검증됐다는 뜻은 아닙니다/);assert.equal(body.querySelectorAll('.context-history-card').length,1);assert.equal(body.querySelector('.context-history-card').open,true);assert(!a.calls.some(c=>c.opts.method==='POST'))});
test('과거 사건 링크는 전체 ID로 조회하며 뒤로가기로 원래 상세를 복원한다',async()=>{const job=contextJob(),related={...snapshot.incidents[0],id:pastID,status:'closed',jobs:[],actions:[],evidence:[],closure:{reasons:[]}};const a=boot({detail:{jobs:[job]},related:{[pastID]:related}});await settle();a.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();const originalHash=a.location.hash;a.doc.querySelectorAll('#detail-body button').find(b=>b.textContent==='원본 사건 상세 보기').dispatch('click');await settle();assert(a.calls.some(c=>c.path==='/api/incidents/'+pastID));assert.equal(a.doc.querySelector('.incident-id-row textarea').value,pastID);a.history.back();await settle();assert.equal(a.location.hash,originalHash);assert.match(a.doc.querySelector('#detail-body').textContent,/참고한 과거 사건/);assert(!a.calls.some(c=>c.opts.method==='POST'))});
test('입력 미제공과 빈 입력·미인용을 서로 구분하고 기능 비활성으로 단정하지 않는다',async()=>{const missing=await contextDetail(contextJob({input_evidence:null}));assert.match(missing.doc.querySelector('.context-history').textContent,/포함 여부를 확인할 수 없습니다/);const empty=await contextDetail(contextJob({input_evidence:[]}));assert.match(empty.doc.querySelector('.context-history').textContent,/포함된 과거 이력이 없습니다/);assert(!empty.doc.querySelector('.context-history').textContent.includes('꺼져'));const noCite=contextJob();noCite.result={...noCite.result,evidence_ids:['probe:app:1']};const a=await contextDetail(noCite);assert.match(a.doc.querySelector('.context-history').textContent,/입력됐지만 AI 응답에서 인용되지 않았습니다/);assert.match(a.doc.querySelector('.context-stats').textContent,/AI 과거 인용0건/)});
test('분석 결과가 아직 없으면 인용 건수를 0으로 단정하지 않는다',async()=>{const a=await contextDetail(contextJob({status:'running',result:null,history:[]}));assert.match(a.doc.querySelector('.context-stats').textContent,/AI 과거 인용미확인/);assert.match(a.doc.querySelector('.context-timing').textContent,/저장된 AI 결과 완료미제공/)});
test('사건 소요 시간은 원본 시각으로 계산하고 AI 원문의 기간과 혼동하지 않는다',async()=>{const a=await contextDetail(contextJob());const timing=a.doc.querySelector('.context-timing');assert.match(timing.textContent,/과거 사건 분석/);assert.match(timing.textContent,/12분 0초 · 실제 오류 지속 시간과 다릅니다/);assert(!timing.textContent.includes('99분'));assert.match(timing.textContent,/2026/);const bad=await contextDetail(contextJob(),{detected_at:'2026-10-24T00:00:00Z',closed_at:'2026-10-23T00:00:00Z'});assert(!bad.doc.querySelector('.context-timing').textContent.includes('탐지~종료 소요'))});
test('축약·위조 과거 ID는 링크를 만들지 않고 조치 문장은 HTML로 실행하지 않는다',async()=>{const job=contextJob();job.input_evidence[1].payload.incident_id='different';job.input_evidence[1].payload.action_notes=['<img src=x onerror=alert(1)>'];job.result.evidence_ids.push('history:unknown');const a=await contextDetail(job);const history=a.doc.querySelector('.context-history');assert.match(history.textContent,/원본 전체 ID를 확인할 수 없어 링크를 제공하지 않습니다/);assert.match(history.textContent,/출처를 확인할 수 없는 인용 1건/);assert.match(history.textContent,/<img src=x/);assert.equal(history.querySelectorAll('img').length,0);assert(!history.querySelectorAll('button').some(b=>b.textContent==='원본 사건 상세 보기'))});
test('수집 경보 입력은 서비스·컨테이너 중단과 구분해 설명한다',async()=>{const a=await contextDetail(contextJob(),{rule_id:'monitoring_target_down'});assert.match(a.doc.querySelector('.context-current').textContent,/up=0은 메트릭 수집 실패/);assert.match(a.doc.querySelector('.context-current').textContent,/서비스·컨테이너 중단은 별도 기능 점검/)});
test('참고 건수는 ID로 중복 제거하고 두 번째 과거 카드는 접힌 상태로 제공한다',async()=>{const job=contextJob(),second='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';job.input_evidence.push({...job.input_evidence[1]});job.input_evidence.push({...job.input_evidence[1],id:'history:'+second,payload:{...job.input_evidence[1].payload,incident_id:second}});job.result.evidence_ids.push('history:'+pastID);const a=await contextDetail(job);assert.match(a.doc.querySelector('.context-stats').textContent,/참고 이력2건AI 과거 인용1건/);const cards=a.doc.querySelectorAll('.context-history-card');assert.equal(cards.length,2);assert.equal(cards[1].open,false)});


test('v3.1 목록은 서버 총건수와 요약 집계·기간 적용 범위를 표시한다',async()=>{const a=boot({hash:'#view=incidents',listResponse:{items:[],total:41,page:1,page_size:20,page_count:3,counts:{new:30,accepted:4,in_progress:5,closed:2}}});await settle();const p=a.doc.querySelector('.view-panel');assert.equal(p.querySelectorAll('.incident-count-card').length,4);assert.match(p.textContent,/30건/);assert.match(p.textContent,/총 41건 · 이 페이지 0건/);assert.match(p.textContent,/상단 기간 선택은 이 목록과 요약에 적용되지 않습니다/)});
test('v3.1 검색·심각도·상태는 서버 요청과 브라우저 주소에 반영된다',async()=>{const a=boot({hash:'#view=incidents'});await settle();const form=a.doc.querySelector('.incident-filters');form.querySelector('input').value='FastAPI';const selects=form.querySelectorAll('select');selects[0].value='warning';selects[1].value='accepted';form.requestSubmit();await settle();assert(a.calls.some(c=>c.path.includes('q=FastAPI')&&c.path.includes('severity=warning')&&c.path.includes('state=accepted')));assert.match(a.location.hash,/q=FastAPI/)});
test('v3.1 전체 ID 복사 성공과 실패를 안내하며 상태 변경 요청을 보내지 않는다',async()=>{let copied;const a=boot({navigator:{clipboard:{writeText:async value=>{copied=value}}}});await settle();a.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();a.doc.querySelectorAll('#detail-body button').find(b=>b.textContent==='ID 복사').dispatch('click');await settle();assert.equal(copied,a.id);assert.match(a.doc.querySelector('#detail-body').textContent,/전체 사건 ID를 복사했습니다/);const b=boot();await settle();b.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();b.doc.querySelectorAll('#detail-body button').find(x=>x.textContent==='ID 복사').dispatch('click');await settle();assert.match(b.doc.querySelector('#detail-body').textContent,/직접 선택해 복사/);assert(!a.calls.some(c=>c.opts.method==='POST'))});
test('v3.1 409 충돌은 조치 입력을 보존하고 최신 상세를 다시 조회한다',async()=>{const a=boot({writes:true,incidentStatus:'accepted',failWrite:409});await settle();a.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();a.doc.querySelector('#action-content').value='입력 보존 확인';a.doc.querySelector('#detail-body form').requestSubmit();await settle();assert.equal(a.doc.querySelector('#action-content').value,'입력 보존 확인');assert.match(a.doc.querySelector('#detail-body').textContent,/최신 상태를 다시 조회/);assert.equal(a.calls.filter(c=>c.opts.method==='POST').length,1);assert(a.calls.filter(c=>c.path==='/api/incidents/'+a.id).length>=2)});
test('v3.1 Slack 미발송·시험 처리·전송 미확인·전송 성공은 서로 다르다',()=>{const ctx=require(path.join(root,'static/schutz-ui/incident-context.js'));assert.match(ctx.jobState(null,'slack').label,/미발송/);assert.match(ctx.jobState({status:'succeeded',mode:'demo'},'slack').label,/실제 연결 아님/);assert.match(ctx.jobState({status:'succeeded',mode:'live'},'slack').label,/전송 미확인/);assert.equal(ctx.jobState({status:'succeeded',mode:'live',result:{sent:true}},'slack').label,'전송 성공')});
test('v3.1 오류 표본 관측 구간은 사건 수명과 별도로 계산한다',()=>{const ctx=require(path.join(root,'static/schutz-ui/incident-context.js'));const d={status:'closed',detected_at:'2026-10-23T00:00:00Z',closed_at:'2026-10-23T00:12:00Z',evidence:[{kind:'check',occurred_at:'2026-10-23T00:01:00Z',payload:{status_code:500}},{kind:'check',occurred_at:'2026-10-23T00:02:00Z',payload:{status_code:502}}]};const result=ctx.build(d,null);assert.equal(result.lifecycleSeconds,720);assert.equal(result.failureWindow.count,2);assert.equal(Date.parse(result.failureWindow.last)-Date.parse(result.failureWindow.first),60000);assert.equal(result.failureWindow.source,'detail_evidence')});

for(const status of [403,404,503])test('v3.1 과거 원본 '+status+' 조회 실패 후 원래 상세로 복귀한다',async()=>{const a=boot({detail:{jobs:[contextJob()]},relatedError:{id:pastID,status}});await settle();a.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();a.doc.querySelectorAll('#detail-body button').find(b=>b.textContent==='원본 사건 상세 보기').dispatch('click');await settle();assert.match(a.doc.querySelector('#detail-body').textContent,/원본 사건 조회 불가/);a.doc.querySelectorAll('#detail-body button').find(b=>b.textContent==='원래 사건 상세로 돌아가기').dispatch('click');await settle();assert.equal(a.doc.querySelector('.incident-id-row textarea').value,a.id);assert(!a.calls.some(c=>c.opts.method==='POST'))});

 test('상세 화면 닫기는 한 개만 제공하고 상태 메타데이터를 분리한다',async()=>{const a=boot({hash:'#view=incidents'});await settle();assert.equal(a.doc.querySelectorAll('.incident-table tbody td').length,9);a.doc.querySelector('.incident-table tbody button').dispatch('click');await settle();assert.equal(a.doc.querySelectorAll('#detail-body button').filter(b=>b.textContent==='화면 닫기').length,1);assert.equal(a.doc.querySelector('#detail-close').hidden,true);assert.equal(a.doc.querySelector('.incident-id-row textarea').value,a.id);assert(a.doc.querySelector('.incident-status-meta'));});

for(const storedState of ['normal','firing','unknown'])test('종료 사건은 '+storedState+' 저장 근거를 현재 상태와 구분한다',async()=>{
 const a=boot({monitoring:{alert_name:'MonitoringTargetDown',state:'unknown',recovery_confirmed:false},detail:{status:'closed',rule_id:'monitoring_target_down',closed_at:'2026-10-26T03:00:00Z',evidence:[{kind:'prometheus',occurred_at:'2026-10-26T02:59:00Z',payload:{rule_id:'monitoring_target_down',state:storedState}}]}});
 await settle();a.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();const panel=a.doc.querySelector('.incident-prometheus-summary');assert.match(panel.textContent,/종료 전 저장 근거/);assert.match(panel.textContent,/현재 상태나 종료 당시 복구 완료를 보증하지 않습니다/);assert(!panel.textContent.includes('복구 조건 미충족'));assert(!a.calls.some(c=>c.opts.method==='POST'));
});
test('종료 전 저장 근거는 이후·타규칙·잘못된 시각을 제외하고 최신 관측을 선택한다',()=>{
 const ctx=require('../static/schutz-ui/incident-context.js');const row=(at,state,rule='monitoring_target_down')=>({kind:'prometheus',occurred_at:at,payload:{state,rule_id:rule}});
 const d={closed_at:'2026-10-26T03:00:00Z',rule_id:'monitoring_target_down',evidence:[row('2026-10-26T02:00:00Z','firing'),row('2026-10-26T02:59:00Z','normal'),row('2026-10-26T03:01:00Z','firing'),row('invalid','normal'),row('2026-10-26T02:59:59Z','firing','other')]};assert.equal(ctx.closedMonitoring(d).state,'normal');assert.equal(ctx.closedMonitoring({...d,closed_at:null}),null);assert.equal(ctx.closedMonitoring({...d,evidence:[]}),null);
});
test('종료 사건에 저장 근거가 없으면 공유된 최신 경보 상태를 과거 사실로 쓰지 않는다',async()=>{
 const a=boot({monitoring:{alert_name:'MonitoringTargetDown',state:'normal',recovery_confirmed:true},detail:{status:'closed',evidence:[]}});await settle();a.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();const panel=a.doc.querySelector('.incident-prometheus-summary');assert.match(panel.textContent,/근거 미제공/);assert(!panel.textContent.includes('복구 신호 확인'));assert(!a.calls.some(c=>c.opts.method==='POST'));
});

 test('두 서버 요약에서 선택한 서버가 상세 링크와 주소에 유지된다',async()=>{
 const hosts=[{server_role:'service',host_id:'service:9100',instance:'service:9100',server_name:'서비스 서버',status:'ok',cpu:10,memory:20,disk:30,history:{}},{server_role:'monitoring',host_id:'monitor:12345',instance:'monitor:12345',server_name:'모니터링 서버',status:'ok',cpu:55,memory:40,disk:50,history:{}}];
 const a=boot({observability:{resources:{status:'ok',items:hosts}}});await settle();
 assert.equal(a.doc.querySelectorAll('.host-overview-card').length,2);
 assert.match(a.doc.querySelectorAll('.host-overview-card')[1].textContent,/55/);
 a.doc.querySelectorAll('.resource-detail-link')[1].dispatch('click');await settle();
 assert.match(a.location.hash,/host=monitor%3A12345/);
 assert.match(a.doc.querySelectorAll('.resource-compare-host')[1].textContent,/모니터링 서버/);
 assert.match(a.doc.querySelector('.resource-compare-selected').textContent,/CPU/);
 assert.equal(a.doc.querySelectorAll('.resource-analysis-panel').length,0);
 });
 test('미수집 모니터링 서버를 정상 또는 0퍼센트로 표시하지 않는다',async()=>{
 const a=boot({observability:{resources:{status:'no_data',items:[{server_role:'monitoring',expected:true,host_id:'expected:monitoring',instance:null,server_name:'모니터링 서버',status:'no_data',cpu:null,memory:null,disk:null,history:{}}]}}});await settle();
 const card=a.doc.querySelectorAll('.host-overview-card')[1];assert.match(card.textContent,/수집 대상 미설정/);assert.match(card.textContent,/데이터 없음/);assert(!card.textContent.includes('0 %'));
 });

 test('서버 역할 조회 실패를 자원 수치와 구분해 표시한다',async()=>{
 const a=boot({observability:{resources:{status:'partial',metadata_status:'unavailable',items:[{host_id:'legacy',instance:'legacy',server_name:'역할 미지정 서버',metadata_status:'unavailable',status:'ok',cpu:25,memory:30,disk:40,history:{}}]}}});await settle();
 const card=a.doc.querySelector('.host-overview-card');assert.match(card.textContent,/서버 역할 조회 실패/);assert.doesNotMatch(card.textContent,/25 %/);
 });
 test('단일 자원 조회 실패는 미수집과 구분한다',async()=>{
 const a=boot({observability:{resources:{status:'partial',items:[{server_role:'service',host_id:'service',instance:'service',server_name:'서비스 서버',status:'ok',cpu:null,memory:30,disk:40,history:{cpu:{status:'unavailable',points:[]}}}]}}});await settle();
 assert.match(a.doc.querySelector('.host-overview-card').textContent,/CPU 사용률.*조회 실패/);
 assert.equal(a.doc.querySelector('.res-value').textContent,'—');
 });

test('서비스 전환의 URL·뒤로가기·새로고침과 가로 방향키를 보존한다',async()=>{const a=boot({hash:'#view=services&service=app&window=1h'});await settle();a.doc.querySelectorAll('.service-tabs button')[0].onkeydown({key:'ArrowRight',preventDefault(){}});assert.match(a.location.hash,/service=database/);assert.equal(a.doc.activeElement.id,'service-tab-database');a.doc.querySelectorAll('.service-tabs button')[1].onkeydown({key:'ArrowRight',preventDefault(){}});assert.match(a.location.hash,/service=proxy/);a.history.back();await settle();assert.match(a.doc.querySelector('.service-analysis-head').textContent,/PostgreSQL/);const restored=boot({hash:a.location.hash});await settle();assert.match(restored.doc.querySelector('.service-analysis-head').textContent,/PostgreSQL/);assert.match(restored.location.hash,/window=1h/);assert.equal(restored.doc.querySelector('.nav .sub'),null)});

test('점검 지연·확인 불가와 근거 있는 HTTP 상태를 구분한다',async()=>{
 const at=snapshot.observability.as_of;
 const a=boot({servers:[{target_id:'app',status:'normal',collection_delayed:true,last_checked_at:at},
  {target_id:'database',status:'unknown',last_checked_at:null},
  {target_id:'proxy',status:'abnormal',last_checked_at:at,http_status:503}]});
 await settle();
 const cards=a.doc.querySelectorAll('.service-health-card');
 assert.match(cards[1].querySelector('.service-badge').textContent,/수집 지연/);
 assert.match(cards[2].querySelector('.service-badge').textContent,/확인 불가/);
 assert.match(cards[0].textContent,/HTTP 503.*점검 이상/);
});

test('기능 점검 정상과 p95 미수집을 별도 표시한다',async()=>{
 const metric=snapshot.observability.metrics.app_ms,old=metric.status;
 try{
  metric.status='no_data';
  const a=boot();await settle();
  assert.match(a.doc.querySelector('.service-health-card.service-app .service-badge').textContent,/정상/);
  assert.match(a.doc.querySelector('.service .svc-data').textContent,/미수집/);
 }finally{metric.status=old}
});

test('경로별 성능은 지표를 경로별로 병합하고 결측과 0을 구분한다',async()=>{
 const data=items=>({status:'ok',items});
 const metric=(route,value)=>({route,value,points:[[0,value]]});
 const details={proxy_requests:data([metric('/a',0),metric('/b',1)]),proxy_errors:data([]),
  proxy_p95:data([metric('/a',0.003)]),upstream_p95:data([metric('/c',0.004)])};
 const a=boot({hash:'#view=services&service=proxy',observability:{details}});await settle();
 const rows=a.doc.querySelectorAll('.phase3-route-table tbody tr');
 assert.equal(rows.length,3);
 assert.deepEqual(rows[0].querySelectorAll('td').map(cell=>cell.textContent),['/a','0','데이터 없음','3','데이터 없음']);
 assert.match(rows[2].textContent,/^\/c.*4$/);
});

test('로그는 요청 ID로 연결하고 정상 점검만 숨긴다',async()=>{
 const log=(id,route,status,fields={})=>({collected_at:snapshot.observability.as_of,fields:{request_id:id,route,status_code:status,...fields}});
 const logs={'portal-nginx':{status:'ok',items:[log('shared','/api/employees',503,{request_time:'0.126'}),log('failed','/health',503),log('normal','/proxy-health',200)]},
  'portal-api':{status:'ok',items:[log('shared','/api/employees',503,{duration_ms:119,reason_code:'DB_UNAVAILABLE'})]}};
 const a=boot({hash:'#view=logs',observability:{logs}});await settle();
 const hide=a.doc.querySelectorAll('.phase3-log-toolbar input')[1];
 hide.checked=true;hide.dispatch('change');
 const summaries=a.doc.querySelectorAll('summary.phase3-log-row');
 assert.equal(summaries.length,3);
 assert.match(summaries[0].textContent,/126 ms/);
 summaries[0].dispatch('click');
 assert.equal(a.doc.querySelectorAll('.phase3-log-selected').length,2);
 assert.match(a.doc.querySelectorAll('.phase3-log-selected')[1].textContent,/DB_UNAVAILABLE/);
 a.doc.querySelectorAll('summary.phase3-log-row')[1].dispatch('click');
 assert.match(a.doc.querySelectorAll('.phase3-log-panel')[1].textContent,/연결 로그 미확인/);
});

test('사건 관리로 바로 접속해도 열린 사건과 실시간 경보가 0이면 알림을 표시하지 않는다',async()=>{
 const a=boot({hash:'#view=incidents&status=open&state=closed',incidentCounts:{new:0,accepted:0,in_progress:0,closed:17},
  observability:{alerts:{status:'ok',items:[]}}});
 await settle();
 const badge=a.doc.querySelector('.tiny-badge');
 assert.equal(badge.hidden,true);
 assert.equal(badge.textContent,'');
 assert(a.doc.querySelector('.notify').classList.contains('no-alerts'));
 assert(a.calls.some(c=>c.path==='/api/incidents?status=open&page=1'));
 assert.doesNotMatch(a.location.hash,/state=closed/);
});

test('목록이 필터로 비어도 실제 경보는 종에 표시하고 열린 사건 배지와 구분한다',async()=>{
 const a=boot({hash:'#view=incidents&status=closed&state=closed&q=old',incidentCounts:{new:0,accepted:0,in_progress:0,closed:17},
  observability:{alerts:{status:'ok',items:[{name:'FixtureAlert'}]}},
  listResponse:{items:[],total:0,page:1,page_count:0,counts:{new:0,accepted:0,in_progress:0,closed:0}}});
 await settle();
 assert.equal(a.doc.querySelector('.tiny-badge').hidden,true);
 assert(!a.doc.querySelector('.notify').classList.contains('no-alerts'));
 a.doc.querySelector('.notify').dispatch('click');await settle();
 a.doc.querySelectorAll('.alert-popover button').find(b=>b.textContent.startsWith('미종료 사건 보기')).dispatch('click');
 await settle();
 assert.match(a.location.hash,/status=open/);
 assert.doesNotMatch(a.location.hash,/[&](q|state)=/);
});

test('사건 집계는 운영을 기본으로 하고 모의·전체를 조회 요청에 전달한다',async()=>{
 const a=boot();await settle();
 assert(a.calls.some(c=>c.path.includes('incident-overview?')&&c.path.includes('scope=operational')));
 const select=a.doc.querySelector('.incident-scope-select');assert(select);
 select.value='synthetic';select.dispatch('change');await settle();
 assert(a.calls.some(c=>c.path.includes('incident-overview?')&&c.path.includes('scope=synthetic')));
 select.value='all';select.dispatch('change');await settle();
 assert(a.calls.some(c=>c.path.includes('incident-overview?')&&c.path.includes('scope=all')));
 assert.equal(a.calls.filter(c=>c.opts.method==='POST').length,0);
});
test('보안 사건은 복구 해당 없음과 사건 종료 알림을 별도로 표시한다',async()=>{
 const a=boot({writes:true,incidentStatus:'in_progress',detail:{rule_id:'unauthorized_write',closure:{eligible:true,reasons:[],test_stop_confirmation_required:true}}});await settle();
 a.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();
 const text=a.doc.querySelector('#detail-body').textContent;
 assert.match(text,/비인가 데이터 변경 시도/);assert.match(text,/해당 없음/);assert.match(text,/사건 종료 알림/);
 assert.match(text,/자동 증명되지는 않습니다/);assert(a.doc.querySelector('#test-stopped'));
});
test('API 연결 전에도 로컬 디자인 시안 문구를 운영 근거처럼 표시하지 않는다',async()=>{
 const a=boot({production:true});await settle();
 assert(!a.doc.textContent.includes('로컬 디자인 시안 · 실제 운영 데이터 아님'));
});

test('보안 사건 조치 초안은 정상 점검이나 추가 차단 완료를 꾸며내지 않는다',()=>{
 const drafts=require('../static/schutz-ui/drafts.js');
 const result=drafts.buildDraft({id:'unit',target_id:'sec:unit',rule_id:'unauthorized_write',synthetic:true,status:'in_progress',jobs:[],closure:{eligible:true,reasons:[]}});
 assert.match(result.resolution,/종료 조건/);
 assert.match(result.action,/별도 증거 확인/);
 assert.match(result.action,/추가 차단 완료를 뜻하지 않습니다/);
 assert.doesNotMatch(result.action,/정상 점검 2회/);
});

test('사용자 지정 대시보드가 사건 집계와 목록에 같은 기간을 적용한다',async()=>{
 const start=new Date(Date.now()-10*86400000).toISOString();
 const end=new Date(Date.parse(start)+3600000).toISOString();
 const query=new URLSearchParams({view:'dashboard',window:'custom',start,end,incident_scope:'synthetic'});
 const a=boot({hash:'#'+query,overview:{recent_detected:[{
  id:'historical-fixture',detected_at:start,rule_id:'response_delay',target_id:'database',status:'new',synthetic:true
 }]}});
 await settle();
 const call=a.calls.find(c=>c.path.startsWith('/api/dashboard/incident-overview?'));
 const params=new URLSearchParams(call.path.split('?')[1]);
 assert.equal(params.get('start'),start);
 assert.equal(params.get('end'),end);
 assert.equal(params.get('scope'),'synthetic');
 assert(!a.calls.some(c=>c.path.startsWith('/api/incidents?')));
 assert.equal(a.doc.querySelector('#incidents .panel-head h2').textContent,'선택 기간에 발생한 사건');
 assert.match(a.doc.querySelector('#incidents tbody').textContent,/모의.*응답 지연/);
});


test('사건 상세 제목과 그래프에 서비스 및 저장된 복구 확인 시각을 표시한다',async()=>{
 const detected_at='2026-11-05T05:00:00Z',recovery_checked_at='2026-11-05T05:05:00Z',closed_at='2026-11-05T05:10:00Z';
 for(const [job,label,verified] of [['portal-health','직원 포털 A',false],['homepage-health','홈페이지 B',true],['community-questions','커뮤니티 C',true],['ec2-node','서비스 미확인',false]]){
  const a=boot({detail:{detected_at,closed_at,recovery_checked_at:verified?recovery_checked_at:null,monitoring:{labels:{job}}}});
  await settle();a.doc.querySelector('#incidents tbody tr').dispatch('click');await settle();
  assert(a.doc.querySelector('.incident-title-row h2').textContent.startsWith(label)||a.doc.querySelector('.incident-title-row h2').textContent.startsWith('[모의] '+label));
  const timing=a.doc.querySelector('.incident-detail-timing'),lines=timing.querySelectorAll('line');
  assert.equal(lines[1].getAttribute('stroke'),'#b4233d');
  assert.equal(lines.length,verified?3:2);
  if(verified){assert.equal(lines[2].getAttribute('stroke'),'#087851');assert.equal(lines[2].getAttribute('x1'),'50')}
  assert.match(timing.textContent,verified?/복구 확인.*KST/:/복구 미확인/);
 }
});
