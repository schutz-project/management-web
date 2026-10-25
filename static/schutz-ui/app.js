/* Existing Management Web API adapter. No external dependency. */
(()=>{'use strict';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const state={user:null,csrf:null,view:'dashboard',service:'app',overlay:null,window:'15m',filter:'open',page:1,generation:0,busy:false,timer:null,data:null,dashboard:null,mode:{mode:'live',writes_enabled:false}};
const labels={new:'신규',accepted:'접수',in_progress:'조치 중',closed:'종료',normal:'정상',abnormal:'이상',unknown:'미확인',succeeded:'성공',failed:'실패',pending:'대기',running:'실행 중',availability_failure:'가용성 장애',response_delay:'응답 지연',login_failures:'반복 로그인 실패',app:'FastAPI',database:'직원 조회',proxy:'Nginx', 'portal-login':'로그인 감시',ai:'AI 분석',slack:'최초 Slack 알림',slack_ai:'AI 완료 Slack 알림',stale:'수집 지연',unavailable:'조회 실패',no_data:'데이터 없음'};
const reasons={ACTION_REQUIRED:'조치 기록이 필요합니다.',TEST_STOP_REQUIRED:'시험 입력 중지 확인이 필요합니다.',LOG_COLLECTION_STALE:'로그 수집이 지연되고 있습니다.',FAILURE_FREE_WINDOW_REQUIRED:'신규 로그인 실패 없이 60초가 지나야 합니다.',TWO_HEALTHY_CHECKS_REQUIRED:'정상 점검 2회 연속이 필요합니다.',CHECK_COLLECTION_STALE:'최근 정상 점검이 필요합니다.'};
const E=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e};
const fmt=(v,p=2)=>typeof v==='number'&&Number.isFinite(v)?v.toLocaleString('ko-KR',{maximumFractionDigits:p}):'미확인';
const date=v=>v?new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'미확인';
const clock=v=>new Date(v).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,hour:'2-digit',minute:'2-digit'});
const name=v=>labels[v]||v||'미확인';
const button=(text,fn)=>{const b=E('button',text,'outline');b.type='button';b.onclick=fn;return b};
const app=$('.app'),main=$('.content'),header=$('.head');
const dash=E('section',undefined,'dashboard-view');[...main.children].filter(x=>x!==header).forEach(x=>dash.append(x));main.append(dash);
const page=E('section',undefined,'view-panel');page.hidden=true;main.append(page);
const notice=E('p',undefined,'notice');notice.setAttribute('role','status');header.after(notice);
const detail=$('#detail');detail.classList.add('functional-dialog');
function feedback(text,error=false){notice.textContent=text;notice.classList.toggle('error',error)}
const overlays=new Map();let overlaySequence=0;
function modal(title,content,key){
 const entering=!state.overlay;
 if(entering)state.overlay=key||'info-'+(++overlaySequence);
 overlays.set(state.overlay,{title,content});
 $('#detail-title').textContent=title;const body=$('#detail-body');body.replaceChildren();body.append(typeof content==='string'?E('p',content):content);
 if(!detail.open)detail.showModal();if(entering)remember(true,true);
}
function closeOverlay(){
 if(!detail.open&&!state.overlay)return;
 if(history.state?.schutzOverlay&&state.overlay){history.back();return}
 state.overlay=null;detail.close();remember(false);
}
async function restoreOverlay(){
 if(!state.overlay)return;
 if(state.overlay.startsWith('incident-')){await openIncident(state.overlay.slice(9));return}
 const saved=overlays.get(state.overlay);if(saved)modal(saved.title,saved.content);else{state.overlay=null;remember(false)}
}
$('#detail-close').onclick=closeOverlay;detail.onclick=e=>{if(e.target===detail)closeOverlay()};detail.addEventListener('cancel',e=>{e.preventDefault();closeOverlay()});
function wire(el,fn){el.tabIndex=0;el.setAttribute('role','button');el.onclick=e=>{e.preventDefault();fn()};el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();fn()}}}
function signedOut(message='관리자 계정으로 로그인해 주세요.'){
 clearInterval(state.timer);state.timer=null;++state.generation;state.user=null;state.csrf=null;state.data=null;state.dashboard=null;
 state.overlay=null;detail.close();remember(false);app.hidden=true;$('#auth-screen').hidden=false;$('#auth-message').textContent=message;$('#login-form').hidden=false;$('#password').value='';page.replaceChildren();dash.hidden=true;
}
async function api(path,options={}){
 const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),12000);
 try{const response=await fetch(path,{...options,signal:ctl.signal,credentials:'same-origin',cache:'no-store'});let data;try{data=await response.json()}catch{throw new Error('JSON 응답을 확인하지 못했습니다.')}
 if(!response.ok){const err=new Error(data.message||'요청을 처리하지 못했습니다.');err.status=response.status;err.code=data.error_code;err.details=data.details;
 if(response.status===401&&path!=='/api/auth/login'){signedOut('세션이 만료됐습니다. 다시 로그인해 주세요.');restoreContext(false).catch(()=>{});}throw err}
 return data;
 }catch(e){if(e.name==='AbortError')throw new Error('응답 시간이 초과됐습니다. 연결을 확인해 주세요.');throw e}finally{clearTimeout(timer)}
}
async function restoreContext(load=true){const c=await api('/api/auth/context');state.csrf=c.csrf_token;state.user=c.user;
 if(!c.user){app.hidden=true;$('#auth-screen').hidden=false;$('#login-form').hidden=false;$('#auth-message').textContent='관리자 계정으로 로그인해 주세요.';$('#login-button').disabled=!state.csrf;return}
 if(c.user.role!=='admin'){signedOut('관리자 권한이 있는 계정이 필요합니다.');return}
 if(load)await enter();
}
async function enter(){app.hidden=false;$('#auth-screen').hidden=true;$('.profile').textContent=state.user.username+' ▾';dash.hidden=false;
 remember(false);await loadView();await restoreOverlay();clearInterval(state.timer);state.timer=setInterval(()=>{if(state.window==='live'&&!document.hidden&&!state.busy&&!detail.open)loadView()},30000);
}
$('#login-form').onsubmit=async e=>{e.preventDefault();if(state.busy)return;state.busy=true;$('#login-button').disabled=true;
 try{if(!state.csrf)await restoreContext(false);const data=await api('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},body:JSON.stringify({username:$('#username').value.trim(),password:$('#password').value})});state.user=data.user;state.csrf=data.csrf_token;if(state.user?.role!=='admin'){signedOut('관리자 계정으로 로그인해 주세요.');return}await enter()}
 catch(err){$('#auth-message').textContent=err.message;try{await restoreContext(false)}catch{}$('#auth-message').textContent=err.message}
 finally{state.busy=false;$('#password').value='';$('#login-button').disabled=!state.csrf}};
$('#auth-retry').onclick=()=>boot();
async function logout(){if(state.mode.mode==='snapshot'){modal('저장 데이터 모드','서버 로그인 없이 저장 데이터를 표시 중입니다.');return}if(state.busy)return;state.busy=true;try{await api('/api/auth/logout',{method:'POST',headers:{'X-CSRF-Token':state.csrf}});signedOut('로그아웃했습니다.');await restoreContext(false)}catch(e){feedback(e.message,true)}finally{state.busy=false}}
wire($('.profile'),()=>{const p=E('div');p.append(E('p','로그인 계정: '+state.user.username),button('로그아웃',async()=>{detail.close();await logout()}));modal('계정',p)});
function locationState(){const p=new URLSearchParams(location.hash.slice(1));const v=p.get('view');state.view=['dashboard','incidents','services','resources','collectors','logs','settings'].includes(v)?v:'dashboard';const w=p.get('window');state.window=['live','15m','1h','6h','24h'].includes(w)?w:'15m';state.service=['app','database','proxy'].includes(p.get('service'))?p.get('service'):'app';state.overlay=/^(?:incident-[a-f0-9-]{36}|info-[0-9]+)$/.test(p.get('overlay')||'')?p.get('overlay'):null;state.filter=p.get('status')==='closed'?'closed':'open';state.page=Math.max(1,Math.min(100000,Number(p.get('page'))||1))}
function remember(push=true,overlay=false){const p=new URLSearchParams({view:state.view,window:state.window});if(state.view==='incidents'){p.set('status',state.filter);p.set('page',String(state.page))}if(state.view==='services')p.set('service',state.service);if(state.overlay)p.set('overlay',state.overlay);const hash='#'+p;const marker={schutz:true,schutzOverlay:overlay};if(push&&location.hash!==hash)history.pushState(marker,'',hash);else history.replaceState(push?(history.state||marker):marker,'',hash)}
function go(v,filter,service){if(state.busy)return;state.overlay=null;detail.close();state.view=v;if(filter)state.filter=filter;if(service)state.service=service;state.page=1;remember();loadView();window.scrollTo?.({top:0,behavior:'instant'})}
locationState();window.addEventListener('popstate',async()=>{locationState();detail.close();if(state.user){await loadView();await restoreOverlay()}});
const views=['dashboard','incidents','services','resources','collectors','logs','settings'];
const serviceNav=$$('.nav>a')[2],subNav=$('.nav .sub');subNav.id='service-submenu';serviceNav.setAttribute('role','button');serviceNav.setAttribute('aria-controls','service-submenu');let menuExpanded=state.view==='services';serviceNav.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();menuExpanded=!menuExpanded;syncServiceMenu()}};
function syncServiceMenu(){subNav.hidden=!menuExpanded;serviceNav.setAttribute('aria-expanded',String(menuExpanded));serviceNav.querySelector('span').textContent=menuExpanded?'⌃':'⌄';$$('.nav .sub a').forEach((a,i)=>a.classList.toggle('sub-active',state.view==='services'&&state.service===['app','database','proxy'][i]))}
$$('.nav>a').forEach((a,i)=>{a.href='#view='+views[i];a.onclick=e=>{e.preventDefault();if(i===2){menuExpanded=!menuExpanded;syncServiceMenu()}else go(views[i])}});
$$('.nav .sub a').forEach((a,i)=>{a.href='#view=services&service='+['app','database','proxy'][i];a.onclick=e=>{e.preventDefault();menuExpanded=true;go('services',null,['app','database','proxy'][i]);syncServiceMenu()}});syncServiceMenu();
const periods=['live','15m','1h','6h','24h'];$$('.periods button').forEach((b,i)=>{b.dataset.window=periods[i];b.onclick=()=>{state.overlay=null;detail.close();state.window=periods[i];remember();loadView()}});
$('#refresh').onclick=()=>loadView();wire($('.notify'),()=>toggleAlerts());
async function getObservation(){return api('/api/observability?window='+(state.window==='live'?'15m':state.window))}
async function loadView(){if(!state.user)return;const g=++state.generation;feedback('조회 중…');dash.hidden=state.view!=='dashboard';page.hidden=state.view==='dashboard';page.replaceChildren();closeAlerts();if(state.view==='services')menuExpanded=true;syncServiceMenu();$('.heading h1').textContent={dashboard:'운영 대시보드',incidents:'사건 관리',services:name(state.service)+' 모니터링',resources:'서버 리소스',collectors:'수집 상태',logs:'로그 분석',settings:'설정'}[state.view];
 $$('.nav>a').forEach((a,i)=>a.classList.toggle('active',views[i]===state.view));$$('.periods button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.window===state.window)));
 try{if(state.view==='settings'){showSettings();feedback('');return}if(state.view==='incidents'){await showIncidentList(g);return}
 const jobs=state.view==='dashboard'?[api('/api/dashboard'),getObservation(),api('/api/incidents?status=open&page=1'),api('/api/incidents?status=closed&page=1')]:state.view==='services'?[getObservation(),api('/api/dashboard')]:[getObservation()];
 const res=await Promise.allSettled(jobs);if(g!==state.generation||!state.user)return;
 if(state.view==='dashboard'){
  const [dr,ob,op,cl]=res;state.dashboard=dr.status==='fulfilled'?dr.value:null;state.data=ob.status==='fulfilled'?ob.value:null;
  renderDashboard(state.dashboard,state.data);
  const rows=[...(op.status==='fulfilled'?op.value.items:[]),...(cl.status==='fulfilled'?cl.value.items:[])].sort((a,b)=>Date.parse(b.detected_at)-Date.parse(a.detected_at)).slice(0,5);
  renderIncidents($('#incidents tbody'),rows,op.status==='rejected'||cl.status==='rejected');
  const newest=rows[0];await renderAISummary(newest,g);
 }else{if(res[0].status==='rejected')throw res[0].reason;state.data=res[0].value;if(state.view==='services'){state.dashboard=res[1].status==='fulfilled'?res[1].value:null;showServices(state.data);}else if(state.view==='resources')showResources(state.data);else if(state.view==='collectors')showCollectors(state.data);else if(state.view==='logs')showLogs(state.data)}
 if(g!==state.generation||!state.user)return;const failed=res.some(r=>r.status==='rejected');feedback(failed?'일부 조회에 실패했습니다. 실패 항목은 미확인으로 표시합니다.':modeNote(),failed);
 }catch(e){if(g!==state.generation)return;feedback(e.message,true);if(!page.hidden)page.append(E('p','데이터를 가져오지 못했습니다. 새로고침으로 다시 확인해 주세요.'))}}
function modeNote(){return state.mode.mode==='snapshot'?'저장 데이터 모드 · '+date(state.data?.as_of||state.mode.as_of)+' (KST) · 실시간 아님':(state.window==='live'?'30초마다 조회 · ':'')+'한국 시간(KST) · '+(state.mode.writes_enabled?'조회·사건 처리 연결':'조회 전용 · 사건 변경 비활성화')}
const NS='http://www.w3.org/2000/svg';function svg(t,a,text){const e=document.createElementNS(NS,t);for(const[k,v]of Object.entries(a))e.setAttribute(k,v);if(text!==undefined)e.textContent=text;return e}
function chart(holder,points,color,ceiling=null){holder.replaceChildren();const data=points||[],values=data.filter(p=>Number.isFinite(p[1]));if(!values.length){holder.append(E('small','그래프 데이터 없음'));return}const resource=ceiling!==null,w=resource?280:150,h=resource?110:36,l=resource?34:3,r=8,t=12,b=resource?22:4,max=ceiling||Math.max(...values.map(p=>p[1]),.001),start=data[0][0],end=data.at(-1)[0];const X=x=>l+(x-start)/(end-start||1)*(w-l-r),Y=y=>t+(1-y/max)*(h-t-b);const s=svg('svg',{viewBox:`0 0 ${w} ${h}`,width:'100%',height:'100%',role:'img','aria-label':resource?'사용률 0~100% · 실제 조회 표본':'실제 조회 표본 추이'});
 if(resource){for(const v of [0,50,100]){s.append(svg('line',{x1:l,x2:w-r,y1:Y(v),y2:Y(v),stroke:'#e1e9f3'}));s.append(svg('text',{x:0,y:Y(v)+3,'font-size':10,fill:'#6e85a1'},v+'%'))}for(const v of [start,end])s.append(svg('text',{x:X(v),y:h-3,'text-anchor':v===start?'start':'end','font-size':10,fill:'#6e85a1'},clock(v)))}
 let segment=[];const draw=()=>{if(segment.length)s.append(svg('polyline',{points:segment.map(p=>X(p[0])+','+Y(p[1])).join(' '),fill:'none',stroke:color,'stroke-width':2}));segment=[]};let prev=null;for(const p of data){if(!Number.isFinite(p[1])||(prev&&p[0]-prev>(state.data?.step_seconds||30)*1500))draw();if(Number.isFinite(p[1]))segment.push(p);prev=p[0]}draw();holder.append(s)}
function renderDashboard(d,o){
 $('.heading h1').textContent='운영 대시보드';$('.demo-ribbon').textContent=state.mode.mode==='snapshot'?'실제 데이터 저장본 · 실시간 아님':'API 연결 · '+(state.mode.writes_enabled?'사건 처리 가능':'조회 전용');
 $('.banner-meta .meta-label').textContent='조회 시각 (KST)';$('.meta-value').textContent=date(d?.as_of||o?.as_of);const c=d?.incident_counts;const open=c?c.new+c.accepted+c.in_progress:null;const servers=d?.servers||[];const known=servers.length&&servers.every(x=>x.status==='normal'&&!x.collection_delayed);
 $('.banner h2').textContent=!d?'상태를 확인하지 못했습니다.':open?'확인이 필요한 열린 사건이 있습니다.':known?'조회 시점에 열린 사건이 없고 기능 점검이 정상입니다.':'열린 사건은 없지만 점검 상태를 확인해야 합니다.';
 $('.banner p').textContent='수집 상태와 서비스 기능 상태를 구분합니다. '+(state.mode.mode==='snapshot'?'저장본 기준입니다.':'마지막 조회 결과입니다.');
 $('.side-status').replaceChildren(E('div','시스템 상태'),E('p',!d?'미확인':known?'기능 점검 정상':'점검 확인 필요'),E('div','조회 시각'),E('p',date(d?.as_of||o?.as_of)));
 const targets=o?.targets?.status==='ok'?o.targets.items:null;const vals=[c?.new,c?c.accepted+c.in_progress:null,c?.closed,targets?targets.filter(t=>t.up).length+' / '+targets.length:null];const notes=['관리자 대응 대기','접수 · 조치 진행','전체 종료 이력','Prometheus 수집 대상'];
 $$('.kpi').forEach((e,i)=>{e.querySelector('strong').textContent=vals[i]===undefined||vals[i]===null?'미확인':String(vals[i])+(i<3?' 건':'');e.querySelector('div:nth-child(2)>small').textContent=notes[i];wire(e,()=>go(i===3?'collectors':'incidents',i===2?'closed':'open'))});$$('.kpi')[2].querySelector('h3').textContent='종료 사건 이력';$('.tiny-badge').textContent=open===null?'?':String(open);
 bell.classList.toggle('no-alerts',o?.alerts?.status==='ok'&&!o.alerts.items.length);renderServices(o,servers);renderResources(o);renderCollectors(o);$('.footer p:last-child').textContent=modeNote();
 $('#incidents .panel-head a').onclick=e=>{e.preventDefault();go('incidents')};$('#incidents .panel-head .link').textContent='분석 이력 →';$('#incidents .panel-head .link').onclick=()=>go('incidents','closed');
 wire($('.resources .panel-head .link'),()=>go('resources'));wire($('.collector .panel-head .link'),()=>go('collectors'));
}
function renderServices(o,servers=[]){const m=o?.metrics||{},p=o?.details?.proxy_p95?.items?.find(x=>x.route==='/health'),pr=o?.details?.proxy_requests?.items?.find(x=>x.route==='/health');
 const svc=$$('.service');const definitions=[['앱 응답시간 p95',m.app_ms,'ms','요청 '+fmt(m.requests?.value)+'건/초 · 5xx '+fmt(m.errors?.value)+'건/초','app'],['앱의 DB 작업시간 p95',m.db_ms,'ms','연결 수 · 활성 세션: 미수집','database'],['/health 프록시 응답 p95',p?{status:'ok',value:p.value===null?null:p.value*1000,points:p.points.map(x=>[x[0],x[1]===null?null:x[1]*1000])}:null,'ms','/health 요청 '+fmt(pr?.value)+'건/초','proxy'],['최근 5분 로그',null,'','Loki 앱·프록시 이벤트 조회','loki']];
 svc.forEach((card,i)=>{const[label,metric,unit,caption,target]=definitions[i];card.querySelector('.svc-label').textContent=label;card.querySelector('.svc-caption').textContent=caption;card.querySelector('.spark').replaceChildren();const health=servers.find(s=>s.target_id===target);let status=health&&!health.collection_delayed?name(health.status):'미확인';
 if(i===3){const logs=o?.logs;const ok=logs&&['portal-api','portal-nginx'].every(k=>logs[k]?.status==='ok');status=ok?'조회 성공':'미확인';card.querySelector('.svc-data strong').textContent=ok?Object.values(logs).reduce((n,v)=>n+v.items.length,0)+' 건':'미확인'}else{card.querySelector('.svc-data strong').textContent=metric?.status==='ok'?fmt(metric.value)+' '+unit:name(metric?.status||'unknown');if(metric?.points)chart(card.querySelector('.spark'),metric.points,['#097dff','#04a668','#8b44ff'][i])}
 const h=card.querySelector('.success');h.textContent=status;h.classList.toggle('unconfirmed',status==='미확인'||status==='이상');wire(card,()=>go(i===3?'logs':'services',null,['app','database','proxy'][i]))});
}
function renderResources(o){const host=o?.resources?.items?.[0];$$('.resource').forEach((e,i)=>{const key=['cpu','memory','disk'][i],h=host?.history?.[key];e.querySelector('.res-value').textContent=host?.status==='ok'?fmt(host[key])+' %':name(host?.status||'unknown');e.querySelector('.res-stats').textContent=h?.summary?.samples?'평균 '+fmt(h.summary.mean)+'% │ 최대 '+fmt(h.summary.max)+'%':'유효 표본 없음';chart(e.querySelector('.res-chart'),h?.points,['#1879ee','#8a51ff','#00b1b5'][i],100)});$('.resources .panel-head h2 span').textContent=host?.instance||'서버 자원 미확인';$('.resources .panel-head .link').textContent='상세 보기 →'}
const roles={'ec2-node':'호스트 지표 (Alloy)','portal-otel':'앱 지표 (Alloy)',prometheus:'자체 상태','blackbox-exporter':'점검 수집기','portal-db-health':'직원 조회 점검'};
function renderCollectors(o){const body=$('.collector tbody');body.replaceChildren();if(o?.targets?.status!=='ok'){const tr=E('tr'),td=E('td','수집 대상 조회 실패');td.colSpan=4;tr.append(td);body.append(tr);return}
 for(const row of o.targets.items){const tr=E('tr');for(const text of [row.job,roles[row.job]||(row.instance.includes('proxy-health')?'프록시 점검':'앱 점검'),row.up?'수집 성공':'수집 실패','미제공'])tr.append(E('td',text));wire(tr,()=>modal('수집 대상',[row.job,row.instance,'개별 수집 시각은 API에 포함되지 않습니다. up은 수집 성공이며 probe_success와 다릅니다.'].join('\n')));body.append(tr)}
 const tr=E('tr');const logs=o.logs;for(const text of ['Loki','로그 저장소',logs&&Object.values(logs).every(x=>x.status==='ok')?'조회 성공':'미확인','미제공'])tr.append(E('td',text));body.append(tr)}
function renderIncidents(tbody,rows,failed=false){tbody.replaceChildren();$('#incidents thead').innerHTML='<tr><th>발생 (KST)</th><th>구분</th><th>유형</th><th>대상</th><th>상태</th><th>AI 분석</th></tr>';
 if(!rows.length){const tr=E('tr'),td=E('td',failed?'사건 조회 실패':'사건이 없습니다.');td.colSpan=6;tr.append(td);tbody.append(tr)}
 for(const row of rows){const tr=E('tr');[date(row.detected_at),row.synthetic?'모의':'운영',name(row.rule_id),name(row.target_id),name(row.status),'상세 확인'].forEach(t=>tr.append(E('td',t)));wire(tr,()=>openIncident(row.id));tbody.append(tr)}}
async function renderAISummary(row,g){$('.ai-title').textContent=row?name(row.rule_id):'분석 대상 없음';$('.ai-body p').textContent=row?'분석 결과를 조회하고 있습니다.':'최근 사건이 없습니다.';$('.ai-action button').disabled=!row;if(!row)return;
 try{const d=await api('/api/incidents/'+encodeURIComponent(row.id));if(g!==state.generation)return;const job=d.jobs.find(j=>j.kind==='ai');$('.ai-title').textContent=name(row.rule_id)+' · '+name(job?.status);$('.ai-body p').textContent=job?.result?.summary||'저장된 AI 요약이 없습니다.';$('.ai-body p').classList.add('ai-summary-clamp');$('.ai-action button').onclick=()=>openIncident(row.id)}catch(e){if(g===state.generation)$('.ai-body p').textContent='AI 결과 조회 실패 · '+e.message}}
async function showIncidentList(g){page.append(E('h2','사건 관리'));const tools=E('div',undefined,'toolbar');for(const [key,text]of [['open','열린 사건'],['closed','종료 이력']])tools.append(button(text,()=>{state.filter=key;state.page=1;remember();loadView()}));page.append(tools);const d=await api('/api/incidents?status='+state.filter+'&page='+state.page);if(g!==state.generation)return;page.append(E('p','전체 '+d.total+'건 · '+state.page+'페이지'));for(const row of d.items){const e=E('article',undefined,'incident-card');e.append(E('h3',(row.synthetic?'[모의] ':'')+name(row.rule_id)),E('p',name(row.status)+' · '+name(row.target_id)+' · '+date(row.detected_at)),button('상세 보기',()=>openIncident(row.id)));page.append(e)}if(!d.items.length)page.append(E('p','해당 사건이 없습니다.'));const nav=E('div',undefined,'toolbar'),prev=button('이전',()=>{state.page--;remember();loadView()}),next=button('다음',()=>{state.page++;remember();loadView()});prev.disabled=state.page<=1;next.disabled=state.page*20>=d.total;nav.append(prev,next);page.append(nav);feedback(modeNote())}
async function openIncident(id){if(state.busy)return;const key='incident-'+id;if(state.overlay&&state.overlay!==key){state.overlay=null;detail.close()}modal('사건 상세','조회 중…',key);const generation=state.generation;try{const d=await api('/api/incidents/'+encodeURIComponent(id));if(!state.user){detail.close();return}if(state.overlay!==key||generation!==state.generation)return;incidentDetail(d)}catch(e){if(state.overlay===key&&generation===state.generation)modal('사건 조회 실패',e.message)}}
function pretty(value){return E('pre',JSON.stringify(value,null,2),'json-output')}
function incidentDetail(d){const root=E('div');root.append(E('h3',(d.synthetic?'[모의] ':'')+name(d.rule_id)),E('p',d.id),E('p',name(d.target_id)+' · '+name(d.status)),E('p','발생 '+date(d.detected_at)+' · 종료 '+date(d.closed_at)));
 root.append(E('h3','AI · Slack 처리'));for(const j of d.jobs){const box=E('article',undefined,'job-card');box.append(E('b',name(j.kind)+' · '+name(j.status)),E('p',(j.attempts??'미제공')+'회 시도 · '+(j.mode==='live'?'실제 연결':j.mode==='demo'?'시험 모드':j.mode||'모드 미제공')));if(j.error_code)box.append(E('p',j.error_code));if(j.result){for(const [key,label]of [['summary','요약'],['hypotheses','원인 후보 (추정)'],['evidence_ids','근거 ID'],['next_checks','추가 확인'],['limitations','분석 한계']]){if(j.result[key])box.append(E('b',label),E('p',Array.isArray(j.result[key])?j.result[key].join('\n'):j.result[key]))}}const history=E('details');history.append(E('summary','시도 이력'),pretty(j.history||[]));box.append(history);root.append(box)}
 root.append(E('h3','탐지 근거'));for(const ev of d.evidence||[]){const e=E('details');e.append(E('summary',ev.id+' · '+date(ev.occurred_at)),pretty(ev.payload));root.append(e)}if(!d.evidence?.length)root.append(E('p','근거 상세가 제공되지 않았습니다.'));
 root.append(E('h3','접수 · 조치 · 종료 이력'));for(const a of d.actions||[])root.append(E('p',date(a.created_at)+' · '+a.content));if(d.resolution)root.append(E('p','종료 근거: '+d.resolution));
 if(!state.mode.writes_enabled||state.mode.mode==='snapshot')root.append(E('p','조회 전용입니다. 사건 상태와 조치 기록을 변경하지 않습니다.','notice'));
 else{if(d.status==='new')root.append(button('사건 접수',()=>mutate(d.id,'accept',{})));
 if(['accepted','in_progress'].includes(d.status)){const form=E('form');form.append(E('label','조치 내용'));const input=E('textarea');input.maxLength=1000;input.required=true;input.setAttribute('aria-label','조치 내용');input.id='action-content';form.append(input,button('조치 기록 저장',()=>form.requestSubmit()));form.onsubmit=e=>{e.preventDefault();mutate(d.id,'actions',{content:input.value})};root.append(form)}
 if(d.status==='in_progress'){root.append(E('h3','복구 확인 · 사건 종료'));for(const reason of d.closure?.reasons||[])root.append(E('p',reasons[reason]||reason));const form=E('form');const input=E('textarea');input.required=true;input.maxLength=1000;input.setAttribute('aria-label','종료 근거');input.id='resolution';form.append(E('label','종료 근거'),input);let check;if(d.rule_id==='login_failures'){check=E('input');check.type='checkbox';check.required=true;const label=E('label');label.append(check,'시험 입력을 중지했습니다.');form.append(label)}const submit=button('사건 종료',()=>form.requestSubmit());form.append(submit);form.onsubmit=e=>{e.preventDefault();const payload={resolution:input.value};if(check)payload.test_stopped=check.checked;mutate(d.id,'close',payload)};root.append(form)}}
 modal('사건 상세',root);if(window.SchutzDrafts&&state.mode.writes_enabled)window.SchutzDrafts.attach(d,api)}
async function mutate(id,kind,payload){if(state.busy||!state.mode.writes_enabled)return;state.busy=true;const controls=[...detail.querySelectorAll('button')];controls.forEach(b=>b.disabled=true);let warning;
 try{await api('/api/incidents/'+encodeURIComponent(id)+'/'+kind,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},body:JSON.stringify(payload)});warning='처리 결과를 저장했습니다.'}
 catch(e){warning=e.message+(Array.isArray(e.details)?'\n'+e.details.map(r=>reasons[r]||r).join('\n'):'');if(!e.status)warning+=' 요청 결과를 확인하기 전에는 같은 작업을 다시 보내지 마세요.';if(e.status===403)try{await restoreContext(false)}catch{}}
 finally{state.busy=false;controls.forEach(b=>b.disabled=false)}
 if(state.user){await loadView();await openIncident(id);const p=E('p',warning,'notice');$('#detail-body').prepend(p)}}
function pageTitle(title,o){page.append(E('h2',title),E('p',date(o.range_start)+' ~ '+date(o.as_of)+' (KST) · '+o.step_seconds+'초 간격'))}
function metricSummary(label,metric,unit){const card=E('article',undefined,'read-stat');card.append(E('p',label),E('strong',metric?.status==='ok'?fmt(metric.value)+' '+unit:name(metric?.status||'unknown')));return card}
function showServices(o){
 const titles={app:'FastAPI 모니터링',database:'데이터베이스 모니터링',proxy:'Nginx / 프록시 모니터링'};pageTitle(titles[state.service],o);
 const service=state.dashboard?.servers?.find(x=>x.target_id===state.service),summary=E('div',undefined,'service-check');summary.append(E('b','기능 점검: '+(service&&!service.collection_delayed?name(service.status):'미확인')),E('span','최근 점검 '+date(service?.last_checked_at)));page.append(summary);
 const cards=E('div',undefined,'read-stats');
 if(state.service==='app'){for(const[k,label,unit]of [['requests','HTTP 요청량','건/초'],['errors','5xx 서버 오류','건/초'],['app_ms','응답시간 p95','ms']])cards.append(metricSummary(label,o.metrics?.[k],unit))}
 if(state.service==='database'){cards.append(metricSummary('앱의 DB 작업시간 p95',o.metrics?.db_ms,'ms'));cards.append(metricSummary('DB 연결 수',null,''),metricSummary('활성 세션',null,''))}
 if(state.service==='proxy')page.append(E('p','경로별 프록시 지표입니다. 전체 합산 p95와 구분합니다.','read-muted'));
 page.append(cards);
 const selected=state.service==='app'?['app_routes','app_p95_routes']:state.service==='database'?[]:['proxy_requests','proxy_errors','proxy_p95','upstream_p95'];
 const descriptions={app_routes:['경로별 요청량','건/초',1],app_p95_routes:['경로별 응답시간 p95','ms',1],proxy_requests:['경로별 요청량','건/초',1],proxy_errors:['경로별 5xx','건/초',1],proxy_p95:['전체 응답시간 p95','ms',1000],upstream_p95:['업스트림 응답시간 p95','ms',1000]};
 if(state.service==='database'){const box=E('article',undefined,'detail-card');box.append(E('h3','DB 작업시간 추이'));const plot=E('div',undefined,'detail-plot');chart(plot,o.metrics?.db_ms?.points,'#04a668');box.append(plot,E('p','직원 조회 기능 점검과 앱의 DB 계측 결과입니다. PostgreSQL 전체 부하나 세션 수를 뜻하지 않습니다.','read-muted'));page.append(box)}
 for(const key of selected){const[label,unit,mult]=descriptions[key],data=o.details?.[key],box=E('article',undefined,'detail-card');box.append(E('h3',label));if(data?.status!=='ok')box.append(E('p',name(data?.status||'unknown')));else if(!data.items.length)box.append(E('p','일치 시계열 없음 · 오류율 0으로 단정하지 않습니다.','read-muted'));else{const table=E('table',undefined,'read-table'),head=E('thead'),hr=E('tr');hr.append(E('th','요청 경로'),E('th',unit),E('th','추이'));head.append(hr);table.append(head);const body=E('tbody');for(const row of data.items){const tr=E('tr'),graph=E('td');tr.append(E('td',row.route),E('td',row.value===null?'미확인':fmt(row.value*mult)));const plot=E('div',undefined,'route-plot');chart(plot,row.points.map(p=>[p[0],p[1]===null?null:p[1]*mult]),'#087df3');graph.append(plot);tr.append(graph);body.append(tr)}table.append(body);box.append(table)}page.append(box)}
}
function showResources(o){pageTitle('서버 리소스',o);for(const host of o.resources.items){const box=E('article',undefined,'detail-card');box.append(E('h3',host.instance+' · '+name(host.status)));for(const [key,label]of [['cpu','CPU'],['memory','메모리'],['disk','루트 디스크']]){const h=host.history?.[key];box.append(E('h3',label+' '+fmt(host[key])+'%'),E('p','표본 평균 '+fmt(h?.summary?.mean)+'% · 최대 '+fmt(h?.summary?.max)+'%'));const plot=E('div',undefined,'resource-detail-plot');chart(plot,h?.points,['#1879ee','#8a51ff','#00b1b5'][['cpu','memory','disk'].indexOf(key)],100);box.append(plot)}page.append(box)}if(!o.resources.items.length)page.append(E('p','서버 자원 데이터 없음'))}
function targetLabel(t){if(t.job==='portal-health')return t.instance.includes('proxy-health')?'프록시 생존 점검':'앱 생존 점검';return {'ec2-node':'서비스 서버 자원','portal-otel':'앱 서비스 지표',prometheus:'메트릭 저장소','blackbox-exporter':'기능 점검 수집기','portal-db-health':'직원 조회 점검'}[t.job]||t.job}
function summaryCard(label,value){const card=E('article',undefined,'read-stat');card.append(E('p',label),E('strong',String(value)));return card}
function collectorContent(o){
 const root=E('div'),targetOK=o?.targets?.status==='ok',alertOK=o?.alerts?.status==='ok',targets=targetOK?o.targets.items:[],alerts=alertOK?o.alerts.items:[];
 const summary=E('div',undefined,'read-stats');for(const[label,value]of [['전체 수집 대상',targetOK?targets.length:'미확인'],['수집 성공',targetOK?targets.filter(t=>t.up===true).length:'미확인'],['수집 실패',targetOK?targets.filter(t=>t.up===false).length:'미확인'],['발생 중 경보',alertOK?alerts.length:'미확인']])summary.append(summaryCard(label,value));root.append(summary);
 const alertBox=E('section',undefined,'read-alert');alertBox.append(E('h3','발생 중 경보'));if(!alertOK)alertBox.append(E('p','경보 조회 실패 · 상태 미확인'));else if(!alerts.length)alertBox.append(E('p','조회 시점에 발생 중인 경보가 없습니다.'));else for(const a of alerts){const row=E('div',undefined,'alert-row');row.append(E('b',a.name),E('span',a.severity||'심각도 미제공'));alertBox.append(row)}root.append(alertBox);
 const section=E('section',undefined,'read-section');section.append(E('h3','수집 대상 목록'));if(!targetOK)section.append(E('p','수집 대상 조회 실패'));else{const table=E('table',undefined,'read-table');const head=E('thead'),hr=E('tr');for(const t of ['대상','수집 내용','상태','연결 정보'])hr.append(E('th',t));head.append(hr);table.append(head);const body=E('tbody');for(const t of targets){const tr=E('tr');tr.append(E('td',targetLabel(t)),E('td',roles[t.job]||(t.instance.includes('proxy-health')?'Nginx 응답 점검':'FastAPI 응답 점검')));const status=E('td');status.append(E('span',t.up===true?'수집 성공':t.up===false?'수집 실패':'미확인',t.up===true?'status-pill':'status-pill status-unknown'));tr.append(status);const cell=E('td'),extra=E('tr',undefined,'read-detail');extra.hidden=true;const td=E('td');td.colSpan=4;const dl=E('dl',undefined,'read-definitions');for(const[k,v]of [['job',t.job],['수집 주소',t.instance],['최근 수집','개별 수집 시각 미제공']])dl.append(E('dt',k),E('dd',v));td.append(dl);extra.append(td);const b=button('상세 보기',()=>{extra.hidden=!extra.hidden;b.textContent=extra.hidden?'상세 보기':'접기';b.setAttribute('aria-expanded',String(!extra.hidden))});b.setAttribute('aria-expanded','false');cell.append(b);tr.append(cell);body.append(tr,extra)}table.append(body);section.append(table)}root.append(section,E('p','수집 성공은 결과를 받아온 상태입니다. 서비스 기능 정상 여부는 별도 점검으로 판단합니다.','read-muted'));
 const logs=o?.logs;root.append(E('div','Loki · 로그 저장소: '+(logs&&Object.values(logs).every(x=>x.status==='ok')?'최근 로그 조회 성공':'이번 데이터에서 상태 미확인'),'read-note'));return root;
}
function showCollectors(o){page.append(E('h2','수집 상태'),E('p','조회 '+date(o.as_of)+' · KST','read-muted'),collectorContent(o))}
function showLogs(o){pageTitle('로그 분석',o);page.append(E('p','로그 조회 범위는 선택한 지표 기간과 별개로 최근 5분, 서비스별 최대 20건입니다.'));const input=E('input');input.type='search';input.placeholder='요청 ID · 경로 · 이벤트 검색';input.setAttribute('aria-label','로그 검색');page.append(input);const rows=E('div');page.append(rows);function render(){rows.replaceChildren();for(const service of ['portal-api','portal-nginx']){const data=o.logs?.[service],section=E('section',undefined,'detail-card');section.append(E('h3',service));if(data?.status!=='ok')section.append(E('p',name(data?.status||'unknown')));else{const list=data.items.filter(x=>JSON.stringify(x.fields).toLowerCase().includes(input.value.toLowerCase()));if(!list.length)section.append(E('p','일치 로그 없음'));for(const row of list){const e=E('details');e.append(E('summary',date(row.collected_at)+' · '+(row.fields.route||'other')+' · '+(row.fields.event_type||row.fields.status||'')),pretty(row.fields));section.append(e)}}rows.append(section)}}input.oninput=render;render()}
function definitionPanel(title,rows){const panel=E('section',undefined,'settings-card');panel.append(E('h3',title));const dl=E('dl',undefined,'settings-definitions');for(const[k,v]of rows){const row=E('div');row.append(E('dt',k),E('dd',v));dl.append(row)}panel.append(dl);return panel}
function showSettings(){
 const snapshot=state.mode.mode==='snapshot';page.append(E('h2','설정'),E('p','접속 환경 · 계정 · 데이터 표시 기준','read-muted'),E('div',snapshot?'저장 데이터 모드 · 실시간 서버 연결 없음':'기존 Management Web API 연결','read-note'));
 const grid=E('div',undefined,'settings-grid');grid.append(definitionPanel('연결 · 데이터',[['데이터 방식',snapshot?'저장본 조회':'실제 API 조회'],['조회 시각',date(state.data?.as_of||state.mode.as_of)],['시간대','한국 시간 · KST'],['지표 범위',{'live':'최근 15분','15m':'최근 15분','1h':'최근 1시간','6h':'최근 6시간','24h':'최근 24시간'}[state.window]],['자동 갱신',snapshot?'사용 안 함':state.window==='live'?'30초 간격':'수동 새로고침']]));
 const account=definitionPanel('계정 · 사용 범위',[['표시 계정',state.user.username],['사용 방식',state.mode.writes_enabled&&!snapshot?'조회·사건 처리':'조회 전용'],['사건 접수 · 조치 · 종료',state.mode.writes_enabled&&!snapshot?'사용 가능':'변경 불가'],['서버 로그인',snapshot?'사용하지 않음':'관리자 세션 사용']]);if(snapshot)account.append(E('p','저장본 모드에는 로그아웃할 서버 세션이 없습니다.','read-muted'));else account.append(button('로그아웃',logout));grid.append(account);page.append(grid,E('p','이 화면은 연결 정보 확인용입니다. 서버 설정·인증 정보를 변경하지 않습니다.','read-note'));
 const help=E('details',undefined,'read-help');help.append(E('summary','갱신 및 AI 결과 표시 기준'),E('p','실제 API 연결 후 실시간을 선택하면 30초마다 다시 조회합니다. 화면 조회로 AI 재분석이나 Slack 발송을 실행하지 않습니다.'),E('p','AI 결과는 서버에 저장된 원문을 표시합니다. 자동 번역은 별도 구현 전입니다.'));page.append(help)
}
const alertPanel=E('section',undefined,'alert-popover');alertPanel.hidden=true;alertPanel.setAttribute('aria-label','경보 알림');header.append(alertPanel);const bell=$('.notify');bell.setAttribute('aria-expanded','false');
function closeAlerts(){alertPanel.hidden=true;bell.setAttribute('aria-expanded','false')}
function toggleAlerts(){if(!alertPanel.hidden){closeAlerts();return}alertPanel.replaceChildren();const o=state.data;const head=E('div',undefined,'alert-popover-head');head.append(E('h3','경보 알림'),button('닫기',closeAlerts));alertPanel.append(head);
 if(o?.alerts?.status!=='ok')alertPanel.append(E('p','경보를 조회하지 못했습니다.','alert-empty'));else if(!o.alerts.items.length)alertPanel.append(E('div','발생 중인 경보가 없습니다.','alert-empty'));else for(const a of o.alerts.items){const row=E('article',undefined,'alert-row');row.append(E('b',a.name),E('span',a.severity||'심각도 미제공'));alertPanel.append(row)}
 const targets=o?.targets?.status==='ok'?o.targets.items:null;alertPanel.append(E('div','수집 대상 '+(targets?targets.filter(t=>t.up).length+' / '+targets.length+' 응답':'미확인'),'read-note'),E('p','조회 '+date(o?.as_of)+' · KST','read-muted'),button('수집 상태 보기 →',()=>{closeAlerts();go('collectors')}));alertPanel.hidden=false;bell.setAttribute('aria-expanded','true')}
window.addEventListener('keydown',e=>{if(e.key==='Escape')closeAlerts()});window.addEventListener('click',e=>{if(!alertPanel.contains(e.target)&&!bell.contains(e.target))closeAlerts()});
async function boot(){$('#auth-message').textContent='로그인 상태를 확인하고 있습니다…';$('#auth-retry').hidden=true;$('#login-form').hidden=true;
 try{try{const r=await fetch('/local/status',{cache:'no-store'});if(r.ok)state.mode=await r.json()}catch{}if(state.mode.mode==='snapshot'){state.window='15m';$$('.periods button').forEach(b=>{b.disabled=b.dataset.window!=='15m'})}await restoreContext()}
 catch(e){app.hidden=true;$('#auth-screen').hidden=false;$('#auth-message').textContent='연결 확인 실패 · '+e.message;$('#auth-retry').hidden=false}}
boot();
})();
