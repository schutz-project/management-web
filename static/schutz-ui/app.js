/* Existing Management Web API adapter. No external dependency. */
(()=>{'use strict';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const state={user:null,csrf:null,view:'dashboard',service:'app',serviceScales:{app:'full',database:'full',proxy:'full'},graphScale:'full',resourceKey:'cpu',resourceHost:null,overlay:null,window:'15m',incidentScope:'operational',customRange:null,filter:'open',q:'',severity:'all',stage:'all',listScroll:0,page:1,generation:0,busy:false,timer:null,data:null,dashboard:null,mode:{mode:'live',writes_enabled:false}};
const labels={new:'신규',accepted:'접수',in_progress:'조치 중',closed:'종료',normal:'정상',abnormal:'이상',unknown:'미확인',succeeded:'성공',failed:'실패',pending:'대기',running:'실행 중',availability_failure:'가용성 장애',response_delay:'응답 지연',login_failures:'반복 로그인 실패',unauthorized_read:'비인가 정보 조회 시도',unauthorized_write:'비인가 데이터 변경 시도',slack_closed:'사건 종료 Slack 알림',app:'FastAPI',database:'직원 조회',proxy:'Nginx', 'portal-login':'로그인 감시',ai:'AI 분석',slack:'최초 Slack 알림',slack_ai:'AI 완료 Slack 알림',slack_recovery:'복구 Slack 알림',monitoring_target_down:'수집 대상 연결 실패',portal_telemetry_missing:'앱 메트릭 누락',portal_high_error_rate:'5xx 비율 증가',notification_delivery_test:'알림 전달 시험',stale:'수집 지연',unavailable:'조회 실패',no_data:'데이터 없음'};
const reasons={DELIVERY_SUCCESS_REQUIRED:'최초 Slack·AI 분석·AI 완료 Slack의 실제 처리 성공이 필요합니다.',PROMETHEUS_RECOVERY_NOT_CONFIRMED:'최신 Prometheus 평가와 실제 정상 지표가 두 번 확인되어야 합니다.',ACTION_REQUIRED:'조치 기록이 필요합니다.',TEST_STOP_REQUIRED:'시험 입력 중지 확인이 필요합니다.',LOG_COLLECTION_STALE:'로그 수집이 지연되고 있습니다.',FAILURE_FREE_WINDOW_REQUIRED:'해당 대상의 추가 실패·거부 관측 없이 60초가 지나야 합니다.',TWO_HEALTHY_CHECKS_REQUIRED:'정상 점검 2회 연속이 필요합니다.',CHECK_COLLECTION_STALE:'최근 정상 점검이 필요합니다.'};
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
 detail.classList.toggle('incident-dialog',state.overlay?.startsWith('incident-'));$('#detail-close').hidden=!!content?.classList?.contains('incident-workspace');$('#detail-title').textContent=title;const body=$('#detail-body');body.replaceChildren();body.append(typeof content==='string'?E('p',content):content);
 if(!detail.open)detail.showModal();if(entering)remember(true,true);
}
function closeOverlay(){
 if(state.busy){feedback('처리 중입니다. 결과를 확인한 뒤 닫아주세요.');return}
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
 state.overlay=null;detail.close();incidentDrafts.clear();incidentParents.clear();remember(false);app.hidden=true;$('#auth-screen').hidden=false;$('#auth-message').textContent=message;$('#login-form').hidden=false;$('#password').value='';page.replaceChildren();dash.hidden=true;
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
async function refreshPermissions(){
 if(state.mode.local_mode||state.mode.mode==='snapshot')return;
 state.mode.writes_enabled=false;
 try{const c=await api('/api/management/capabilities');state.mode.writes_enabled=c.mode==='live'&&c.writes_enabled===true}catch{}
}
async function enter(){await refreshPermissions();if(!state.user)return;app.hidden=false;$('#auth-screen').hidden=true;$('.profile').textContent=state.user.username+' ▾';dash.hidden=false;
 remember(false);await loadView();await restoreOverlay();clearInterval(state.timer);state.timer=setInterval(()=>{if(state.window==='live'&&!document.hidden&&!state.busy&&!detail.open)loadView()},30000);
}
$('#login-form').onsubmit=async e=>{e.preventDefault();if(state.busy)return;state.busy=true;$('#login-button').disabled=true;
 try{if(!state.csrf)await restoreContext(false);const data=await api('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},body:JSON.stringify({username:$('#username').value.trim(),password:$('#password').value})});state.user=data.user;state.csrf=data.csrf_token;if(state.user?.role!=='admin'){signedOut('관리자 계정으로 로그인해 주세요.');return}await enter()}
 catch(err){$('#auth-message').textContent=err.message;try{await restoreContext(false)}catch{}$('#auth-message').textContent=err.message}
 finally{state.busy=false;$('#password').value='';$('#login-button').disabled=!state.csrf}};
$('#auth-retry').onclick=()=>boot();
async function logout(){if(state.mode.mode==='snapshot'){modal('저장 데이터 모드','서버 로그인 없이 저장 데이터를 표시 중입니다.');return}if(state.busy)return;state.busy=true;try{await api('/api/auth/logout',{method:'POST',headers:{'X-CSRF-Token':state.csrf}});signedOut('로그아웃했습니다.');await restoreContext(false)}catch(e){feedback(e.message,true)}finally{state.busy=false}}
wire($('.profile'),()=>{const p=E('div');p.append(E('p','로그인 계정: '+state.user.username),button('로그아웃',async()=>{detail.close();await logout()}));modal('계정',p)});
const DAY_MS=86400000, YEAR_MS=365*DAY_MS;
function locationState(){const p=new URLSearchParams(location.hash.slice(1));state.incidentScope=['operational','synthetic','all'].includes(p.get('incident_scope'))?p.get('incident_scope'):'operational';const v=p.get('view');state.view=['dashboard','incidents','services','resources','collectors','logs','settings'].includes(v)?v:'dashboard';const w=p.get('window');state.window=['live','15m','1h','6h','24h','custom'].includes(w)?w:'15m';state.customRange=validCustomRange(p.get('start'),p.get('end'));if(state.window==='custom'&&!state.customRange)state.window='15m';state.resourceKey=['cpu','memory','disk'].includes(p.get('resource'))?p.get('resource'):'cpu';state.resourceHost=(p.get('host')||'').slice(0,120)||null;state.service=['app','database','proxy','homepage','community'].includes(p.get('service'))?p.get('service'):'app';state.overlay=/^(?:incident-[a-f0-9-]{36}|info-[0-9]+)$/.test(p.get('overlay')||'')?p.get('overlay'):null;state.filter=['open','closed','all'].includes(p.get('status'))?p.get('status'):'open';state.q=(p.get('q')||'').slice(0,80);state.severity=['all','critical','warning','unknown'].includes(p.get('severity'))?p.get('severity'):'all';state.stage=['all','new','accepted','in_progress','closed'].includes(p.get('stage'))?p.get('stage'):'all';state.page=Math.max(1,Math.min(100000,Number(p.get('page'))||1));const direct=!location.hash&&/^\/incidents\/([a-f0-9-]{36})$/.exec(location.pathname);if(direct){state.view='incidents';state.overlay='incident-'+direct[1]}}
function remember(push=true,overlay=false){const p=new URLSearchParams({view:state.view,window:state.window});if(state.incidentScope!=='operational')p.set('incident_scope',state.incidentScope);if(state.view==='incidents'){p.set('status',state.filter);p.set('page',String(state.page));if(state.q)p.set('q',state.q);if(state.severity!=='all')p.set('severity',state.severity);if(state.stage!=='all')p.set('stage',state.stage)}if(state.view==='services')p.set('service',state.service);if(state.view==='resources'){p.set('resource',state.resourceKey);if(state.resourceHost)p.set('host',state.resourceHost)}if(state.overlay)p.set('overlay',state.overlay);if(state.window==='custom'&&state.customRange){p.set('start',state.customRange.start);p.set('end',state.customRange.end)}const hash='#'+p;const marker={schutz:true,schutzOverlay:overlay,listScroll:state.listScroll};if(push&&location.hash!==hash)history.pushState(marker,'',hash);else history.replaceState(push?(history.state||marker):marker,'',hash)}
function go(v,filter,service){if(state.busy)return;state.overlay=null;detail.close();state.view=v;if(filter)state.filter=filter;if(service)state.service=service;state.page=1;remember();loadView();window.scrollTo?.({top:0,behavior:'instant'})}
locationState();window.addEventListener('popstate',async()=>{locationState();detail.close();if(state.user){await loadView();await restoreOverlay();if(!state.overlay&&state.view==='incidents')window.scrollTo?.({top:history.state?.listScroll||0,behavior:'instant'})}});
const views=['dashboard','incidents','services','resources','collectors','logs','settings'];
$$('.nav>a').forEach((a,i)=>{a.href='#view='+views[i];a.onclick=e=>{e.preventDefault();go(views[i])}});
const periods=['live','15m','1h','6h','24h'];$$('.periods button').forEach((b,i)=>{b.dataset.window=periods[i];b.onclick=()=>{state.overlay=null;detail.close();state.window=periods[i];remember();loadView()}});
const calendarButton=button('사용자 지정 📅',()=>openCalendar());calendarButton.dataset.window='custom';calendarButton.className='custom-period';$('.periods').append(calendarButton);
function earliestCustomDate(now){return Math.floor((now+9*3600000)/DAY_MS)*DAY_MS-9*3600000-YEAR_MS}
function minuteStart(value){return Math.floor(value/60000)*60000}
function validCustomRange(start,end){
 if(!start||!end)return null;
 const a=Date.parse(start),b=Date.parse(end),now=Date.now();
 if(!(Number.isFinite(a)&&Number.isFinite(b)&&b-a>=60000&&b-a<=YEAR_MS&&a>=earliestCustomDate(now)&&b<=now+5000))return null;
 // Date truncates sub-millisecond precision, which the API uses for the inclusive end of day.
 const fraction=/\.(\d{6})(?:Z|[+-]\d{2}:\d{2})$/.exec(end)?.[1];
 const endIso=new Date(b).toISOString();
 return {start:new Date(a).toISOString(),end:fraction?endIso.replace(/\.\d{3}Z$/,'.'+fraction+'Z'):endIso};
}
function kstInput(value){return new Date(value+9*3600000).toISOString().slice(0,16)}
function openCalendar(){
 if(state.mode.mode==='snapshot')return;
 const form=E('form',undefined,'calendar-form'),now=minuteStart(Date.now());
 const min=kstInput(earliestCustomDate(now)).slice(0,10),max=kstInput(now).slice(0,10);
 const presets=E('div',undefined,'calendar-presets');
 const fields=E('div',undefined,'calendar-fields');
 const inputs={};
 for(const [id,label] of [['start','시작'],['end','종료']]){
  const group=E('div',undefined,'calendar-field');
  const day=E('input'),hour=E('input');
  day.id='range-'+id;day.type='date';day.required=true;day.min=min;day.max=max;
  hour.id='range-'+id+'-time';hour.type='text';hour.placeholder='HH:MM';hour.maxLength=5;
  for(const [input,title] of [[day,label+' 날짜'],[hour,label+' 시간 (선택, 24시간제)']]){
   const fieldLabel=E('label',title);fieldLabel.setAttribute('for',input.id);group.append(fieldLabel,input);
  }
  inputs[id]={day,hour};
  fields.append(group);
 }
 function fill(start,end){
  for(const [id,value] of [['start',start],['end',end]]){
   const [day,hour]=kstInput(value).split('T');
   inputs[id].day.value=day;inputs[id].hour.value=hour;
  }
 }
 const error=E('p',undefined,'calendar-error');error.setAttribute('role','alert');
 for(const [label,days] of [['최근 7일',7],['최근 30일',30],['최근 90일',90],['최근 1년',365]]){
  presets.append(button(label,()=>{const end=minuteStart(Date.now());fill(end-days*DAY_MS,end);error.textContent=''}));
 }
 fill(state.customRange?Date.parse(state.customRange.start):now-7*DAY_MS,
      state.customRange?Date.parse(state.customRange.end):now);
 if(!state.customRange){
  inputs.start.hour.value='';inputs.end.hour.value='';
 }else if(kstInput(Date.parse(state.customRange.end)).endsWith('T23:59')&&state.customRange.end.endsWith(':59.999999Z')){
  inputs.end.hour.value='';
 }
 const submit=E('button','조회 적용','outline');submit.type='submit';
 form.append(presets,fields,E('p','KST 기준 최근 365일을 조회할 수 있습니다. 시간을 비우면 시작일 00:00부터 종료일 마지막까지 조회하며, 종료일이 오늘이면 현재 시각까지 조회합니다.','read-muted'),error,submit);
 form.onsubmit=e=>{
  e.preventDefault();
  const current=Date.now(),today=kstInput(current).slice(0,10);
  const startTime=inputs.start.hour.value.trim()||'00:00';
  const endTime=inputs.end.hour.value.trim();
  const endDay=inputs.end.day.value;
  const clockPattern=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if(!clockPattern.test(startTime)||(endTime&&!clockPattern.test(endTime))){error.textContent='시간을 24시간제 HH:MM으로 입력해 주세요. 예: 09:30, 18:00';return}
  const end=endTime?endDay+'T'+endTime+'+09:00':endDay===today?new Date(current).toISOString():endDay+'T23:59:59.999999+09:00';
  const range=validCustomRange(inputs.start.day.value+'T'+startTime+'+09:00',end);
  if(!range){error.textContent='기간을 확인해주세요. 최근 365일 안에서 시작과 종료를 1분 이상 차이 나게 선택하세요.';return}
  state.customRange=range;state.window='custom';state.overlay=null;
  detail.close();remember(false);loadView();
 };
 modal('사용자 지정 기간',form);
}
$('#refresh').onclick=()=>loadView();wire($('.notify'),()=>toggleAlerts());
function observationParams(){const params=new URLSearchParams({window:state.window==='live'?'15m':state.window});if(state.window==='custom'&&state.customRange){params.set('start',state.customRange.start);params.set('end',state.customRange.end)}return params}
async function getObservation(){return api('/api/observability?'+observationParams())}
async function loadView(){if(!state.user)return;const g=++state.generation;feedback('조회 중…');dash.hidden=state.view!=='dashboard';page.hidden=state.view==='dashboard';page.replaceChildren();closeAlerts();$('.heading h1').textContent={dashboard:'운영 대시보드',incidents:'사건 관리',services:'서비스 모니터링',resources:'서버 리소스',collectors:'수집 상태',logs:'로그 분석',settings:'설정'}[state.view];
 $$('.nav>a').forEach((a,i)=>a.classList.toggle('active',views[i]===state.view));$$('.periods button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.window===state.window)));
 try{
 const dashboardRequest=api('/api/dashboard'), observationRequest=getObservation();
 if(state.view!=='dashboard')refreshNotificationIndicators(g,dashboardRequest,observationRequest);
 if(state.view==='settings'){showSettings();feedback('');return}
 if(state.view==='incidents'){await showIncidentList(g);return}
 const historicalDashboard=state.view==='dashboard'&&state.window==='custom';
 const jobs=state.view==='dashboard'?[dashboardRequest,observationRequest,historicalDashboard?null:api('/api/incidents?status=open&page=1'),historicalDashboard?null:api('/api/incidents?status=closed&page=1'),api('/api/dashboard/incident-overview?'+observationParams()+'&scope='+state.incidentScope)]:state.view==='services'?[observationRequest,dashboardRequest]:[observationRequest];
 const res=await Promise.allSettled(jobs);if(g!==state.generation||!state.user)return;
 if(state.view==='dashboard'){
  const [dr,ob,op,cl,overview]=res;state.dashboard=dr.status==='fulfilled'?dr.value:null;state.data=ob.status==='fulfilled'?ob.value:null;
  renderDashboard(state.dashboard,state.data,overview.status==='fulfilled'?overview.value:null);
  const historicalRows=overview.status==='fulfilled'?overview.value.recent_detected:null;
  const rows=historicalDashboard?(Array.isArray(historicalRows)?historicalRows:[]):[...(op.status==='fulfilled'?op.value.items:[]),...(cl.status==='fulfilled'?cl.value.items:[])].sort((a,b)=>Date.parse(b.detected_at)-Date.parse(a.detected_at)).slice(0,5);
  $('#incidents .panel-head h2').textContent=historicalDashboard?'선택 기간에 발생한 사건':'최근 보안 · 장애 사건';
  const listFailed=historicalDashboard?!Array.isArray(historicalRows):op.status==='rejected'||cl.status==='rejected';
  renderIncidents($('#incidents tbody'),rows,listFailed);
  await renderAISummary(rows[0],g,listFailed);
 }else{if(res[0].status==='rejected')throw res[0].reason;state.data=res[0].value;if(state.view==='services'){state.dashboard=res[1].status==='fulfilled'?res[1].value:null;showServices(state.data);}else if(state.view==='resources')showResources(state.data);else if(state.view==='collectors')showCollectors(state.data);else if(state.view==='logs')showLogs(state.data)}
 if(g!==state.generation||!state.user)return;const failed=res.some(r=>r.status==='rejected');feedback(failed?'일부 조회에 실패했습니다. 실패 항목은 미확인으로 표시합니다.':modeNote(),failed);
 }catch(e){if(g!==state.generation)return;feedback(e.message,true);if(!page.hidden)page.append(E('p','데이터를 가져오지 못했습니다. 새로고침으로 다시 확인해 주세요.'))}}
function modeNote(){if(state.window==='custom')return '사용자 지정 기간 · '+date(state.customRange?.start)+' ~ '+date(state.customRange?.end)+' (KST) · 사건 집계·목록과 과거 지표에 적용 · 상단 상태·경보·최근 로그는 현재 조회 기준';return state.mode.mode==='snapshot'?'저장 데이터 모드 · '+date(state.data?.as_of||state.mode.as_of)+' (KST) · 실시간 아님':(state.window==='live'?'30초마다 조회 · ':'')+'한국 시간(KST) · '+(state.mode.writes_enabled?'조회·사건 처리 연결':'조회 전용 · 사건 변경 비활성화')}
const NS='http://www.w3.org/2000/svg';function svg(t,a,text){const e=document.createElementNS(NS,t);for(const[k,v]of Object.entries(a))e.setAttribute(k,v);if(text!==undefined)e.textContent=text;return e}
function chart(holder,points,color,ceiling=null){holder.replaceChildren();const data=points||[],values=data.filter(p=>Number.isFinite(p[1]));if(!values.length){holder.append(E('small','그래프 데이터 없음'));return}const resource=ceiling!==null,w=resource?280:150,h=resource?110:36,l=resource?34:3,r=8,t=12,b=resource?22:4,max=ceiling||Math.max(...values.map(p=>p[1]),.001),start=data[0][0],end=data.at(-1)[0];const X=x=>l+(x-start)/(end-start||1)*(w-l-r),Y=y=>t+(1-y/max)*(h-t-b);const s=svg('svg',{viewBox:`0 0 ${w} ${h}`,width:'100%',height:'100%',role:'img','aria-label':resource?'사용률 0~100% · 실제 조회 표본':'실제 조회 표본 추이'});
 if(resource){for(const v of [0,50,100]){s.append(svg('line',{x1:l,x2:w-r,y1:Y(v),y2:Y(v),stroke:'#e1e9f3'}));s.append(svg('text',{x:0,y:Y(v)+3,'font-size':10,fill:'#6e85a1'},v+'%'))}for(const v of [start,end])s.append(svg('text',{x:X(v),y:h-3,'text-anchor':v===start?'start':'end','font-size':10,fill:'#6e85a1'},clock(v)))}
 let segment=[];const draw=()=>{if(segment.length)s.append(svg('polyline',{points:segment.map(p=>X(p[0])+','+Y(p[1])).join(' '),fill:'none',stroke:color,'stroke-width':2}));segment=[]};let prev=null;for(const p of data){if(!Number.isFinite(p[1])||(prev&&p[0]-prev>(state.data?.step_seconds||30)*1500))draw();if(Number.isFinite(p[1]))segment.push(p);prev=p[0]}draw();holder.append(s)}
function renderDashboard(d,o,overview){
 $('.heading h1').textContent='운영 대시보드';$('.demo-ribbon').textContent=state.mode.mode==='snapshot'?'실제 데이터 저장본 · 실시간 아님':'API 연결 · '+(state.mode.writes_enabled?'사건 처리 가능':'조회 전용');
 $('.banner-meta .meta-label').textContent='조회 시각 (KST)';$('.meta-value').textContent=date(d?.as_of||o?.as_of);const c=d?.incident_counts;const open=c?c.new+c.accepted+c.in_progress:null;const servers=d?.servers||[];const known=['app','database','proxy'].every(id=>servers.some(x=>x.target_id===id))&&servers.every(x=>x.status==='normal'&&!x.collection_delayed);
 $('.banner h2').textContent=!d?'상태를 확인하지 못했습니다.':open?'확인이 필요한 열린 사건이 있습니다.':known?'조회 시점에 열린 사건이 없고 기능 점검이 정상입니다.':'열린 사건은 없지만 점검 상태를 확인해야 합니다.';
 $('.banner p').textContent='수집 상태와 서비스 기능 상태를 구분합니다. '+(state.mode.mode==='snapshot'?'저장본 기준입니다.':'마지막 조회 결과입니다.');
 $('.side-status').replaceChildren(E('div','시스템 상태'),E('p',!d?'미확인':known?'기능 점검 정상':'점검 확인 필요'),E('div','조회 시각'),E('p',date(d?.as_of||o?.as_of)));
 const targets=o?.targets?.status==='ok'?o.targets.items:null;const vals=[c?.new,c?c.accepted+c.in_progress:null,c?.closed,targets?targets.filter(t=>t.up).length+' / '+targets.length:null];const notes=['관리자 대응 대기','접수 · 조치 진행','전체 종료 이력','Prometheus 수집 대상'];
 $$('.kpi').forEach((e,i)=>{e.querySelector('strong').textContent=vals[i]===undefined||vals[i]===null?'미확인':String(vals[i])+(i<3?' 건':'');e.querySelector('div:nth-child(2)>small').textContent=notes[i];wire(e,()=>go(i===3?'collectors':'incidents',i===2?'closed':'open'))});$$('.kpi')[2].querySelector('h3').textContent='종료 사건 이력';renderNotificationIndicators(d,o);
 renderServiceHealth(servers,o);renderMonitoringPaths(servers,o);renderServices(o);renderResources(o);renderIncidentOverview(overview);renderIncidentTimeline(overview);renderCollectorPreview(o);$('.footer p:last-child').textContent=modeNote();
 $('#incidents .panel-head a').onclick=e=>{e.preventDefault();go('incidents')};$('#incidents .panel-head .link').textContent='분석 이력 →';$('#incidents .panel-head .link').onclick=()=>go('incidents','closed');
 wire($('.resources .panel-head .link'),()=>go('resources'));
}
const serviceDefinitions={app:{name:'FastAPI',target:'직원 포털',label:'앱 응답시간 p95',color:'#087dff'},database:{name:'PostgreSQL',target:'애플리케이션 DB',label:'앱 DB 작업시간 p95',color:'#8b5cf6'},proxy:{name:'Nginx',target:'프록시',label:'/health 프록시 응답 p95',color:'#14b8a6'}};
function uiIcon(kind){const icon=svg('svg',{viewBox:'0 0 24 24','aria-hidden':'true',fill:'none',stroke:'currentColor','stroke-width':1.8,'stroke-linecap':'round','stroke-linejoin':'round'});const paths={resourceCurrent:['M9 2h6M12 2v3','M19 14a7 7 0 1 1-14 0a7 7 0 1 1 14 0','M12 9v5l3 2'],resourceMean:['M4 20V4M4 20h16','M8 16V10h3v6ZM14 16V6h3v10Z'],resourceMax:['M4 20V4M4 20h16','M7 16l4-6 4 3 5-8'],resourceSpread:['M4 20h16','M6 17V12h3v5ZM11 17V7h3v10ZM16 17V3h3v14Z'],app:['M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z','M15.5 12a3.5 3.5 0 1 1-7 0a3.5 3.5 0 1 1 7 0'],database:['M4 6c0-4 16-4 16 0s-16 4-16 0Z','M4 6v12c0 4 16 4 16 0V6','M4 12c0 4 16 4 16 0'],proxy:['M5 4h14v4H5Z','M5 10h14v4H5Z','M5 16h14v4H5Z','M8 6h1M8 12h1M8 18h1'],current:['M3 12h4l3-7 4 14 3-7h4'],mean:['M4 19V5M4 19h16M7 14l4-4 4 2 5-7'],max:['M12 20V4M5 11l7-7 7 7'],min:['M12 4v16M5 13l7 7 7-7'],spread:['M17 4H7l7 8-7 8h10']};for(const d of paths[kind]||paths.current)icon.append(svg('path',{d}));return icon}
function serviceMetric(o,key){if(publicRequestPaths[key])return o?.metrics?.[key+'_ms'];if(key==='app')return o?.metrics?.app_ms;if(key==='database')return o?.metrics?.db_ms;const data=o?.details?.proxy_p95,p=data?.items?.find(x=>x.route==='/health');return {status:data?.status!=='ok'?(data?.status||'unavailable'):p&&Number.isFinite(p.value)?'ok':'no_data',value:p&&Number.isFinite(p.value)?p.value*1000:null,points:(p?.points||[]).map(([t,v])=>[t,Number.isFinite(v)?v*1000:null])}}
const serviceStatusLabels={normal:'정상',delayed:'수집 지연',unknown:'확인 불가',abnormal:'점검 이상'};
function serviceState(servers,key){
 const row=servers?.find(x=>x.target_id===key);
 const kind=!Number.isFinite(Date.parse(row?.last_checked_at))?'unknown':row.collection_delayed?'delayed':row.status==='normal'?'normal':row.status==='abnormal'?'abnormal':'unknown';
 return {row,label:serviceStatusLabels[kind],kind};
}
function serviceStatusBadge(kind){
 const badge=E('span',undefined,'service-badge service-status-'+kind);
 badge.append(E('i',undefined,'service-status-dot'),E('span',serviceStatusLabels[kind]));
 return badge;
}
const publicRequestPaths={
 homepage:{label:'홈페이지 B',checks:[['app','FastAPI','헬스 체크 · /health','homepage-health'],['database','공유 PostgreSQL','조직도 조회 기능 점검','homepage-organization']]},
 community:{label:'커뮤니티 C',checks:[['app','FastAPI','헬스 체크 · /health','community-health'],['database','SQLite','질문 목록 조회 기능 점검','community-questions']]}
};
function publicProbe(o,job){
 const probe=o?.service_probes?.[job];
 return {probe,kind:probe?.success===true?'normal':probe?.success===false?'abnormal':'unknown'};
}
function renderServiceHealth(servers,o){
 const root=$('.service-health-grid');
 root.replaceChildren();
 const selector=$('#request-path-service'),selected=publicRequestPaths[selector?.value];
 if(selector)selector.onchange=()=>renderServiceHealth(servers,o);
 if(selected){
  for(const [key,title,check,job] of selected.checks){
   const {probe,kind}=publicProbe(o,job);
   const card=E('article',undefined,'service-health-card service-'+key);
   const heading=E('h3'),icon=E('span',undefined,'service-icon');
   icon.append(uiIcon(key));heading.append(icon,E('span',title));
   card.append(heading,E('p',check,'read-muted'),serviceStatusBadge(kind),
    E('small','마지막 점검 '+(probe?.checked_at?date(probe.checked_at)+' (KST)':'미확인')));
   root.append(card);
  }
  return;
 }
 const success={app:'기능 점검 성공',database:'DB 연결·기능 점검 성공',proxy:'기능 점검 성공'};
 for(const key of ['proxy','app','database']){
  const def=serviceDefinitions[key];
  const {row,kind,label}=serviceState(servers,key);
  const card=E('article',undefined,'service-health-card service-'+key);
  const heading=E('h3'),icon=E('span',undefined,'service-icon');
  icon.append(uiIcon(key));heading.append(icon,E('span',def.name));
  const status=key==='proxy'&&['normal','abnormal'].includes(kind)&&Number.isInteger(row.http_status)
   ? 'HTTP '+row.http_status : kind==='normal'?success[key]:label;
  const checks={proxy:'프록시 자체 점검 · /proxy-health',app:'앱 기능 점검 · /health',database:'직원 조회 점검'};
  card.append(heading,E('p',checks[key],'read-muted'),E('strong',status,'service-health-result'),serviceStatusBadge(kind),
   E('small','마지막 점검 '+(row?.last_checked_at?date(row.last_checked_at)+' (KST)':'미확인')));
  root.append(card);
 }
}
function serviceBadge(servers,key){const status=serviceState(servers,key),badge=serviceStatusBadge(status.kind);badge.setAttribute('title','현재 기능 점검 기준 · 최근 점검 '+date(status.row?.last_checked_at));return badge}
function metricText(metric,unit){return metric?.status==='ok'&&Number.isFinite(metric.value)?fmt(metric.value)+' '+unit:metric?.status==='stale'?'수집 지연':metric?.status==='unavailable'?'조회 실패':'데이터 없음'}
function publicMetricText(metric,unit){
 return !metric||metric.status==='no_data'?'미수집':metricText(metric,unit);
}
function auxiliary(o,key){if(publicRequestPaths[key])return [['요청량',publicMetricText(o?.metrics?.[key+'_requests'],'건/초')],['5xx 서버 오류',publicMetricText(o?.metrics?.[key+'_errors'],'건/초')]];const m=o?.metrics||{},p=o?.details,route=k=>{const d=p?.[k],r=d?.items?.find(x=>x.route==='/health');return {status:d?.status==='ok'&&Number.isFinite(r?.value)?'ok':d?.status||'no_data',value:r?.value}};return key==='app'?[['요청량',metricText(m.requests,'건/초'),m.requests],['5xx 서버 오류',metricText(m.errors,'건/초'),m.errors]]:key==='database'?[['연결 수','미수집',null],['활성 세션','미수집',null]]:[['/health 요청량',metricText(route('proxy_requests'),'건/초'),null],['/health 5xx',metricText(route('proxy_errors'),'건/초'),null]]}
function metricPoints(points){return (points||[]).filter(p=>Number.isFinite(p[0])&&Number.isFinite(p[1])&&p[1]>=0)}
function serviceStats(points){const values=metricPoints(points).map(p=>p[1]);if(!values.length)return {mean:null,max:null,min:null,std:null,count:0};const mean=values.reduce((a,b)=>a+b,0)/values.length;return {mean,max:Math.max(...values),min:Math.min(...values),std:Math.sqrt(values.reduce((a,b)=>a+(b-mean)**2,0)/values.length),count:values.length}}
function servicePlot(holder,points,color,label,compact=false,zoom=false){holder.replaceChildren();const data=points||[],valid=metricPoints(data);if(!valid.length){holder.append(E('p','데이터 없음 · 시계열 미수집 또는 조회 실패','read-muted'));return}const values=valid.map(p=>p[1]),low=Math.min(...values),high=Math.max(...values),pad=Math.max((high-low)*.2,.02),min=zoom?Math.max(0,low-pad):0,rawMax=zoom?high+pad:Math.max(high*1.1,.001),power=10**Math.floor(Math.log10(rawMax)),max=zoom?rawMax:Math.ceil(rawMax/power)*power,w=compact?320:900,h=compact?140:290,l=compact?40:60,r=12,t=15,b=26,start=data[0][0],end=data.at(-1)[0],X=x=>l+(x-start)/(end-start||1)*(w-l-r),Y=y=>t+(max-y)/(max-min)*(h-t-b);holder.append(E('p',(zoom?'변화 확대 ':'전체 표시 범위 ')+fmt(min,3)+'~'+fmt(max,3)+' ms','service-axis'));const s=svg('svg',{viewBox:`0 0 ${w} ${h}`,width:'100%',height:h,role:'img','aria-label':label+' '+fmt(min,3)+'~'+fmt(max,3)+' ms · 실제 p95 표본'});for(const v of [min,(min+max)/2,max])s.append(svg('line',{x1:l,x2:w-r,y1:Y(v),y2:Y(v),stroke:'#e3edf7'}),svg('text',{x:l-5,y:Y(v)+3,'text-anchor':'end','font-size':10,fill:'#6982a1'},fmt(v,2)));for(const v of [start,end])s.append(svg('text',{x:X(v),y:h-5,'text-anchor':v===start?'start':'end','font-size':10,fill:'#6982a1'},clock(v)));let segment=[],prev=null;const draw=()=>{if(segment.length){const coords=segment.map(p=>X(p[0])+','+Y(p[1])).join(' ');s.append(svg('polygon',{points:X(segment[0][0])+','+Y(min)+' '+coords+' '+X(segment.at(-1)[0])+','+Y(min),fill:color,'fill-opacity':.1}),svg('polyline',{points:coords,fill:'none',stroke:color,'stroke-width':2.5}))}segment=[]};for(const p of data){if(!Number.isFinite(p[1])||p[1]<0||(prev!==null&&p[0]-prev>(state.data?.step_seconds||30)*1500))draw();if(Number.isFinite(p[1])&&p[1]>=0)segment.push(p);prev=p[0]}draw();holder.append(s);if(compact)return;const dot=svg('circle',{r:4,fill:color}),cross=svg('line',{y1:t,y2:h-b,stroke:color,'stroke-dasharray':'3 3'});s.append(cross,dot);const output=E('output',undefined,'service-readout'),input=E('input',undefined,'service-scrubber');input.type='range';input.min=0;input.max=valid.length-1;input.value=valid.length-1;input.step=1;input.setAttribute('aria-label',label+' 시각별 표본 선택');const select=index=>{const p=valid[Math.max(0,Math.min(valid.length-1,index))];output.textContent=date(p[0])+' (KST) · '+fmt(p[1],3)+' ms';input.setAttribute('aria-valuetext',output.textContent);dot.setAttribute('cx',X(p[0]));dot.setAttribute('cy',Y(p[1]));cross.setAttribute('x1',X(p[0]));cross.setAttribute('x2',X(p[0]))};input.oninput=()=>select(Number(input.value));s.onpointermove=e=>{const rect=s.getBoundingClientRect(),when=start+Math.max(0,Math.min(1,(e.clientX-rect.left-l*rect.width/w)/((w-l-r)*rect.width/w)))*(end-start);let index=0;valid.forEach((p,i)=>{if(Math.abs(p[0]-when)<Math.abs(valid[index][0]-when))index=i});input.value=index;select(index)};select(valid.length-1);holder.append(output,input);if(zoom)holder.append(E('p','확대 축은 미세 변화 확인용이며 장애 임계치가 아닙니다.','read-muted'))}
function serviceAuxiliary(o,key){const grid=E('div',undefined,'service-aux');for(const [label,value]of auxiliary(o,key)){const item=E('div');item.append(E('span',label),E('strong',value));grid.append(item)}return grid}
function renderServices(o){const root=$('.services');root.replaceChildren(E('h3','직원 포털 A','service-metric-group-title'));for(const key of ['app','database','proxy','homepage','community']){const entry=publicRequestPaths[key],def=servicePerformanceDefinition(key),metric=serviceMetric(o,key),card=E('article',undefined,'service service-'+key),head=E('div',undefined,'svc-head'),identity=E('div',undefined,'service-identity'),icon=E('span',undefined,'service-icon');icon.append(uiIcon(entry?'app':key));const names=E('div');names.append(E('strong',def.name),E('small',def.target));identity.append(icon,names);head.append(identity);const data=E('div',undefined,'svc-data');data.append(E('strong',entry?publicMetricText(metric,'ms'):metric?.status==='no_data'?'미수집':metricText(metric,'ms')));const plot=E('div',undefined,'service-chart');servicePlot(plot,metric?.points,def.color,def.label,true);const caption=E('div',undefined,'svc-caption');caption.append(E('span',(o?.historical?'선택 구간 ':'최근 ')+(o?.window_minutes||'미확인')+'분 · '+date(o?.as_of)+' (KST)'),E('span','지표 수집: '+(metric?.status==='ok'?'표본 확인':entry&&!metric?'미수집':name(metric?.status||'no_data'))));card.append(head,E('p',def.label,'svc-label'),data,plot,serviceAuxiliary(o,key),caption,E('span','상세 보기 →','service-card-link'));wire(card,()=>go('services',null,key));root.append(card)}const logs=o?.logs,ok=logs&&['portal-api','portal-nginx'].every(k=>logs[k]?.status==='ok'),loki=$('.loki-status');loki.replaceChildren(E('b','로그 저장소 · Loki'),E('span',ok?'최근 5분 로그 조회 성공 · 표시 '+Object.values(logs).reduce((n,v)=>n+v.items.length,0)+'건':'로그 조회 미확인'),button('로그 분석 →',()=>go('logs')));}

function resourceValues(points){return (points||[]).filter(p=>Number.isFinite(p[0])&&Number.isFinite(p[1])&&p[1]>=0&&p[1]<=100)}
function resourceBounds(values,zoom){if(!zoom||!values.length)return [0,100];const lo=Math.min(...values.map(p=>p[1])),hi=Math.max(...values.map(p=>p[1])),pad=Math.max((hi-lo)*.2,.02);return [Math.max(0,lo-pad),Math.min(100,hi+pad)]}

function resourceChart(holder,points,color,label,options={}){holder.replaceChildren();const data=points||[],values=resourceValues(data);if(!values.length){holder.append(E('p','그래프 데이터 없음','read-muted'));return}const compact=options.compact===true,zoom=options.zoom??(state.graphScale==='zoom'),[min,max]=options.bounds||resourceBounds(values,zoom),w=compact?300:900,h=compact?100:300,l=compact?47:65,r=12,t=15,b=compact?22:32,start=options.range?.[0]??data[0][0],end=options.range?.[1]??data.at(-1)[0],X=x=>l+(x-start)/(end-start||1)*(w-l-r),Y=y=>t+(max-y)/(max-min)*(h-t-b);holder.append(E('p',zoom?'미세 변화 확대 · 축 '+fmt(min,3)+'~'+fmt(max,3)+'%':'전체 축 0~100%','resource-axis-note'));const s=svg('svg',{viewBox:`0 0 ${w} ${h}`,width:'100%',height:String(h),role:'img','aria-label':label+' 사용률 '+fmt(min,3)+'~'+fmt(max,3)+'% · 실제 조회 표본'});for(const v of [min,(min+max)/2,max]){s.append(svg('line',{x1:l,x2:w-r,y1:Y(v),y2:Y(v),stroke:'#dce7f3','stroke-dasharray':'3 3'}),svg('text',{x:l-7,y:Y(v)+4,'text-anchor':'end','font-size':11,fill:'#637d9c'},fmt(v,3)+'%'))}for(const v of [start,end])s.append(svg('text',{x:X(v),y:h-6,'text-anchor':v===start?'start':'end','font-size':11,fill:'#637d9c'},clock(v)));
 let segment=[],prev=null;const draw=()=>{if(segment.length){const coordinates=segment.map(p=>X(p[0])+','+Y(p[1])).join(' ');s.append(svg('polygon',{points:X(segment[0][0])+','+Y(min)+' '+coordinates+' '+X(segment.at(-1)[0])+','+Y(min),fill:color,'fill-opacity':'.11'}),svg('polyline',{points:coordinates,fill:'none',stroke:color,'stroke-width':3,'stroke-linecap':'round','stroke-linejoin':'round'}))}segment=[]};for(const p of data){const valid=Number.isFinite(p[1])&&p[1]>=0&&p[1]<=100;if(!valid||(prev!==null&&p[0]-prev>(state.data?.step_seconds||30)*1500))draw();if(valid)segment.push(p);prev=p[0]}draw();const last=values.at(-1);s.append(svg('circle',{cx:X(last[0]),cy:Y(last[1]),r:4,fill:color,stroke:'#fff','stroke-width':2}));if(compact){holder.append(s);return}const cross=svg('line',{x1:X(last[0]),x2:X(last[0]),y1:t,y2:h-b,stroke:color,'stroke-dasharray':'3 3',opacity:'.5'}),dot=svg('circle',{cx:X(last[0]),cy:Y(last[1]),r:4,fill:color});s.append(cross,dot);const readout=E('output',undefined,'resource-readout');readout.setAttribute('aria-live','off');const slider=E('input',undefined,'resource-scrubber');slider.type='range';slider.min=0;slider.max=values.length-1;slider.step=1;slider.value=values.length-1;slider.setAttribute('aria-label',label+' 시각별 수치 확인');const select=i=>{const p=values[Math.max(0,Math.min(values.length-1,i))];readout.textContent=date(p[0])+' (KST) · '+fmt(p[1],3)+'%';slider.setAttribute('aria-valuetext',readout.textContent);cross.setAttribute('x1',X(p[0]));cross.setAttribute('x2',X(p[0]));dot.setAttribute('cx',X(p[0]));dot.setAttribute('cy',Y(p[1]))};slider.oninput=()=>select(Number(slider.value));s.onpointermove=e=>{const rect=s.getBoundingClientRect(),time=start+Math.max(0,Math.min(1,(e.clientX-rect.left-l*rect.width/w)/((w-l-r)*rect.width/w)))*(end-start);let index=0;values.forEach((p,i)=>{if(Math.abs(p[0]-time)<Math.abs(values[index][0]-time))index=i});slider.value=index;select(index)};select(values.length-1);holder.append(s,readout,slider);const span=Math.max(...values.map(p=>p[1]))-Math.min(...values.map(p=>p[1]));holder.append(E('p',values.length<2?'유효 표본 1개 · 변화 판단 불가':span<.1?'선택 기간 내 변화가 거의 없습니다.':'표시 표본 변동 폭 '+fmt(span,3)+'%p','resource-change'));if(zoom)holder.append(E('p','확대 보기는 사용량이 높은 상태를 뜻하지 않습니다.','resource-axis-note'))}
const resourceKeys=['cpu','memory','disk'],resourceNames=['CPU','메모리','루트 디스크 (/)'],resourceColors=['#1879ee','#8a51ff','#00a6ad'];
function metricCollection(host,h){if(!host)return '서버 자원 미확인';if(host.status==='stale')return '수집 지연';if(host.status!=='ok')return host.status==='unavailable'?'조회 실패':'데이터 없음';if(h&&h.status!=='ok')return name(h.status);return state.window==='custom'?'선택 시점 메트릭 확인':'메트릭 수집 정상'}
function collectionBadge(host,h){const text=metricCollection(host,h),badge=E('span',text,'resource-collection');if(!['메트릭 수집 정상','선택 시점 메트릭 확인'].includes(text))badge.classList.add('resource-collection-unknown');return badge}
function sampleSummary(points){const values=resourceValues(points).map(p=>p[1]);return values.length?{mean:values.reduce((a,b)=>a+b,0)/values.length,max:Math.max(...values),min:Math.min(...values),span:Math.max(...values)-Math.min(...values),count:values.length}:{mean:null,max:null,min:null,span:null,count:0}}

function hostTitle(h){return (h.server_name||'서버')+(h.instance?' · '+h.instance:' · 수집 대상 미설정')}

function renderResources(o){
 const root=$('.dashboard-hosts');
 root.replaceChildren();
 for(const [role,label] of [['service','서비스 서버'],['monitoring','모니터링 서버']]){
  const matches=(o?.resources?.items||[]).filter(host=>host.server_role===role);
  const host=matches.length===1?matches[0]:null;
  const section=E('section',undefined,'panel host-overview-card');
  const heading=E('div',undefined,'dashboard-host-heading');
  const stateText=matches.length>1?'서버 역할 중복':o?.resources?.metadata_status==='unavailable'||host?.metadata_status==='unavailable'?'서버 역할 조회 실패':host?.expected&&!host.instance?'수집 대상 미설정':metricCollection(host);
  heading.append(E('h3',label),E('small',stateText));
  if(host?.instance){
   const link=button('상세 →',()=>{state.resourceKey='cpu';state.resourceHost=host.host_id||host.instance;go('resources')});
   link.className='resource-detail-link';heading.append(link);
  }
  const gauges=E('div',undefined,'dashboard-gauges');
  resourceKeys.forEach((key,i)=>{
   const history=host?.history?.[key],value=host?.[key];
   const valid=host?.status==='ok'&&(!history||history.status==='ok')&&Number.isFinite(value)&&value>=0&&value<=100;
   const card=E('article',undefined,'dashboard-gauge');
   const graphic=svg('svg',{viewBox:'0 0 144 82','aria-hidden':'true'});
   const arc='M 12 72 A 60 60 0 0 1 132 72';
   graphic.append(svg('path',{d:arc,fill:'none',stroke:'#e4edf7','stroke-width':12}));
   if(valid&&value>0)graphic.append(svg('path',{d:arc,fill:'none',stroke:resourceColors[i],'stroke-width':12,pathLength:100,'stroke-dasharray':value+' 100'}));
   const meter=E('div',undefined,'dashboard-meter');
   meter.append(graphic,E('strong',valid?fmt(value)+' %':'—','res-value'));
   if(valid){
    meter.setAttribute('role','meter');meter.setAttribute('aria-label',label+' '+resourceNames[i]);
    meter.setAttribute('aria-valuemin','0');meter.setAttribute('aria-valuemax','100');meter.setAttribute('aria-valuenow',value);
   }
   const scale=E('div',undefined,'gauge-scale');scale.append(E('span','0%'),E('span','100%'));
   card.append(E('h4',resourceNames[i]+' 사용률'),meter,scale);
   if(!valid)card.append(E('small',matches.length>1?stateText:history?.status==='unavailable'?'조회 실패':metricCollection(host,history)));
   gauges.append(card);
  });
  section.append(heading);
  if(role==='service')section.append(E('small','실행 서비스 · 직원 포털 A · 홈페이지 B · 커뮤니티 C','overview-note'));
  section.append(gauges);
  if(host?.last_collected_at)section.append(E('small','마지막 유효 표본 '+date(host.last_collected_at)+' (KST)','overview-note'));
  root.append(section);
 }
}
const roles={'ec2-node':'호스트 지표 (Alloy)','portal-otel':'앱 지표 (Alloy)',prometheus:'자체 상태','portal-db-health':'직원 조회 점검','homepage-health':'홈페이지 HTTP 점검','homepage-organization':'조직도 API 점검','community-health':'커뮤니티 HTTP 점검','community-questions':'질문 목록 API 점검'};
function renderIncidents(tbody,rows,failed=false){tbody.replaceChildren();$('#incidents thead').innerHTML='<tr><th>발생 (KST)</th><th>구분</th><th>유형</th><th>대상</th><th>상태</th><th>AI 분석</th></tr>';
 if(!rows.length){const tr=E('tr'),td=E('td',failed?'사건 조회 실패':'사건이 없습니다.');td.colSpan=6;tr.append(td);tbody.append(tr)}
 for(const row of rows){const tr=E('tr');[date(row.detected_at),row.synthetic?'모의':'운영',name(row.rule_id),(row.target_display||name(row.target_id)),name(row.status),'상세 확인'].forEach(t=>tr.append(E('td',t)));wire(tr,()=>openIncident(row.id));tbody.append(tr)}}
async function renderAISummary(row,g,failed=false){$('.ai-title').textContent=row?name(row.rule_id):'분석 대상 없음';$('.ai-body p').textContent=row?'분석 결과를 조회하고 있습니다.':(failed?'사건 조회 실패':state.window==='custom'?'선택 기간에 발생한 사건이 없습니다.':'최근 사건이 없습니다.');$('.ai-action button').disabled=!row;if(!row)return;
 try{const d=await api('/api/incidents/'+encodeURIComponent(row.id));if(g!==state.generation)return;const job=d.jobs.find(j=>j.kind==='ai');$('.ai-title').textContent=name(row.rule_id)+' · '+name(job?.status);$('.ai-body p').textContent=job?.result?.summary||'저장된 AI 요약이 없습니다.';$('.ai-body p').classList.add('ai-summary-clamp');$('.ai-action button').onclick=()=>openIncident(row.id)}catch(e){if(g===state.generation)$('.ai-body p').textContent='AI 결과 조회 실패 · '+e.message}}
function jobDisplay(job,kind){return window.SchutzIncidentContext?.jobState(job,kind)||{label:'처리 상태 미확인',tone:'unknown',lastAttempt:null}}
function statusBadge(text,tone='unknown'){return E('span',text,'incident-badge tone-'+tone)}
function severityLabel(level){return {critical:'심각',warning:'주의'}[level]||'미제공'}
function taskBadge(jobs,kind){const j=(jobs||[]).find(v=>v.kind===kind),s=jobDisplay(j,kind);return statusBadge(s.label,s.tone)}
function incidentListTime(value){const cell=E('td'),at=new Date(value);if(!value||!Number.isFinite(at.getTime())){cell.textContent='미확인';return cell}const time=E('time',undefined,'incident-list-time');time.dateTime=value;time.title=date(value)+' (KST)';time.append(E('span',at.toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'})),E('span',at.toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})));cell.append(time);return cell}
function incidentListURL(){const p=new URLSearchParams({status:state.filter,page:String(state.page)});if(state.q)p.set('q',state.q);if(state.severity!=='all')p.set('severity',state.severity);if(state.stage!=='all')p.set('state',state.stage);return '/api/incidents?'+p}
function conflictsWithIncidentTab(tab,stage){
 return (tab==='open'&&stage==='closed')||(tab==='closed'&&['new','accepted','in_progress'].includes(stage));
}
async function showIncidentList(g){
 if(conflictsWithIncidentTab(state.filter,state.stage)){
  state.stage='all';state.page=1;remember(false);
 }
 page.append(E('h2','사건 관리'),E('p','사건 접수·분석·조치 현황 · 사건 목록은 전체 기간 기준입니다. 상단 기간 선택은 이 목록과 요약에 적용되지 않습니다.','read-muted'));
 const cards=E('div',undefined,'incident-summary-grid');for(const[key,label]of [['new','신규 · 조치 필요'],['accepted','접수'],['in_progress','조치 중'],['closed','종료 이력']]){const card=button('',()=>{state.filter='all';state.stage=key;state.page=1;remember();loadView()});card.className='incident-count-card state-'+key;card.dataset.state=key;card.append(E('span',label),E('strong','미확인'),E('small','서버 집계 기준'));cards.append(card)}page.append(cards,E('p','요약: 검색·심각도 조건에 맞는 모든 처리 상태의 전체 기간 집계. 목록: 탭·상태 조건까지 적용한 결과.','read-muted'));
 const panel=E('section',undefined,'incident-list-v31'),bar=E('div',undefined,'incident-list-toolbar'),tabs=E('div',undefined,'incident-tabs');
 for(const[key,label]of [['open','열린 사건'],['closed','종료 이력'],['all','전체 사건']]){const b=button(label,()=>{state.filter=key;if(conflictsWithIncidentTab(key,state.stage))state.stage='all';state.page=1;remember();loadView()});b.setAttribute('aria-pressed',String(state.filter===key));tabs.append(b)}bar.append(tabs);
 const form=E('form',undefined,'incident-filters'),search=E('input');search.type='search';search.maxLength=80;search.value=state.q;search.placeholder='사건명·유형·대상·전체 ID 검색';search.setAttribute('aria-label','사건 검색');
 const severity=E('select');severity.setAttribute('aria-label','심각도 필터');for(const[value,label]of [['all','심각도 전체'],['critical','심각'],['warning','주의'],['unknown','미제공']]){const o=E('option',label);o.value=value;severity.append(o)}severity.value=state.severity;
 const stage=E('select');stage.setAttribute('aria-label','사건 상태 필터');for(const value of ['all','new','accepted','in_progress','closed']){const o=E('option',value==='all'?'상태 전체':name(value));o.value=value;stage.append(o)}stage.value=state.stage;
 form.append(search,severity,stage,button('검색 적용',()=>form.requestSubmit()));form.onsubmit=e=>{e.preventDefault();state.q=search.value.trim().slice(0,80);state.severity=severity.value;state.stage=stage.value;if(conflictsWithIncidentTab(state.filter,state.stage))state.filter=state.stage==='closed'?'closed':'open';state.page=1;remember();loadView()};bar.append(form);panel.append(bar);page.append(panel);
 const loading=E('p','사건 목록 조회 중…','read-note');loading.setAttribute('role','status');panel.append(loading);
 const d=await api(incidentListURL());if(g!==state.generation)return;loading.remove();
 if(Number.isInteger(d.page_count)&&d.page_count>0&&state.page>d.page_count){state.page=d.page_count;remember(false);page.replaceChildren();await showIncidentList(g);return}
 for(const card of cards.children){const count=d.counts?.[card.dataset.state];card.querySelector('strong').textContent=Number.isInteger(count)?count+'건':'미확인'}
 const wrap=E('div',undefined,'incident-table-scroll'),table=E('table',undefined,'incident-table'),head=E('thead'),hr=E('tr');for(const label of ['발생 시각 (KST)','사건명 / 탐지 유형','대상','심각도','구분','사건 상태','AI 분석','Slack 알림','상세'])hr.append(E('th',label));head.append(hr);table.append(head);const body=E('tbody');
 for(const row of d.items){const tr=E('tr');tr.append(incidentListTime(row.detected_at));const title=E('td');title.append(E('b',name(row.rule_id)),E('small',row.monitoring?.alert_name||row.rule_id));tr.append(title,E('td',row.target_display||name(row.target_id)));const level=E('td');level.append(statusBadge(severityLabel(row.severity),row.severity==='critical'?'failed':row.severity==='warning'?'pending':'unknown'));tr.append(level);const mode=E('td');mode.append(statusBadge(row.synthetic?'모의':'실제',row.synthetic?'unknown':'info'));tr.append(mode);const status=E('td');status.append(statusBadge(name(row.status),row.status==='closed'?'success':row.status==='new'?'info':'pending'));tr.append(status);const ai=E('td');ai.append(taskBadge(row.jobs,'ai'));tr.append(ai);const slack=E('td');for(const[kind,label]of [['slack','최초'],['slack_ai','AI 완료'],['slack_recovery','복구'],['slack_closed','종료']]){const line=E('div',undefined,'list-slack-line');line.append(E('small',label),kind==='slack_recovery'&&['login_failures','unauthorized_read','unauthorized_write','notification_delivery_test','availability_failure','response_delay'].includes(row.rule_id)&&!row.jobs?.some(j=>j.kind===kind)?statusBadge('해당 없음','unknown'):taskBadge(row.jobs,kind));slack.append(line)}tr.append(slack);const action=E('td');action.append(button('상세 보기 →',()=>openIncident(row.id)));tr.append(action);body.append(tr)}
 table.append(body);wrap.append(table);panel.append(wrap);
 if(!d.items.length)panel.append(E('p','현재 조건에 해당하는 사건이 없습니다.','read-note'));
 panel.append(E('p','현재 조건 총 '+(Number.isInteger(d.total)?d.total+'건':'미확인')+' · 이 페이지 '+d.items.length+'건 · '+(d.page_count===0?'페이지 없음':state.page+' / '+(Number.isInteger(d.page_count)?d.page_count:'미확인')+'페이지'),'incident-list-count'));
 const nav=E('div',undefined,'toolbar'),prev=button('이전',()=>{state.page--;remember();loadView()}),next=button('다음',()=>{state.page++;remember();loadView()});prev.disabled=state.page<=1;next.disabled=!Number.isInteger(d.total)||state.page*(d.page_size||20)>=d.total;nav.append(prev,next);panel.append(nav,E('p','사건 상태·AI 처리·Slack 전송·복구 신호는 별개입니다. 심각도는 저장된 경보 근거가 없으면 미제공입니다.','read-muted'));feedback(modeNote())
}

function pretty(value){return E('pre',JSON.stringify(value,null,2),'json-output')}
function contextDate(value){return typeof value==='string'&&Number.isFinite(Date.parse(value))?date(value):'미제공'}
function incidentContext(d,j){
 const root=E('section',undefined,'incident-context');root.setAttribute('aria-label','현재 근거와 과거 이력');
 const helper=window.SchutzIncidentContext;
 if(!helper){root.append(E('p','분석 입력 표시 기능을 불러오지 못했습니다. 새로고침 후 확인해주세요.','read-note'));return root}
 const c=helper.build(d,j);
 const timing=E('section',undefined,'context-timing');timing.append(E('span',d.status==='closed'?'과거 사건 분석':'사건 기록 기준 분석','status-pill'),E('p','근거 시점과 현재 서비스 상태는 다를 수 있습니다.','read-muted'));
 const dl=E('dl',undefined,'read-definitions');for(const[k,v]of [['탐지 시각',contextDate(d.detected_at)],['종료 시각',contextDate(d.closed_at)],['저장된 AI 결과 완료',contextDate(c.analysisAt)]])dl.append(E('dt',k),E('dd',v+' (KST)'));
 if(c.lifecycleSeconds!==null){const seconds=c.lifecycleSeconds,h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=seconds%60;dl.append(E('dt','탐지~종료 소요'),E('dd',(h?h+'시간 ':'')+m+'분 '+s+'초 · 실제 오류 지속 시간과 다릅니다.'))}
 if(c.failureWindow){const f=c.failureWindow;dl.append(E('dt','오류 표본 관측 구간'),E('dd',contextDate(f.first)+' ~ '+contextDate(f.last)+' (KST) · '+f.count+'건 · '+(f.source==='detail_evidence'?'반환된 탐지 근거':'저장된 AI 입력')+' 기준. 표본 사이의 연속 장애를 단정하지 않습니다.'))}else dl.append(E('dt','오류 표본 관측 구간'),E('dd','실패 표본 시각 미제공 · 구간을 추정하지 않습니다.'));timing.append(dl);root.append(timing);
 const section=E('section',undefined,'context-current');section.append(E('h4','01 현재 사건의 분석 입력 근거'),E('p','AI 입력에 저장된 표본입니다. AI 요약에서 추출하거나 현재 정상 여부로 추정한 값이 아닙니다.','read-muted'));
 if(!c.known)section.append(E('p','분석 입력이 제공되지 않아 근거를 확인할 수 없습니다.','read-note'));
 else if(!c.current.length)section.append(E('p','저장된 현재 근거가 없습니다.','read-note'));
 else{section.append(E('p','현재 근거 '+c.current.length+'건 · AI 인용 '+(c.currentCitations===null?'미확인':c.currentCitations+'건'),'context-count'));for(const row of c.current.slice(0,5)){const item=E('details',undefined,'context-evidence');item.append(E('summary',row.source+' · '+row.observation),E('p',contextDate(row.occurred_at)+' (KST)','read-muted'),E('code',row.id,'context-id'),E('span',row.cited?'AI 인용':'입력 근거','context-badge current-reference'),pretty(row.payload));section.append(item)}if(c.current.length>5){const more=E('details');more.append(E('summary','전체 분석 입력 근거 보기 ('+c.current.length+'건)'),pretty(c.current.map(({source,observation,cited,...row})=>row)));section.append(more)}}
 if(d.rule_id==='monitoring_target_down')section.append(E('p','up=0은 메트릭 수집 실패입니다. 서비스·컨테이너 중단은 별도 기능 점검과 실행 상태로 확인해야 합니다.','read-note'));
 root.append(section);
 const history=E('section',undefined,'context-history');history.append(E('h4','02 참고한 과거 사건'),E('p','같은 대상·규칙·모의 여부의 종료 사건에서 선택한 기록입니다. 조치 효과나 현재 원인이 검증됐다는 뜻은 아닙니다.','read-muted'));
 if(!c.known)history.append(E('p','이 분석의 과거 이력 포함 여부를 확인할 수 없습니다.','read-note'));
 else if(!c.histories.length)history.append(E('p','이 분석 입력에 포함된 과거 이력이 없습니다. 기능 설정 또는 선택 조건에 따라 달라질 수 있습니다.','read-note'));
 else{
  const stats=E('div',undefined,'context-stats');stats.append(summaryCard('참고 이력',c.histories.length+'건'),summaryCard('AI 과거 인용',c.historyCitations===null?'미확인':c.historyCitations+'건'));history.append(stats);
  if(c.historyCitations===0)history.append(E('p','과거 이력은 입력됐지만 AI 응답에서 인용되지 않았습니다.','read-note'));
  c.histories.slice(0,3).forEach((row,index)=>{const card=E('details',undefined,'context-history-card');card.open=index===0;const p=row.payload;card.append(E('summary','과거 사건 '+(index+1)+' · '+(p.synthetic===true?'[모의] ':p.synthetic===false?'[실제] ':'[구분 미확인] ')+name(p.rule_id)),E('span',row.cited?'AI 인용':'참고 입력','context-badge history-reference'),E('p','대상: '+name(p.target_id)),E('p','탐지 '+contextDate(p.detected_at)+' · 종료 '+contextDate(p.closed_at)+' (KST)','read-muted'),E('p','선택 기준: 같은 대상·같은 규칙의 종료 사건','read-muted'),E('code',row.id,'context-id'));
   card.append(E('h5','관리자 조치 기록'));if(!row.notes.length)card.append(E('p','조치 내용이 제공되지 않았습니다.','read-muted'));for(const note of row.notes)card.append(E('p',note,'context-action-note'));
   if(row.incidentID)card.append(button('원본 사건 상세 보기',()=>openIncident(row.incidentID)));else card.append(E('p','원본 전체 ID를 확인할 수 없어 링크를 제공하지 않습니다.','read-muted'));
   history.append(card)});
  if(c.histories.length>3)history.append(E('p','과거 사건은 최대 3건까지 화면에 표시합니다.','read-muted'));
 }
 if(c.malformed)history.append(E('p','형식을 확인할 수 없는 입력 '+c.malformed+'건이 있습니다.','read-muted'));
 if(c.unmatched.length)history.append(E('p','출처를 확인할 수 없는 인용 '+c.unmatched.length+'건 · 원본 사건 링크를 생성하지 않습니다.','read-note'));
 root.append(history);return root;
}

const incidentDrafts=new Map(),incidentParents=new Map();
function returnToIncidentList(){if(state.busy)return;state.overlay=null;detail.close();state.view='incidents';remember();Promise.resolve(loadView()).then(()=>window.scrollTo?.({top:state.listScroll,behavior:'instant'}))}
async function openIncident(id){
 if(state.busy)return;const key='incident-'+id,previous=state.overlay?.startsWith('incident-')?state.overlay.slice(9):null;
 if(!previous)state.listScroll=window.scrollY||0;if(previous&&previous!==id)incidentParents.set(id,previous);
 if(state.overlay&&state.overlay!==key){state.overlay=null;detail.close()}
 modal('사건 상세','조회 중…',key);const generation=state.generation;
 const rows=await Promise.allSettled([api('/api/incidents/'+encodeURIComponent(id)),api('/api/dashboard')]);
 if(!state.user){detail.close();return}if(state.overlay!==key||generation!==state.generation)return;
 if(rows[0].status==='fulfilled'){const d=rows[0].value;d.current_view=rows[1].status==='fulfilled'?{status:'ok',data:rows[1].value}:{status:'unavailable'};incidentDetail(d);return}
 const error=rows[0].reason,box=E('div',undefined,'incident-error');box.setAttribute('role','alert');box.append(E('h3','원본 사건 조회 불가'),E('p',error.status===403?'접근 권한을 확인해주세요. 원본의 삭제 여부는 확정할 수 없습니다.':error.status===404?'사건을 찾을 수 없습니다. 삭제 또는 접근 범위를 확인해주세요.':error.status===401?'로그인이 필요합니다.':'서버 또는 네트워크 문제로 조회하지 못했습니다.'),E('p',error.message));
 const parent=incidentParents.get(id);if(parent)box.append(button('원래 사건 상세로 돌아가기',()=>openIncident(parent)));box.append(button('목록으로 돌아가기',returnToIncidentList));modal('사건 조회 실패',box,key)
}
function safeError(code){return typeof code==='string'&&/^[A-Z0-9_]{1,60}$/.test(code)?code:'오류 코드 미제공'}
function attemptHistory(job){const more=E('details',undefined,'attempt-history');more.append(E('summary','시도 이력 보기'));if(!job?.history?.length)more.append(E('p','실제 시도 기록이 없습니다.','read-muted'));else for(const a of job.history){const row=E('div',undefined,'attempt-row');row.append(E('b',(Number.isInteger(a.number)?a.number+'회':'시도 번호 미제공')+' · '+name(a.outcome)),E('span','시작 '+contextDate(a.started_at)+' · 완료 '+contextDate(a.finished_at)+' (KST)'));if(a.error_code)row.append(E('code',safeError(a.error_code)));more.append(row)}return more}
function renderAIJob(j){
 const box=E('section',undefined,'incident-ai-card'),status=jobDisplay(j,'ai');const head=E('div',undefined,'incident-card-head');head.append(E('h3','AI 분석 결과'),statusBadge(status.label,status.tone));box.append(head,E('p',j?(j.attempts??'미제공')+'회 시도 · 최근 시도 '+contextDate(status.lastAttempt)+' (KST)':'분석 작업 기록이 없습니다.','read-muted'));
 box.append(E('p','분석 성공은 원인 확정이나 사건 종료를 뜻하지 않습니다.','read-muted'));
 if(j?.error_code){const failure=E('details');failure.append(E('summary','분석 오류 상세'),E('code',safeError(j.error_code)));box.append(failure)}
 if(j?.result){const result=j.result;for(const[key,label]of [['summary','핵심 요약 · 사실 대조 필요'],['hypotheses','원인 후보 (추정)'],['next_checks','추가 확인'],['limitations','분석 한계']]){const section=E('section',undefined,'ai-result-field');section.append(E('h4',label));if(Array.isArray(result[key])){const list=E('ul');for(const item of result[key])if(typeof item==='string')list.append(E('li',item));section.append(list);if(!list.children.length)section.append(E('p','제공된 항목이 없습니다.','read-muted'))}else section.append(E('p',typeof result[key]==='string'?result[key]:'미제공',key==='summary'?'ai-summary-preview':''));box.append(section)}const raw=E('details',undefined,'ai-original');raw.append(E('summary','AI 원문 보기'));const original={};for(const key of ['summary','hypotheses','evidence_ids','next_checks','limitations'])if(result[key]!==undefined)original[key]=result[key];raw.append(pretty(original));box.append(raw)}else box.append(E('p',j?.status==='failed'?'저장된 분석 결과가 없습니다. 실패 상태와 시도 이력을 확인해주세요.':'분석 결과가 아직 제공되지 않았습니다.','read-note'));
 box.append(attemptHistory(j));return box;
}
function renderSlackJobs(jobs,incident={}){
 const box=E('section',undefined,'incident-slack-card');box.append(E('h3','Slack 알림 현황'),E('p','전송 성공은 관리자 수신 확인·원인 해결·사건 종료와 별개입니다.','read-muted'));
 for(const[kind,title]of [['slack','최초 경보 알림'],['slack_ai','AI 분석 완료 알림'],['slack_recovery','복구 알림'],['slack_closed','사건 종료 알림']]){if(kind==='slack_recovery'&&['login_failures','unauthorized_read','unauthorized_write','notification_delivery_test','availability_failure','response_delay'].includes(incident.rule_id)&&!jobs.some(v=>v.kind===kind)){const na=E('article',undefined,'slack-delivery-row');na.append(E('b',title),statusBadge('해당 없음','unknown'),E('p','이 규칙에는 자동 복구 신호 알림이 연결되지 않습니다. 관리자 종료 알림과 구분합니다.','read-muted'));box.append(na);continue}const j=jobs.find(v=>v.kind===kind),s=jobDisplay(j,kind),row=E('article',undefined,'slack-delivery-row'),head=E('div',undefined,'incident-card-head');head.append(E('b',title),statusBadge(s.label,s.tone));row.append(head,E('p',j?(j.attempts??'미제공')+'회 시도 · 최근 '+contextDate(s.lastAttempt)+' (KST)':'미발송 / 작업 기록 없음','read-muted'));if(j?.error_code)row.append(E('code',safeError(j.error_code)));row.append(attemptHistory(j));box.append(row)}
 box.append(E('p','Webhook URL·토큰·인증 정보는 표시하지 않습니다.','read-note'));return box;
}
async function copyIncidentID(id,control,note,input){
 if(control.disabled)return;control.disabled=true;control.textContent='복사 중…';note.textContent='';
 try{if(typeof navigator==='undefined'||!navigator.clipboard?.writeText)throw new Error('unavailable');await navigator.clipboard.writeText(id);note.textContent='전체 사건 ID를 복사했습니다.'}
 catch{note.textContent='복사하지 못했습니다. 전체 ID를 직접 선택해 복사해주세요.';input.focus?.();input.select?.()}
 finally{control.disabled=false;control.textContent='ID 복사'}
}
function currentIncidentStatus(d){
 const box=E('section',undefined,'incident-current-status');box.append(E('h3','현재 조회 상태 · 과거 근거와 별도'));
 const result=d.current_view,at=result?.data?.as_of,server=result?.data?.servers?.find(v=>v.target_id===d.target_id),layout=E('div',undefined,'incident-current-layout'),current=E('div',undefined,'incident-current-summary');
 if(result?.status!=='ok')current.append(E('p','현재 상태 조회 실패 · 미확인','read-note'));
 else if(!server)current.append(E('p','현재 서비스 기능 상태 미확인 · 해당 사건 대상과 연결된 기능 점검 정보가 없습니다.','read-note'));
 else{const known=typeof server.last_checked_at==='string'&&Number.isFinite(Date.parse(server.last_checked_at))&&!server.collection_delayed&&state.mode.mode!=='snapshot';current.append(statusBadge('기능 점검 '+(known?name(server.status):'미확인'),known&&server.status==='normal'?'success':'unknown'));if(server.collection_delayed)current.append(E('p','수집 지연 · 과거 표본을 현재 정상으로 해석하지 않습니다.','read-muted'))}
 const metadata=E('dl',undefined,'incident-status-meta');for(const[label,value]of [['관측 시각',contextDate(server?.last_checked_at)+' (KST)'],['조회 시각',contextDate(at)+' (KST)'],['출처','관리 DB · 최근 Worker 기능 점검']])metadata.append(E('dt',label),E('dd',value));current.append(metadata);layout.append(current);
 if(d.monitoring){const m=d.monitoring,prom=E('div',undefined,'incident-prometheus-summary'),closed=d.status==='closed',stored=closed?window.SchutzIncidentContext.closedMonitoring(d):null;prom.append(E('h4',closed?'Prometheus 경보 · 종료 전 저장 근거':'Prometheus 경보'),E('b',m.alert_name||'경보 정보 미확인'));const labels={firing:'발생 중',pending:'발생 대기',normal:'정상 지표 확인',unknown:'미확인'};prom.append(E('p',closed?'저장 상태: '+(stored?labels[stored.state]:'근거 미제공'):'상태: '+(labels[m.state]||'수집 미확인')));const meta=E('dl',undefined,'incident-status-meta');meta.append(E('dt',closed?'근거 관측 시각':'마지막 평가'),E('dd',contextDate(closed?stored?.at:m.last_evaluated_at)+' (KST)'));prom.append(meta,E('p',closed?'제공된 근거 중 종료 이전 마지막 기록입니다. 현재 상태나 종료 당시 복구 완료를 보증하지 않습니다.':m.recovery_confirmed?'복구 신호 확인 · 조치 기록 후 관리자 확인 필요':'복구 조건 미충족 또는 확인 필요','read-note'));layout.append(prom)}
 box.append(layout);return box;
}
function evidencePanel(d){
 const panel=E('section',undefined,'incident-evidence-panel');panel.append(E('h3','탐지 근거'),E('p','사건에 연결된 서버 반환 근거입니다. 기본 최근 5건 · API 최대 100건 · 전체 보기는 이번 응답 범위입니다.','read-muted'));
 const wrap=E('div',undefined,'incident-table-scroll'),table=E('table',undefined,'incident-evidence-table'),head=E('thead'),tr=E('tr');for(const label of ['#','근거 시각 (KST)','전체 근거 ID','출처 / 원문'])tr.append(E('th',label));head.append(tr);table.append(head);const body=E('tbody');
 for(const[at,ev]of(d.evidence||[]).entries()){const row=E('tr');row.hidden=at>=5;row.append(E('td',String(at+1)),E('td',contextDate(ev.occurred_at)),E('td',ev.id));const cell=E('td'),more=E('details');more.append(E('summary',({check:'기능 점검',prometheus:'Prometheus 경보',login:'로그인 이벤트',security:'보안 접근 거부'}[ev.kind]||'입력 근거')+' · 원문 보기'),pretty(ev.payload));cell.append(more);row.append(cell);body.append(row)}table.append(body);wrap.append(table);panel.append(wrap);if(!body.children.length)panel.append(E('p','제공된 탐지 근거가 없습니다.','read-note'));if(body.children.length>5){let expanded=false;const toggle=button('전체 근거 보기 ('+body.children.length+'건)',()=>{expanded=!expanded;for(const[at,row]of [...body.children].entries())row.hidden=!expanded&&at>=5;toggle.textContent=expanded?'최근 5건만 보기':'전체 근거 보기 ('+body.children.length+'건)';toggle.setAttribute('aria-expanded',String(expanded))});toggle.setAttribute('aria-expanded','false');panel.append(toggle)}return panel;
}
function cacheIncidentDraft(id){const action=$('#action-content'),resolution=$('#resolution'),check=$('#test-stopped');const old=incidentDrafts.get(id)||{};incidentDrafts.set(id,{action:action?action.value:old.action||'',resolution:resolution?resolution.value:old.resolution||'',stopped:check?check.checked:old.stopped||false})}
function restoreIncidentDraft(id){const draft=incidentDrafts.get(id);if(!draft)return;const action=$('#action-content'),resolution=$('#resolution'),check=$('#test-stopped');if(action)action.value=draft.action;if(resolution)resolution.value=draft.resolution;if(check){check.checked=draft.stopped;check.onchange?.()}if((!action&&draft.action)||(!resolution&&draft.resolution)){const saved=E('details');saved.append(E('summary','저장되지 않은 입력 보기'),E('p',draft.action||draft.resolution));$('#detail-body').append(saved)}}
function incidentDetail(d){
 const root=E('div',undefined,'incident-workspace'),jobs=d.jobs||[],ai=jobs.find(j=>j.kind==='ai');
 const nav=E('nav',undefined,'incident-detail-nav');nav.setAttribute('aria-label','사건 상세 이동');const back=button('← 목록으로 돌아가기',returnToIncidentList);back.className='incident-back outline';nav.append(back,button('화면 닫기',closeOverlay));root.append(nav);
 const header=E('section',undefined,'incident-detail-header'),heading=E('div',undefined,'incident-title-row');heading.append(E('h2',(d.synthetic?'[모의] ':'')+name(d.rule_id)),statusBadge(name(d.status),d.status==='closed'?'success':'info'),statusBadge(severityLabel(d.severity),d.severity==='critical'?'failed':d.severity==='warning'?'pending':'unknown'));root.append(header);header.append(heading,E('p',(d.target_display||name(d.target_id))+' · '+d.rule_id));
 const idRow=E('div',undefined,'incident-id-row'),input=E('textarea');input.rows=2;input.value=d.id;input.readOnly=true;input.setAttribute('aria-label','전체 사건 ID');const copied=E('p',undefined,'read-muted');copied.setAttribute('role','status');const copy=button('ID 복사',()=>copyIncidentID(d.id,copy,copied,input));idRow.append(E('b','사건 ID'),input,copy);header.append(idRow,copied,E('p','탐지 '+contextDate(d.detected_at)+' · 종료 '+contextDate(d.closed_at)+' (KST)','read-muted'));
 const upper=E('div',undefined,'incident-detail-overview'),guide=E('section',undefined,'incident-judgement');guide.append(E('h3','운영 판단 안내'),E('p','경보 상태, AI 분석, Slack 전송, 사건 종료는 각각 별도입니다. 관리자 근거 검토 후 접수·조치·종료합니다.','read-note'));upper.append(currentIncidentStatus(d),guide);root.append(upper);
 const context=incidentContext(d,ai);context.append(E('p','과거 이력 기능 상태 미확인 · Web 응답만으로 Worker 설정을 확정하지 않습니다.','read-muted'));root.append(context);
 const grid=E('div',undefined,'incident-detail-grid');grid.append(renderAIJob(ai),renderSlackJobs(jobs,d));root.append(grid,evidencePanel(d));
 const actions=E('section',undefined,'incident-action-section');actions.append(E('h3','접수 · 조치 기록'),E('p','초안은 제안이며 실제 수행 내용을 검토한 뒤 직접 저장합니다. 화면 닫기는 사건 종료가 아닙니다.','read-note'));
 const timeline=E('div',undefined,'incident-action-timeline');for(const a of d.actions||[])timeline.append(E('p',contextDate(a.created_at)+' · '+a.content));if(!d.actions?.length)timeline.append(E('p','저장된 처리 이력이 없습니다.','read-muted'));actions.append(timeline);
 const writable=state.mode.writes_enabled&&state.mode.mode!=='snapshot';
 if(!writable)actions.append(E('p','조회 전용입니다. 사건 상태와 조치 기록을 변경하지 않습니다.','notice'));
 else if(d.status==='new'){const accept=button('사건 접수',()=>mutate(d.id,'accept',{}));accept.classList.add('primary-action');actions.append(accept)}
 if(d.session_control?.eligible){const control=E('section');control.append(E('h3','시험 계정 세션 폐기'),E('p',d.session_control.notice,'read-note'));const op=d.session_control.operation;if(op)control.append(E('p',({succeeded:'서비스 폐기 확인',failed:'실행 실패',unknown:'실행 결과 미확인',pending:'실행 결과 확인 필요'}[op.status]||'미확인')+(op.revoked_count!==undefined?' · '+op.revoked_count+'건':'')+' · 실행 ID '+op.operation_id+(op.error_code?' · '+op.error_code:'')));if(writable&&d.session_control.enabled&&['accepted','in_progress'].includes(d.status)&&op?.status!=='succeeded'){const check=E('input');check.type='checkbox';const label=E('label');label.append(check,E('span','시험 계정 test_user의 기존 세션 폐기를 실행합니다.'));const run=button(op?'같은 실행 ID로 결과 재확인':'시험 세션 폐기 실행',()=>{if(check.checked)mutate(d.id,'revoke-test-sessions',{confirm_account:'test_user'})});run.disabled=true;check.onchange=()=>{run.disabled=!check.checked};control.append(label,run)}else if(!d.session_control.enabled)control.append(E('p','세션 폐기 연결 비활성화 · 실행되지 않습니다.','read-note'));actions.append(control)}
 if(writable&&['accepted','in_progress'].includes(d.status)){const form=E('form');form.append(E('label','조치 내용 (1~1000자)'));const field=E('textarea');field.id='action-content';field.maxLength=1000;field.required=true;field.setAttribute('aria-label','조치 내용');const save=button('조치 기록 저장',()=>form.requestSubmit());save.classList.add('primary-action');form.append(field,save);form.onsubmit=e=>{e.preventDefault();if(!field.value.trim()){feedback('조치 내용을 입력해주세요.',true);field.focus?.();return}mutate(d.id,'actions',{content:field.value})};actions.append(form)}root.append(actions);
 const closure=E('section',undefined,'incident-closure-section');closure.append(E('h3','복구 확인 · 사건 종료'));
 if(d.resolution)closure.append(E('p','저장된 종료 근거: '+d.resolution));
 if(writable&&d.status==='in_progress'){
  const eligible=d.closure?.eligible===true;closure.append(E('p',eligible?'서버 조회 기준 종료 조건 충족 · 담당자의 최종 확인이 필요합니다.':'종료 조건 미충족 · 아래 근거를 확인해주세요.','read-note'));for(const reason of d.closure?.reasons||[])closure.append(E('p',reasons[reason]||reason));
  const form=E('form'),field=E('textarea');field.id='resolution';field.required=true;field.maxLength=1000;field.setAttribute('aria-label','종료 근거');form.append(E('label','종료 근거 (1~1000자)'),field);let check;
  if(d.closure?.test_stop_confirmation_required||d.rule_id==='login_failures'){check=E('input');check.id='test-stopped';check.type='checkbox';check.required=true;const label=E('label');label.append(check,'시험 입력을 중지하고 시험 종료를 확인했습니다.');form.append(label)}
  const close=button('사건 종료',()=>form.requestSubmit());close.classList.add('close-incident-action');close.disabled=!eligible||!!check&&!check.checked;close.setAttribute('aria-describedby','closure-policy');if(check)check.onchange=()=>{close.disabled=!eligible||!check.checked};
  const policy=E('p','서버가 권한·조치 기록·복구·시험 종료 조건을 최종 검증합니다.','read-muted');policy.id='closure-policy';form.append(policy,close);form.onsubmit=e=>{e.preventDefault();if(!eligible){feedback('종료 조건을 먼저 확인해주세요.',true);return}if(!field.value.trim()||(check&&!check.checked)){feedback('종료 근거와 시험 종료 확인을 입력해주세요.',true);return}const payload={resolution:field.value};if(check)payload.test_stopped=check.checked;mutate(d.id,'close',payload)};closure.append(form)
 }else if(d.status!=='closed')closure.append(E('p','접수와 조치 기록 후 복구 조건을 확인하고 종료할 수 있습니다.','read-muted'));
 if(['unauthorized_read','unauthorized_write'].includes(d.rule_id))closure.append(E('p','실패가 멈추고 사건이 종료되어도 정보 미노출·데이터 미변경·추가 차단 완료가 자동 증명되지는 않습니다. 시험 결과와 실제 조치를 별도로 기록하세요.','read-note'));
 root.append(closure);
 modal('사건 상세',root);restoreIncidentDraft(d.id);if(window.SchutzDrafts&&writable)window.SchutzDrafts.attach(d,api);$('#detail-title').tabIndex=-1;$('#detail-title').focus?.();
}
async function mutate(id,kind,payload){
 if(state.busy||!state.mode.writes_enabled)return;cacheIncidentDraft(id);state.busy=true;const controls=[...detail.querySelectorAll('button')];controls.forEach(b=>b.disabled=true);const original=new Map(controls.map(b=>[b,b.textContent]));const active=controls.find(b=>b.textContent===({accept:'사건 접수',actions:'조치 기록 저장',close:'사건 종료'}[kind]));if(active)active.textContent='처리 중…';detail.setAttribute('aria-busy','true');let warning,failed=false;
 try{const result=await api('/api/incidents/'+encodeURIComponent(id)+'/'+kind,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},body:JSON.stringify(payload)});warning=kind==='revoke-test-sessions'?(result.status==='succeeded'?'서비스의 세션 폐기 결과를 확인했습니다. 기존 세션 접근 거부는 별도 확인해주세요.':result.status==='unknown'?'실행 결과 미확인입니다. 같은 실행 ID로 재확인해주세요.':'세션 폐기 실행 실패입니다. 실행 이력을 확인해주세요.'):'처리 결과를 저장했습니다.';const draft=incidentDrafts.get(id)||{};if(kind==='actions')draft.action='';if(kind==='close')incidentDrafts.delete(id);else incidentDrafts.set(id,draft)}
 catch(e){failed=true;warning=(e.status===409?'사건 상태 또는 종료 조건이 변경됐습니다. 최신 상태를 다시 조회했습니다. ':'')+e.message+(Array.isArray(e.details)?'\n'+e.details.map(r=>reasons[r]||r).join('\n'):'');if(!e.status)warning+=' 요청 결과를 확인하기 전에는 같은 작업을 다시 보내지 마세요.';if(e.status===403)try{await restoreContext(false)}catch{}}
 finally{state.busy=false;controls.forEach(b=>{b.disabled=false;b.textContent=original.get(b)});detail.setAttribute('aria-busy','false')}
 if(state.user){await loadView();await openIncident(id);const p=E('p',warning,failed?'notice error':'notice');p.setAttribute('role','status');$('#detail-body').prepend(p)}
}

function pageTitle(title,o){page.append(E('h2',title),E('p',date(o.range_start)+' ~ '+date(o.as_of)+' (KST) · '+o.step_seconds+'초 간격'))}
function metricSummary(label,metric,unit){const card=E('article',undefined,'read-stat');card.append(E('p',label),E('strong',metric?.status==='ok'?fmt(metric.value)+' '+unit:name(metric?.status||'unknown')));return card}
function serviceDetailStatus(o,servers,key){
 const entry=publicRequestPaths[key];
 if(!entry){const check=serviceState(servers,key);return {kind:check.kind,checkedAt:check.row?.last_checked_at};}
 const checks=entry.checks.map(([, , , job])=>publicProbe(o,job));
 const checkedAt=checks.map(({probe})=>probe?.checked_at).filter(Boolean).sort().at(-1);
 const kind=checks.some(check=>check.kind==='abnormal')?'abnormal':checks.every(check=>check.kind==='normal')?'normal':'unknown';
 return {kind,checkedAt};
}
function publicServiceCheckHistory(o,entry){
 const section=E('section',undefined,'service-detail-box');
 section.append(E('h3','최근 '+entry.label+' 점검 기록'));
 const checks=E('ul');
 for(const [, , label,job] of entry.checks){
  const {probe,kind}=publicProbe(o,job),row=E('li');
  row.append(E('span',label+' '),serviceStatusBadge(kind),
   E('p','최근 점검 '+(probe?.checked_at?date(probe.checked_at)+' (KST)':'미확인'),'read-muted'));
  checks.append(row);
 }
 section.append(checks,button('요청 로그 보기 →',()=>go('logs')));
 return section;
}
function servicePerformanceDefinition(key){
 const entry=publicRequestPaths[key];
 return entry?{name:entry.label,target:'FastAPI',label:'앱 응답시간 p95',color:serviceDefinitions.app.color}:serviceDefinitions[key];
}
function showServices(o){const key=state.service,entry=publicRequestPaths[key],def=servicePerformanceDefinition(key),metric=serviceMetric(o,key),servers=state.dashboard?.servers||[];pageTitle('서비스 모니터링 상세 · '+(entry?def.name:'직원 포털 A · '+def.name),o);page.append(button('← 서비스 상태로 돌아가기',()=>go('dashboard')));const switchService=(next,focusId)=>{
 if(state.busy)return;
 state.service=next;remember();page.replaceChildren();showServices(o);
 if(focusId)page.querySelector('#'+focusId)?.focus?.();
};
 const layout=E('div',undefined,'service-analysis-layout');
 const group=E('div',undefined,'service-groups');
 group.setAttribute('role','group');group.setAttribute('aria-label','서비스 그룹 선택');
 for(const [groupKey,label] of [['portal','직원 포털 A'],['homepage','홈페이지 B'],['community','커뮤니티 C']]){
  const selected=groupKey===(entry?key:'portal');
  const target=groupKey==='portal'?(entry?'app':key):groupKey;
  const id='service-group-'+groupKey;
  const b=button(label,()=>{if(!selected)switchService(target,id)});
  b.setAttribute('id',id);b.setAttribute('aria-pressed',String(selected));
  b.classList.add('service-tab-card');group.append(b);
 }
 layout.append(group);
 const keys=['app','database','proxy'];
 const tabs=E('div',undefined,'service-tabs');
 tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','직원 포털 A 구성 요소');tabs.setAttribute('aria-orientation','horizontal');
 if(!entry)keys.forEach((k,i)=>{const b=button('',()=>switchService(k));const label=serviceDefinitions[k]?.name||publicRequestPaths[k].label;
 const check=serviceDetailStatus(o,servers,k);
 b.append(uiIcon(publicRequestPaths[k]?'app':k),E('span',label),serviceStatusBadge(check.kind));
 b.append(E('small','최근 점검 '+(check.checkedAt?date(check.checkedAt)+' (KST)':'미확인'),'service-tab-time'));
 if(k===key){const selected=E('small','선택됨','service-tab-selected');selected.setAttribute('aria-hidden','true');b.append(selected)}
 b.setAttribute('aria-label',label);b.classList.add('service-tab-card','service-tab-'+k);b.setAttribute('role','tab');b.setAttribute('aria-selected',String(k===key));b.setAttribute('aria-controls','service-analysis-panel');b.setAttribute('id','service-tab-'+k);b.tabIndex=k===key?0:-1;b.onkeydown=e=>{if(['ArrowRight','ArrowLeft','ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?keys.length-1:(i+(['ArrowRight','ArrowDown'].includes(e.key)?1:keys.length-1))%keys.length;switchService(keys[next],'service-tab-'+keys[next])}};tabs.append(b)});const panel=E('section',undefined,'service-analysis-panel');panel.setAttribute('id','service-analysis-panel');if(!entry)panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',entry?'service-group-'+key:'service-tab-'+key);const head=E('div',undefined,'service-analysis-head');
 if(entry){
  const status=serviceDetailStatus(o,servers,key);
  head.append(uiIcon('app'),E('h3',entry.label),serviceStatusBadge(status.kind));
  panel.append(head,E('p','앱 응답시간 p95 (ms)','svc-label'),E('strong',publicMetricText(metric,'ms'),'service-main-value'));
 }else{
  head.append(uiIcon(key),E('h3',def.name+' · '+def.target),serviceBadge(servers,key));
  panel.append(head,E('p',def.label+' (ms)','svc-label'),E('strong',metric?.status==='no_data'?'미수집':metricText(metric,'ms'),'service-main-value'));
 }
 const health=serviceState(servers,key);
 if(!entry)panel.append(E('p','현재 기능 점검: '+health.label+' · 최근 점검 '+date(health.row?.last_checked_at)+' (KST)','read-muted'));
 if(o.historical)panel.append(E('p','과거 지표는 선택 종료 시점의 값이며 기능 점검 배지는 현재 상태입니다.','read-note'));const modes=E('div',undefined,'service-modes');for(const [mode,label]of [['full','전체 범위'],['zoom','변화 확대']]){const b=button(label,()=>{state.serviceScales[key]=mode;page.replaceChildren();showServices(o)});b.setAttribute('aria-pressed',String(state.serviceScales[key]===mode));modes.append(b)}if(!entry||metricPoints(metric?.points).length)panel.append(modes);const plot=E('div',undefined,'service-detail-chart');servicePlot(plot,metric?.points,def.color,def.label,false,state.serviceScales[key]==='zoom');const stats=serviceStats(metric?.points),summaries=E('div',undefined,'service-statistics');const current=metric?.status==='ok'&&Number.isFinite(metric.value)?metric.value:null;for(const [kind,label,value]of [['current',o.historical?'종료 시점':'현재값',current],['mean','표본 평균',stats.mean],['max','최대',stats.max],['min','최소',stats.min],['spread','표준 편차',stats.std]]){const item=E('div'),icon=E('span',undefined,'service-stat-icon service-stat-'+kind);icon.append(uiIcon(kind));const text=E('div');text.append(E('span',label),E('strong',Number.isFinite(value)?fmt(value,3)+' ms':'데이터 없음'));if(kind==='current'&&current!==null){const latest=metricPoints(metric?.points).at(-1);if(latest){const timestamp=E('small','('+new Date(latest[0]).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})+')','service-stat-time');timestamp.setAttribute('title','현재값에 대응하는 마지막 유효 표본 시각 (KST)');text.append(timestamp)}}item.append(icon,text);summaries.append(item)}const chartRow=E('div',undefined,'service-detail-chart-row');
 const chartPanel=E('section',undefined,'service-detail-box'),summaryPanel=E('section',undefined,'service-detail-box');
 chartPanel.append(E('h3',def.label+' 추이'),plot);
 summaryPanel.append(E('h3','응답시간 요약'),summaries);
 chartRow.append(chartPanel,summaryPanel);
 const evidenceRow=E('div',undefined,'service-detail-evidence-row'),metricsPanel=E('section',undefined,'service-detail-box');
 metricsPanel.append(E('h3','주요 지표'),serviceAuxiliary(o,key));
 evidenceRow.append(metricsPanel,entry?publicServiceCheckHistory(o,entry):serviceCheckHistory(o,key,health));
 if(entry){
  panel.append(chartRow,evidenceRow);
  layout.append(panel);page.append(layout);return;
 }
 panel.append(chartRow,evidenceRow,E('p','유효 표본 '+stats.count+'개 · 평균·최대·최소·표준 편차는 구간별 p95 표시 표본의 통계이며 전체 요청의 통계가 아닙니다.','read-muted'));if(metric?.status!=='ok')panel.append(E('p','지표 상태: '+name(metric?.status||'no_data')+' · 조회 가능한 과거 추이와 구분합니다.','read-note'));layout.append(tabs,panel);page.append(layout);if(key==='app')page.append(E('p','HTTP 요청량·5xx 서버 오류는 앱 계측값입니다.','read-muted'));if(key==='database')page.append(E('p','앱 DB 작업시간은 애플리케이션 내부 계측값입니다. PostgreSQL 전체 부하나 세션 수를 뜻하지 않습니다. DB 연결 수·활성 세션은 미수집입니다.','read-muted'));if(key==='proxy')page.append(E('p','핵심 수치는 /health 경로 기준입니다. 아래 경로별 지표는 별도로 구분합니다.','read-muted'));
 if(key!=='database')page.append(routePerformance(o,key));
}
function routePerformance(o,key){
 const columns=key==='app'
  ? [['app_routes','요청량 (건/초)',1],['app_p95_routes','응답시간 p95 (ms)',1]]
  : [['proxy_requests','요청량 (건/초)',1],['proxy_errors','5xx (건/초)',1],
     ['proxy_p95','전체 응답시간 p95 (ms)',1000],['upstream_p95','업스트림 응답시간 p95 (ms)',1000]];
 const metrics=columns.map(([id,label,mult])=>{
  const data=o.details?.[id];
  return {label,mult,status:data?.status,rows:new Map((data?.items||[]).map(row=>[row.route,row]))};
 });
 const box=E('section',undefined,'detail-card'),scroll=E('div',undefined,'phase3-table-scroll');
 box.append(E('h3','경로별 성능'));
 const table=E('table',undefined,'read-table phase3-route-table route-table-'+key),head=E('thead'),hr=E('tr'),body=E('tbody');
 for(const label of ['요청 경로',...metrics.map(metric=>metric.label)])hr.append(E('th',label));
 head.append(hr);table.append(head,body);scroll.append(table);box.append(scroll);
 const routes=new Set(metrics.flatMap(metric=>[...metric.rows.keys()]));
 for(const route of routes){
  const tr=E('tr');tr.append(E('td',route));
  for(const {mult,status,rows} of metrics){
   const cell=E('td'),row=rows.get(route);
   const value=status==='unavailable'?'조회 실패':!row?'데이터 없음':Number.isFinite(row.value)?fmt(row.value*mult):'미확인';
   const metric=E('div',undefined,'route-metric');
   metric.append(E('strong',value));
   if(status==='ok'&&row?.points?.some(p=>Number.isFinite(p[1]))){
    const plot=E('div',undefined,'route-plot');
    chart(plot,row.points.map(([at,value])=>[at,Number.isFinite(value)?value*mult:null]),'#087df3');
    metric.append(plot);
   }
   cell.append(metric);tr.append(cell);
  }
  body.append(tr);
 }
 if(!routes.size){
  const tr=E('tr'),cell=E('td',metrics.some(metric=>metric.status==='unavailable')?'경로별 지표 조회 실패':'경로별 데이터 없음');
  cell.colSpan=columns.length+1;tr.append(cell);body.append(tr);
 }
 return box;
}

function serviceCheckHistory(o,key,health){
 const section=E('section',undefined,'service-check-history service-detail-box');
 section.append(E('h3','최근 '+serviceDefinitions[key].name+' 점검 기록'));
 if(health.row?.last_checked_at){
  const code=key==='proxy'&&Number.isInteger(health.row.http_status)?' · HTTP '+health.row.http_status:'';
  section.append(E('p',date(health.row.last_checked_at)+' (KST) · '+health.label+code,'read-muted'));
 }
 const logSource=key==='app'?o.logs?.['portal-api']:key==='proxy'?o.logs?.['portal-nginx']:null;
 if(key==='database'){
  section.append(E('p','DB 기능 점검 결과를 표시합니다. 별도 DB 점검 로그는 미수집입니다.','read-muted'));
 }else if(logSource?.status!=='ok'){
  section.append(E('p','최근 로그 조회 불가','read-muted'));
 }else{
  const rows=logSource.items.filter(({fields})=>key==='app'
   ?fields.event_type==='health_check_completed'&&fields.route==='/health'
   :fields.route==='/proxy-health'||fields.route==='/health').slice(0,5);
  if(!rows.length)section.append(E('p','최근 5분에 일치하는 점검 로그 없음','read-muted'));
  else{
   const list=E('ul');
   for(const row of rows){
    const status=row.fields.status_code??row.fields.status;
    const detail=key==='proxy'&&status?'HTTP '+status:'기능 점검 이벤트';
    list.append(E('li',date(row.collected_at)+' (KST) · '+row.fields.route+' · '+detail));
   }
   section.append(list);
  }
 }
 return section;
}

function resourceComparison(o,hosts){
 const section=E('section',undefined,'resource-compare');
 const heading=E('div',undefined,'resource-compare-heading');
 heading.append(E('h3','두 서버 자원 비교'));
 const controls=E('div',undefined,'resource-compare-controls');
 controls.setAttribute('role','group');controls.setAttribute('aria-label','두 서버 비교 그래프 축');
 for(const [mode,label]of [['full','전체 0~100%'],['zoom','변화 확대']]){
  const control=button(label,()=>{
   state.graphScale=mode;
   section.replaceWith(resourceComparison(o,hosts));
   page.querySelector('.resource-compare-controls [aria-pressed="true"]')?.focus();
  });
  control.setAttribute('aria-pressed',String(state.graphScale===mode));controls.append(control);
 }
 heading.append(controls);section.append(heading);
 section.append(E('p',state.graphScale==='zoom'?'변화 확대 · 자원별 두 서버에 같은 축 범위를 적용합니다.':'같은 기간과 0~100% 축으로 비교합니다.','read-muted'));
 const grid=E('div',undefined,'resource-compare-grid');
 const roles=['service','monitoring'];
 const byRole=roles.map(role=>hosts.filter(h=>h.server_role===role));
 const sharedAxes=resourceKeys.map(key=>{
  const points=byRole.filter(matches=>matches.length===1)
   .flatMap(([host])=>host.history?.[key]?.points||[]);
  const times=points.map(([at])=>at).filter(Number.isFinite);
  return {
   bounds:resourceBounds(resourceValues(points),state.graphScale==='zoom'),
   range:times.length?[Math.min(...times),Math.max(...times)]:null,
  };
 });
 for(const [index,role]of roles.entries()){
  const matches=byRole[index],host=matches.length===1?matches[0]:null;
  const column=E('article',undefined,'resource-compare-host');
  column.append(E('h4',role==='service'?'서비스 서버':'모니터링 서버'));
  if(!host){
   column.append(E('p',matches.length?'역할이 중복되어 비교할 수 없습니다.':'이 역할의 수집 대상 미확인','read-note'));
  }else{
   column.append(collectionBadge(host),E('p','마지막 유효 표본 '+(host.last_collected_at?date(host.last_collected_at)+' (KST)':'미확인'),'read-muted'));
   resourceKeys.forEach((key,index)=>{
    const series=host.history?.[key],stats=sampleSummary(series?.points);
    const current=host.status==='ok'&&series?.status==='ok'&&Number.isFinite(host[key])?host[key]:null;
    const card=E('section',undefined,'resource-compare-metric');
    if(key===state.resourceKey&&state.resourceHost===(host.host_id||host.instance))card.classList.add('resource-compare-selected');
    card.append(E('h5',resourceNames[index]+' 사용률'),collectionBadge(host,series));
    const values=E('dl',undefined,'resource-compare-values');
    for(const [label,value]of [[o.historical?'종료 시점':'현재',current],['평균',stats.mean],['최대',stats.max]]){
     const item=E('div');item.append(E('dt',label),E('dd',Number.isFinite(value)?fmt(value,3)+' %':'미확인'));values.append(item);
    }
    const plot=E('div');
    resourceChart(plot,series?.points,resourceColors[index],resourceNames[index],
     {compact:true,zoom:state.graphScale==='zoom',...sharedAxes[index]});
    card.append(values,plot);column.append(card);
   });
  }
  grid.append(column);
 }
 section.append(grid,E('p','수집 상태는 서버 전체의 정상 여부를 뜻하지 않습니다.','read-muted'));
 return section;
}
function showResources(o){
 pageTitle('서버 리소스 상세',o);
 if(o.resources?.status==='unavailable')page.append(E('p','서버 자원 조회 실패','read-note'));
 page.append(resourceComparison(o,o.resources?.items||[]));
 const target=page.querySelector('.resource-compare-selected');
 target?.scrollIntoView?.({block:'nearest'});
}
function targetLabel(t,o){
 if(t.job==='portal-health')return t.instance.includes('proxy-health')?'프록시 생존 점검':'앱 생존 점검';
 if(t.job==='ec2-node'){
  const matches=(o?.resources?.items||[]).filter(host=>host.instance===t.instance);
  const role=matches.length===1?matches[0].server_role:null;
  return {service:'서비스 서버 자원',monitoring:'모니터링 서버 자원'}[role]||'역할 미확인 서버 자원';
 }
 return {'portal-otel':'앱 서비스 지표',prometheus:'메트릭 저장소','portal-db-health':'직원 조회 점검','homepage-health':'회사 홈페이지 B · 헬스 체크','homepage-organization':'회사 홈페이지 B · 조직도 조회','community-health':'커뮤니티 C · 헬스 체크','community-questions':'커뮤니티 C · 질문 목록 조회'}[t.job]||t.job;
}
function summaryCard(label,value){const card=E('article',undefined,'read-stat');card.append(E('p',label),E('strong',String(value)));return card}
function collectorContent(o){
 const root=E('div'),targetOK=o?.targets?.status==='ok',alertOK=o?.alerts?.status==='ok',targets=targetOK?o.targets.items:[],alerts=alertOK?o.alerts.items:[];
 const summary=E('div',undefined,'read-stats');for(const[label,value]of [['전체 수집 대상',targetOK?targets.length:'미확인'],['수집 성공',targetOK?targets.filter(t=>t.up===true).length:'미확인'],['수집 실패',targetOK?targets.filter(t=>t.up===false).length:'미확인'],['발생 중 경보',alertOK?alerts.length:'미확인']])summary.append(summaryCard(label,value));root.append(summary);
 const alertBox=E('section',undefined,'read-alert');alertBox.append(E('h3','실시간 Prometheus 경보'));if(!alertOK)alertBox.append(E('p','경보 조회 실패 · 상태 미확인'));else if(!alerts.length)alertBox.append(E('p','조회 시점에 발생 중인 Prometheus 경보가 없습니다. 미종료 사건 수와는 별도입니다.'));else for(const a of alerts){const row=E('div',undefined,'alert-row');row.append(E('b',a.name),E('span',a.severity||'심각도 미제공'));alertBox.append(row)}root.append(alertBox);
 const section=E('section',undefined,'read-section');section.append(E('h3','수집 대상 목록'));
 if(!targetOK)section.append(E('p','수집 대상 조회 실패'));
 else{
  const scroll=E('div',undefined,'phase3-table-scroll');
  const table=E('table',undefined,'read-table phase3-target-table'),head=E('thead'),hr=E('tr'),body=E('tbody');
  for(const label of ['대상','수집 내용','상태','Job','수집 주소','마지막 수집 시도'])hr.append(E('th',label));
  for(const t of targets){
   const tr=E('tr'),status=E('td');
   status.append(E('span',t.up===true?'수집 성공':t.up===false?'수집 실패':'미확인',t.up===true?'status-pill':'status-pill status-unknown'));
   if(t.up===false)status.append(E('small',t.failure_reason||'원인 미확인','phase3-collection-error'));
   tr.append(E('td',targetLabel(t,o)),E('td',roles[t.job]||(t.instance.includes('proxy-health')?'Nginx 응답 점검':'FastAPI 응답 점검')),
    status,E('td',t.job),E('td',t.instance||'미제공'),E('td',t.last_scrape_at?date(t.last_scrape_at)+' (KST)':'미제공'));
   body.append(tr);
  }
  head.append(hr);table.append(head,body);scroll.append(table);section.append(scroll);
 }
 root.append(section,E('p','수집 성공은 결과를 받아온 상태입니다. 서비스 기능 정상 여부는 별도 점검으로 판단합니다.','read-muted'));
 const logs=o?.logs;root.append(E('div','Loki · 로그 저장소: '+(logs&&Object.values(logs).every(x=>x.status==='ok')?'최근 로그 조회 성공':'이번 데이터에서 상태 미확인'),'read-note'));return root;
}
function showCollectors(o){page.append(E('h2','수집 상태'),E('p','조회 '+date(o.as_of)+' · KST','read-muted'),collectorContent(o))}
function logDuration(value,multiplier=1){
 if(typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value))value=Number(value);
 return Number.isFinite(value)&&value>=0?fmt(value*multiplier,3)+' ms':'미수집';
}
function showLogs(o){
 pageTitle('로그 분석',o);
 const toolbar=E('div',undefined,'phase3-log-toolbar'),input=E('input'),hide=E('input'),toggle=E('label');
 input.type='search';input.placeholder='요청 ID · 경로 · 이벤트 검색';input.setAttribute('aria-label','로그 검색');
 hide.type='checkbox';toggle.append(hide,E('span','정상 점검 숨기기'));
 toolbar.append(input,toggle,E('small','최근 5분 · 서비스별 최대 20건','read-muted'));page.append(toolbar);
 const rows=E('div',undefined,'phase3-log-grid');page.append(rows);
 let selected=null;
 function render(){
  rows.replaceChildren();
  for(const [service,label] of [['portal-nginx','직원 포털 A · Nginx 접근 로그'],['portal-api','직원 포털 A · FastAPI 처리 로그'],['schutz-homepage','홈페이지 B · 요청 로그'],['schutz-community','커뮤니티 C · 요청 로그']]){
   const data=o.logs?.[service],section=E('section',undefined,'detail-card phase3-log-panel'),isProxy=service==='portal-nginx',isPortal=isProxy||service==='portal-api';
   section.append(E('h3',label));rows.append(section);
   if(data?.status!=='ok'){section.append(E('p','로그 조회 실패','read-note'));continue}
   const query=input.value.trim().toLowerCase();
   const list=data.items.filter(({fields:f})=>{
    const code=Number(f.status_code??f.status);
    const check=f.synthetic===true||['/health','/proxy-health','/internal/check/employee'].includes(f.route);
    return (!hide.checked||!check||code<200||code>=300||!Number.isFinite(code)||Boolean(f.reason_code))
     && [f.request_id,f.route,f.event_type].some(value=>String(value??'').toLowerCase().includes(query));
   });
   if(isPortal&&selected?.service!==service&&selected?.id&&!list.some(({fields})=>fields.request_id===selected.id))
    section.append(E('p','연결 로그 미확인 · 현재 조회 범위','read-note'));
   if(!list.length)section.append(E('p','검색 결과 없음','read-muted'));
   const header=E('div',undefined,'phase3-log-row phase3-log-head');
   for(const title of ['시각','경로','결과','처리 시간'])header.append(E('span',title));
   if(list.length)section.append(header);
   for(const row of list){
    const f=row.fields,id=f.request_id,code=f.status_code??f.status;
    const duration=isProxy?logDuration(f.request_time,1000):logDuration(f.duration_ms);
    const matched=Boolean(selected&&(selected.row===row||(id&&id===selected.id)));
    const entry=E('details',undefined,matched?'phase3-log-selected':undefined);
    entry.open=matched;
    const summary=E('summary',undefined,'phase3-log-row');
    for(const value of [date(row.collected_at),f.route||'other',code??f.event_type??'미확인',duration])
     summary.append(E('span',String(value)));
    const summaryIndex=rows.querySelectorAll('summary.phase3-log-row').length;
    summary.onclick=event=>{
     event.preventDefault();
     const sameRow=selected?.row===row;
     selected=sameRow?null:{id,service,row};render();
     rows.querySelectorAll('summary.phase3-log-row')[summaryIndex]?.focus();
    };
    const timings=isProxy?[['전체 요청',duration],['업스트림 응답',logDuration(f.upstream_response_time,1000)],['업스트림 상태',f.upstream_status??'미수집']]
     :isPortal?[['이벤트',f.event_type??'미수집'],['앱 처리',duration],['DB 작업',logDuration(f.db_duration_ms)]]:[['요청 방식',f.method??'미수집']];
    const raw=E('details');raw.append(E('summary','원본 JSON'),pretty(f));
    entry.append(summary,definitionPanel('요청 상세',[['요청 ID',id||'미수집'],...timings,['실패 사유',f.reason_code??'기록 없음']]),raw);
    section.append(entry);
   }
  }
 }
 input.oninput=()=>{selected=null;render()};hide.onchange=()=>{selected=null;render()};render();
}
function definitionPanel(title,rows){const panel=E('section',undefined,'settings-card');panel.append(E('h3',title));const dl=E('dl',undefined,'settings-definitions');for(const[k,v]of rows){const row=E('div');row.append(E('dt',k),E('dd',v));dl.append(row)}panel.append(dl);return panel}
function showSettings(){
 const snapshot=state.mode.mode==='snapshot';page.append(E('h2','설정'),E('p','접속 환경 · 계정 · 데이터 표시 기준','read-muted'),E('div',snapshot?'저장 데이터 모드 · 실시간 서버 연결 없음':'기존 Management Web API 연결','read-note'));
 const grid=E('div',undefined,'settings-grid');grid.append(definitionPanel('연결 · 데이터',[['데이터 방식',snapshot?'저장본 조회':'실제 API 조회'],['조회 시각',date(state.data?.as_of||state.mode.as_of)],['시간대','한국 시간 · KST'],['지표 범위',{'live':'최근 15분','15m':'최근 15분','1h':'최근 1시간','6h':'최근 6시간','24h':'최근 24시간'}[state.window]],['자동 갱신',snapshot?'사용 안 함':state.window==='live'?'30초 간격':'수동 새로고침']]));
 const account=definitionPanel('계정 · 사용 범위',[['표시 계정',state.user.username],['사용 방식',state.mode.writes_enabled&&!snapshot?'조회·사건 처리':'조회 전용'],['사건 접수 · 조치 · 종료',state.mode.writes_enabled&&!snapshot?'사용 가능':'변경 불가'],['서버 로그인',snapshot?'사용하지 않음':'관리자 세션 사용']]);if(snapshot)account.append(E('p','저장본 모드에는 로그아웃할 서버 세션이 없습니다.','read-muted'));else account.append(button('로그아웃',logout));grid.append(account);page.append(grid,E('p','이 화면은 연결 정보 확인용입니다. 서버 설정·인증 정보를 변경하지 않습니다.','read-note'));
 const help=E('details',undefined,'read-help');help.append(E('summary','갱신 및 AI 결과 표시 기준'),E('p','실제 API 연결 후 실시간을 선택하면 30초마다 다시 조회합니다. 화면 조회로 AI 재분석이나 Slack 발송을 실행하지 않습니다.'),E('p','AI 결과는 서버에 저장된 원문을 표시합니다. 자동 번역은 별도 구현 전입니다.'));page.append(help)
}
const alertPanel=E('section',undefined,'alert-popover');alertPanel.hidden=true;alertPanel.setAttribute('aria-label','경보 알림');header.append(alertPanel);const bell=$('.notify');bell.setAttribute('aria-expanded','false');
let notificationDashboard=null,notificationObservation=null;
function openIncidentCount(dashboard){
 const counts=dashboard?.incident_counts;
 const values=[counts?.new,counts?.accepted,counts?.in_progress];
 return values.every(value=>Number.isInteger(value)&&value>=0)?values.reduce((sum,value)=>sum+value,0):null;
}
function renderNotificationIndicators(dashboard,observation){
 notificationDashboard=dashboard;notificationObservation=observation;
 const count=openIncidentCount(dashboard),badge=$('.tiny-badge');
 badge.textContent=count>0?String(count):'';
 badge.hidden=!(count>0);
 const firing=observation?.alerts?.status==='ok'&&observation.alerts.items.length>0;
 bell.classList.toggle('no-alerts',!(count>0||firing));
}
async function refreshNotificationIndicators(g,dashboardRequest,observationRequest){
 const [dashboard,observation]=await Promise.allSettled([dashboardRequest,observationRequest]);
 if(g!==state.generation||!state.user)return;
 renderNotificationIndicators(dashboard.status==='fulfilled'?dashboard.value:null,
  observation.status==='fulfilled'?observation.value:null);
 if(!alertPanel.hidden)renderAlertPanel();
}
let alertSequence=0;
function closeAlerts(){++alertSequence;alertPanel.hidden=true;bell.setAttribute('aria-expanded','false')}
function renderAlertPanel(){alertPanel.replaceChildren();const o=notificationObservation;const head=E('div',undefined,'alert-popover-head');head.append(E('h3','경보 · 사건'),button('닫기',closeAlerts));alertPanel.append(head);
 const total=openIncidentCount(notificationDashboard);
 const summary=E('div',undefined,'read-stats');summary.append(summaryCard('실시간 경보',o?.alerts?.status==='ok'?o.alerts.items.length+'건':'미확인'),summaryCard('미종료 사건',total===null?'미확인':total+'건'));alertPanel.append(summary);
 if(o?.alerts?.status!=='ok')alertPanel.append(E('p','실시간 경보 조회 실패 · 상태 미확인','alert-empty'));else if(!o.alerts.items.length)alertPanel.append(E('div','현재 발생 중인 Prometheus 경보는 없습니다.','alert-empty'));else for(const a of o.alerts.items){const row=E('article',undefined,'alert-row');row.append(E('b',a.name),E('span',a.severity||'심각도 미제공'));alertPanel.append(row)}
 alertPanel.append(E('p','실시간 경보는 현재 탐지 상태이며, 미종료 사건은 관리자 처리가 남은 기록입니다. 모의 사건이나 복구 후 미종료 사건은 경보 없이 남을 수 있습니다.','read-muted'),button('미종료 사건 보기 →',()=>{closeAlerts();state.q='';state.severity='all';state.stage='all';go('incidents','open')}));
 const targets=o?.targets?.status==='ok'?o.targets.items:null;alertPanel.append(E('div','수집 대상 '+(targets?targets.filter(t=>t.up).length+' / '+targets.length+' 응답':'미확인'),'read-note'),E('p','경보 조회 '+date(o?.current_as_of||o?.as_of)+' · 사건 조회 '+date(notificationDashboard?.as_of)+' · KST','read-muted'),button('수집 상태 보기 →',()=>{closeAlerts();go('collectors')}));
}
async function toggleAlerts(){if(!alertPanel.hidden){closeAlerts();return}const seq=++alertSequence;renderAlertPanel();alertPanel.hidden=false;bell.setAttribute('aria-expanded','true');
 if(state.mode.mode==='snapshot')return;
 const rows=await Promise.allSettled([api('/api/dashboard'),getObservation()]);
 if(seq!==alertSequence||alertPanel.hidden||!state.user)return;
 renderNotificationIndicators(rows[0].status==='fulfilled'?rows[0].value:null,rows[1].status==='fulfilled'?rows[1].value:null);renderAlertPanel();
}
window.addEventListener('keydown',e=>{if(e.key==='Escape')closeAlerts()});window.addEventListener('click',e=>{if(!alertPanel.contains(e.target)&&!bell.contains(e.target))closeAlerts()});
async function boot(){$('#auth-message').textContent='로그인 상태를 확인하고 있습니다…';$('#auth-retry').hidden=true;$('#login-form').hidden=true;
 try{try{const r=await fetch('/local/status',{cache:'no-store'});if(r.ok)state.mode={...await r.json(),local_mode:true}}catch{}if(state.mode.mode==='snapshot'){state.window='15m';$$('.periods button').forEach(b=>{b.disabled=b.dataset.window!=='15m'})}await restoreContext()}
 catch(e){app.hidden=true;$('#auth-screen').hidden=false;$('#auth-message').textContent='연결 확인 실패 · '+e.message;$('#auth-retry').hidden=false}}
function renderMonitoringPaths(servers,o){
 const root=$('.monitoring-paths');
 root.replaceChildren(E('h3','모니터링 시스템 상태'));
 const cards=E('div',undefined,'monitoring-path-grid');
 const external=E('article',undefined,'monitoring-path-card');
 external.append(E('h4','관리 웹 접근'),E('p','외부 점검 지점 → 관리 웹'),
  E('strong','외부 점검 미연결'),E('small','마지막 성공 미제공'));
 const proxy=E('article',undefined,'monitoring-path-card');
 const {row,kind}=serviceState(servers,'proxy');
 proxy.append(E('h4','포털 접근'),E('p','모니터링 서버 → 직원 포털'),
  serviceStatusBadge(kind));
 if(['normal','abnormal'].includes(kind)){
  const detail=[];
  if(Number.isInteger(row.http_status))detail.push('HTTP '+row.http_status);
  if(Number.isFinite(row.duration_ms))detail.push(fmt(row.duration_ms)+' ms');
  if(detail.length)proxy.append(E('p',detail.join(' · ')));
 }
 proxy.append(E('small','최근 점검 '+(row?.last_checked_at?date(row.last_checked_at)+' (KST)':'미확인')));
 if(kind!=='normal')proxy.append(E('small','마지막 성공 시각 미제공'));
 const processing=E('article',undefined,'monitoring-path-card');
 processing.append(E('h4','사건·알림 처리'),E('p','Worker · Slack'),E('strong','처리 상태 미수집'));
 const telemetry=E('article',undefined,'monitoring-path-card');
 const targets=o?.targets?.status==='ok'?o.targets.items:null;
 const logsOK=['portal-api','portal-nginx'].every(key=>o?.logs?.[key]?.status==='ok');
 telemetry.append(E('h4','메트릭·로그'),E('p',targets?'Prometheus 수집 '+targets.filter(t=>t.up===true).length+'/'+targets.length:'Prometheus 수집 미확인'),
  E('p',logsOK?'Loki 조회 성공':'Loki 조회 미확인'));
 cards.append(external,processing,proxy,telemetry);
 for(const {label,checks} of Object.values(publicRequestPaths)){
  const card=E('article',undefined,'monitoring-path-card');
  card.append(E('h4',label+' 접근'),E('p','모니터링 서버 → '+label));
  for(const [, , check,job] of checks){
   const {probe,kind}=publicProbe(o,job),line=E('p',check+' ');
   line.append(serviceStatusBadge(kind));
   if(probe?.checked_at)line.append(E('small',' · '+date(probe.checked_at)+' (KST)'));
   card.append(line);
  }
  cards.append(card);
 }
 root.append(cards);
}

function renderCollectorPreview(o){
 const root=$('.collector-preview');
 const heading=E('div',undefined,'collector-preview-heading');
 heading.append(E('h3','수집 상태'),button('전체 보기 →',()=>go('collectors')));
 root.replaceChildren(heading);
 const scroll=E('div',undefined,'collector-preview-scroll');
 const table=E('table',undefined,'read-table'),head=E('thead'),header=E('tr'),body=E('tbody');
 for(const label of ['대상 (job)','역할','상태','최근 수집'])header.append(E('th',label));
 head.append(header);
 const add=(cells)=>{const row=E('tr');for(const value of cells)row.append(E('td',value));body.append(row)};
 if(o?.targets?.status==='ok'){
  for(const t of o.targets.items)add([t.job,targetLabel(t,o),
   t.up===true?'수집 성공':t.up===false?'수집 실패':'미확인',t.last_scrape_at?date(t.last_scrape_at)+' (KST)':'미제공']);
  if(!o.targets.items.length)add(['Prometheus','수집 대상','대상 없음','미제공']);
 }else add(['Prometheus','수집 대상','조회 불가','미제공']);
 const logs=o?.logs;
 const logOK=logs?.['portal-api']?.status==='ok'&&logs?.['portal-nginx']?.status==='ok';
 add(['Loki','로그 저장소',logOK?'조회 성공':'조회 미확인','미제공']);
 table.append(head,body);scroll.append(table);root.append(scroll);
}

function renderIncidentTimeline(data){
 const root=$('.incident-timeline');
 root.replaceChildren(E('h3','장애 감지·복구 타임라인'));
 if(!Array.isArray(data?.timeline)){
  root.append(E('p','타임라인 조회 불가','read-muted'));return;
 }
 if(!data.timeline.length){
  root.append(E('p','선택 기간에 해당하는 '+incidentScopeLabel(data?.scope)+' 없음','read-muted'));return;
 }
 const start=Date.parse(data.start),end=Date.parse(data.end);
 const percent=at=>Math.max(0,Math.min(100,(Date.parse(at)-start)/(end-start)*100));
 const range=E('div',undefined,'incident-timeline-range');
 range.append(E('span',date(data.start)),E('span',date(data.end)+' (KST)'));root.append(range);
 for(const row of data.timeline){
  const card=E('article',undefined,'incident-timeline-row');
  const link=button((row.synthetic?'[모의] ':'')+name(row.rule_id)+' · '+name(row.target_id),()=>openIncident(row.id));
  const track=svg('svg',{viewBox:'0 0 100 8',preserveAspectRatio:'none','aria-hidden':'true'});
  const detected=percent(row.detected_at);
  track.append(svg('line',{x1:0,x2:100,y1:4,y2:4,stroke:'#dbe6f4','stroke-width':2}));
  if(row.recovery_checked_at)track.append(svg('line',{x1:detected,x2:percent(row.recovery_checked_at),y1:4,y2:4,stroke:'#70ad9b','stroke-width':4}));
  track.append(svg('line',{x1:detected,x2:detected,y1:0,y2:8,stroke:'#c64e66','stroke-width':1}));
  if(row.recovery_checked_at){
   const recovered=percent(row.recovery_checked_at);
   track.append(svg('line',{x1:recovered,x2:recovered,y1:0,y2:8,stroke:'#28735e','stroke-width':1}));
  }
  card.append(link,track,E('small','감지 '+date(row.detected_at)+' · '+(row.recovery_checked_at
   ?'복구 확인 '+date(row.recovery_checked_at):['login_failures','unauthorized_read','unauthorized_write'].includes(row.rule_id)?'자동 복구 판정 해당 없음':'복구 미확인')+' · 사건 종료 '+date(row.closed_at)+' (KST)'));
  root.append(card);
 }
 if(data.timeline_truncated)root.append(E('p','최근 20건 표시','read-muted'));
 root.append(E('small','사건 종료 시각은 복구 확인 시각과 별도로 관리됩니다.','read-muted'));
}

function incidentScopeLabel(scope){return {operational:'운영 사건',synthetic:'모의 사건',all:'전체 사건'}[scope]||'운영 사건'}
function incidentScopeControl(){
 const holder=$('.incident-trend').parentNode.querySelector('.panel-head');
 let select=holder.querySelector('.incident-scope-select');
 if(!select){select=E('select',undefined,'incident-scope-select');select.setAttribute('aria-label','사건 집계 범위');
  for(const[value,label]of [['operational','운영'],['synthetic','모의'],['all','전체']]){const option=E('option',label);option.value=value;select.append(option)}
  select.onchange=()=>{state.incidentScope=select.value;remember();loadView()};holder.append(select)}
 select.value=state.incidentScope;
}
function renderIncidentOverview(data){
 incidentScopeControl();
 const trend=$('.incident-trend'),breakdown=$('.incident-breakdown');
 for(const note of $$('.overview-panel .panel-head .overview-note'))note.textContent=incidentScopeLabel(state.incidentScope)+' · 선택 기간';
 trend.replaceChildren();breakdown.replaceChildren();
 if(!data?.buckets?.length||!data.types){
  for(const holder of [trend,breakdown])holder.append(E('p','사건 집계를 확인할 수 없습니다.','overview-empty'));
  return;
 }
 const donutColors=['#E7A0AD','#EFC58F','#A8C5E8'];
 const buckets=data.buckets;
 const maximum=Math.max(1,...buckets.flatMap(b=>[b.detected,b.closed]));
 const w=420,h=180,x=i=>36+i*366/(buckets.length-1),y=v=>144-v*126/maximum;
 const chart=svg('svg',{viewBox:'0 0 '+w+' '+h,role:'img','aria-label':incidentScopeLabel(data?.scope)+' 발생 및 종료 건수 추이'});
 for(const n of [...new Set([0,Math.floor(maximum/2),maximum])]){
  chart.append(svg('line',{x1:36,x2:402,y1:y(n),y2:y(n),stroke:'#e0e9f4'}));
  chart.append(svg('text',{x:29,y:y(n)+4,'text-anchor':'end',fill:'#4f6888','font-size':12},n));
 }
 const legend=E('div',undefined,'incident-chart-legend');
 for(const [key,label,color] of [['detected','발생','#eb5468'],['closed','사건 종료','#478ff1']]){
  chart.append(svg('polyline',{points:buckets.map((b,i)=>x(i)+','+y(b[key])).join(' '),fill:'none',stroke:color,'stroke-width':2}));
  buckets.forEach((b,i)=>{
   const point=svg('circle',{cx:x(i),cy:y(b[key]),r:3,fill:'white',stroke:color,'stroke-width':1.5});
   point.append(svg('title',{},date(b.start)+' (KST) · '+label+' '+b[key]+'건'));chart.append(point);
  });
  const total=buckets.reduce((n,b)=>n+b[key],0);
  legend.append(E('span',label+' '+total+'건'));
 }
 const first=Date.parse(data.start),last=Date.parse(data.end);
 const axisLabel=last-first>=DAY_MS?value=>kstInput(value).slice(0,10):clock;
 chart.append(svg('text',{x:36,y:170,fill:'#4f6888','font-size':12},axisLabel(first)));
 chart.append(svg('text',{x:402,y:170,'text-anchor':'end',fill:'#4f6888','font-size':12},axisLabel(last)));
 trend.append(chart,legend,E('small','12개 구간 · 종료는 사건 처리 기록 기준','overview-note'));
 const entries=[['delay','응답 지연'],['collection','수집 실패'],['other','기타']];
 const total=entries.reduce((n,[key])=>n+data.types[key],0);
 const donut=svg('svg',{viewBox:'0 0 150 150',role:'img','aria-label':'유형별 발생 합계 '+total+'건'});
 const ring={cx:75,cy:75,r:56,fill:'none','stroke-width':17};
 donut.append(svg('circle',{...ring,stroke:'#e4edf7'}));
 const list=E('ul',undefined,'incident-type-list');let offset=0;
 entries.forEach(([key,label],i)=>{
  const count=data.types[key],share=total?count/total*100:0;
  if(share){
   donut.append(svg('circle',{...ring,stroke:donutColors[i],pathLength:100,'stroke-dasharray':share+' 100','stroke-dashoffset':-offset,transform:'rotate(-90 75 75)'}));
   offset+=share;
  }
  const item=E('li');
  const dot=svg('svg',{viewBox:'0 0 12 12','aria-hidden':'true'});
  dot.append(svg('rect',{width:12,height:12,rx:3,fill:donutColors[i]}));
  item.append(dot,E('span',label),E('strong',count+'건'+(total?' ('+fmt(share,1)+'%)':'')));
  list.append(item);
 });
 donut.append(svg('text',{x:75,y:70,'text-anchor':'middle',fill:'#4f6888','font-size':13},'총 발생'),svg('text',{x:75,y:94,'text-anchor':'middle',fill:'#112e54','font-size':22,'font-weight':700},total+'건'));
 breakdown.append(donut,list);
 if(!total)breakdown.append(E('small','선택 기간에 발생한 '+incidentScopeLabel(data?.scope)+' 없음','overview-note'));
}

boot();
})();
