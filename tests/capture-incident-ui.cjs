'use strict';
// Render repository UI with deterministic local API fixtures. Never connects to AWS/AI/Slack.
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/incident-ui-v31');fs.mkdirSync(out,{recursive:true});
const snap=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/monitoring-ui.json'),'utf8'));
const id='11111111-1111-4111-8111-111111111111',past='22222222-2222-4222-8222-222222222222',at='2026-10-26T04:10:00Z';
const attempt={number:1,outcome:'succeeded',started_at:'2026-10-26T04:01:00Z',finished_at:'2026-10-26T04:01:14Z'};
const evidence=[0,1,2,3,4,5].map(n=>({id:'probe:app:'+n,kind:'check',occurred_at:`2026-10-26T04:0${n}:00Z`,payload:{status_code:n<3?500:200,probe_success:n>=3,duration_ms:180+n}}));
const history={id:'history:'+past,kind:'historical_context',occurred_at:'2026-10-23T04:00:00Z',payload:{incident_id:past,target_id:'app',rule_id:'availability_failure',synthetic:true,detected_at:'2026-10-23T03:00:00Z',closed_at:'2026-10-23T03:10:00Z',action_notes:['배포 이력과 애플리케이션 오류를 확인한 뒤 기능 점검을 수행했습니다.']}};
const incident={id,target_id:'app',rule_id:'availability_failure',severity:'warning',severity_source:'stored_prometheus_evidence',status:'in_progress',synthetic:true,detected_at:'2026-10-26T04:00:00Z',closed_at:null,evidence,
monitoring:{alert_name:'PortalProbeFailed',state:'normal',last_evaluated_at:at,recovery_confirmed:true},
closure:{eligible:true,reasons:[]},actions:[{kind:'action',content:'오류 시점의 로그 및 배포 이력을 확인했습니다. 현재 연속 정상 점검과 기능 응답을 확인했습니다.',actor_id:'preview-admin',created_at:'2026-10-26T04:06:00Z'}],
jobs:[{kind:'ai',status:'succeeded',mode:'live',attempts:1,history:[attempt],input_evidence:[...evidence,history],result:{summary:'모의 기능 점검에서 HTTP 500 표본 3건이 관측되었습니다. 현재 점검은 정상이지만 사건은 담당자 확인 전까지 조치 중으로 유지됩니다.',hypotheses:['애플리케이션 처리 오류 또는 배포 변경의 영향 가능성. 원인 확정은 추가 로그 대조가 필요합니다.'],next_checks:['오류 시점의 요청 ID와 배포 이력을 대조하세요.','과거 조치의 적용 조건이 이번 사건과 일치하는지 확인하세요.'],limitations:'과거 사건과의 유사성은 원인 또는 조치 효과를 확정하지 않습니다.',evidence_ids:['probe:app:1','history:'+past]}},
{kind:'slack',status:'succeeded',mode:'live',attempts:1,history:[attempt],result:{sent:true}},
{kind:'slack_ai',status:'succeeded',mode:'live',attempts:1,history:[attempt],result:{sent:true}},
{kind:'slack_recovery',status:'pending',mode:'live',attempts:0,history:[],result:null}]};
const cases=[incident,{...incident,id:'33333333-3333-4333-8333-333333333333',target_id:'database',rule_id:'response_delay',severity:null,status:'new',jobs:[]},{...incident,id:past,status:'closed',closed_at:'2026-10-23T03:10:00Z',detected_at:'2026-10-23T03:00:00Z',jobs:[],evidence:[],actions:[]}];
const posts=[],errors=[],checks=[];
const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost'),p=url.pathname;let data;
 if(p==='/local/status')data={mode:'live',writes_enabled:true};
 else if(p==='/api/auth/context')data={user:{username:'검수 관리자',role:'admin'},csrf_token:'fixture-only'};
 else if(p==='/api/management/capabilities')data={mode:'live',writes_enabled:true};
 else if(p==='/api/dashboard')data={as_of:at,incident_counts:{new:1,accepted:0,in_progress:1,closed:1},servers:[{target_id:'app',status:'normal',collection_delayed:false,last_checked_at:at}]};
 else if(p==='/api/observability')data={...snap.observability,as_of:at};
 else if(p==='/api/incidents'){const q=url.searchParams.get('q'),state=url.searchParams.get('state'),tab=url.searchParams.get('status');const items=cases.filter(c=>(tab!=='closed'||c.status==='closed')&&(tab!=='open'||c.status!=='closed')&&(!q||c.target_id==='app')&&(!state||c.status===state));data={items,total:items.length,page:1,page_size:20,page_count:1,counts:{new:1,accepted:0,in_progress:1,closed:1},summary_total:3};}
 else if(p.startsWith('/api/incidents/')){if(req.method==='POST'){posts.push(p);res.statusCode=409;data={message:'검수용 상태 충돌 응답'};}else data=cases.find(c=>c.id===p.split('/')[3])||incident;}
 if(data){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));return;}
 const relative=p==='/'?'static/schutz-ui/index.html':decodeURIComponent(p).replace(/^\//,'');const file=path.resolve(root,relative);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;const browser=await chromium.launch({headless:true});try{
 const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ko-KR'});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/#view=incidents');await page.getByRole('button',{name:'상세 보기 →'}).first().waitFor();
 for(const viewport of [{width:1440,height:1000},{width:1280,height:900}]){
  const prefix=String(viewport.width);await page.setViewportSize(viewport);
  const listBox=await page.locator('.incident-table-scroll').first().evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth}));assert(listBox.scroll<=listBox.width+1,prefix+' 목록 표 가로 잘림');
  await page.screenshot({path:path.join(out,prefix+'-01-list.png'),fullPage:true});
  assert.equal(await page.locator('.incident-table th').count(),9);assert.equal(await page.locator('.incident-count-card').count(),4);
  await page.getByRole('button',{name:'상세 보기 →'}).first().click();await page.locator('.incident-workspace').waitFor();
  assert.equal(await page.getByRole('button',{name:'화면 닫기',exact:true}).count(),1);assert.equal(await page.locator('#detail-close').isVisible(),false);
  const secondary=await page.locator('.incident-status-meta dt,.incident-workspace .read-muted,.incident-workspace .read-note').evaluateAll(es=>es.filter(e=>e.getClientRects().length).map(e=>parseFloat(getComputedStyle(e).fontSize)));assert(secondary.every(size=>size>=13),prefix+' 보조 설명 글자 크기');checks.push(prefix+'px: 보조 설명 최소 13px 확인');
  const guide=await page.locator('.incident-judgement').boundingBox();assert(guide.height<160,prefix+' 운영 판단 과도한 여백');
  const overflow=await page.locator('#detail').evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth}));assert(overflow.scroll<=overflow.width+1,prefix+' 상세 가로 잘림');
  await page.screenshot({path:path.join(out,prefix+'-02-detail-top.png')});
  for(const selector of ['.context-history','.incident-ai-card','.incident-slack-card','.incident-evidence-panel','.incident-action-section','.incident-closure-section']){const el=page.locator(selector);await el.scrollIntoViewIfNeeded();await el.screenshot({path:path.join(out,prefix+'-'+selector.slice(1)+'.png')});}
  assert.equal(await page.locator('.slack-delivery-row').count(),3);assert.equal(await page.getByLabel('전체 사건 ID').inputValue(),id);
  const buttons=await page.locator('.incident-action-section form>button,.incident-closure-section form>button,.draft-panel>button').evaluateAll(es=>es.filter(e=>e.getClientRects().length).map(e=>({text:e.textContent,height:e.getBoundingClientRect().height,x:e.getBoundingClientRect().x})));
  assert(buttons.every(b=>b.height>=44));const save=buttons.find(b=>b.text==='조치 기록 저장'),close=buttons.find(b=>b.text==='사건 종료');assert(Math.abs(save.x-close.x)<2,prefix+' 저장·종료 정렬');
  checks.push(prefix+'px: 목록 9열·요약 4개, 표/상세 가로 잘림 없음, 닫기 단일 노출, 상단 안내 여백 축소, 버튼 44px·정렬 통과');
  await page.getByRole('button',{name:'← 목록으로 돌아가기',exact:true}).click();await page.locator('.incident-table').waitFor();
 }
 await page.setViewportSize({width:1440,height:1000});
 await page.getByLabel('사건 검색',{exact:true}).fill('FastAPI');await page.getByLabel('심각도 필터',{exact:true}).selectOption('warning');await page.getByLabel('사건 상태 필터',{exact:true}).selectOption('in_progress');await page.getByRole('button',{name:'검색 적용',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.incident-list-count')?.textContent.includes('총 1건'));
 assert(page.url().includes('q=FastAPI')&&page.url().includes('severity=warning'));checks.push('데스크톱 검색·심각도·상태 필터 및 서버 총 1건 표시');
 await page.getByRole('button',{name:'상세 보기 →'}).first().click();await page.locator('.incident-workspace').waitFor();
 await page.getByRole('button',{name:'조치 초안 자동 작성',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#action-content')?.value.length>0);assert.equal(posts.length,0);checks.push('기존 초안 작성은 입력만 수행·자동 저장 없음');
 await page.getByLabel('조치 내용',{exact:true}).fill('409 충돌 후에도 유지할 조치 초안');await page.getByRole('button',{name:'조치 기록 저장',exact:true}).click();await page.getByText(/최신 상태를 다시 조회했습니다/).waitFor();assert.equal(await page.getByLabel('조치 내용',{exact:true}).inputValue(),'409 충돌 후에도 유지할 조치 초안');assert.equal(posts.length,1);checks.push('409 단일 요청·최신 상세 조회·조치 입력 보존');
 await page.getByRole('button',{name:'원본 사건 상세 보기',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.incident-id-row textarea')?.value==='22222222-2222-4222-8222-222222222222');await page.goBack();await page.waitForFunction(()=>document.querySelector('.incident-id-row textarea')?.value==='11111111-1111-4111-8111-111111111111');checks.push('과거 원본 조회 및 브라우저 뒤로가기 복귀');
 await page.getByRole('button',{name:'화면 닫기',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#detail').open);await page.goForward();await page.locator('.incident-workspace').waitFor();checks.push('닫기·브라우저 앞으로가기 상세 복원');
 await page.getByRole('button',{name:'← 목록으로 돌아가기',exact:true}).click();await page.locator('.incident-table').waitFor();assert.equal(await page.getByLabel('사건 검색',{exact:true}).inputValue(),'FastAPI');checks.push('목록 복귀 후 검색·필터 유지');
 incident.closure={eligible:false,reasons:['TWO_HEALTHY_CHECKS_REQUIRED']};await page.getByRole('button',{name:'상세 보기 →'}).first().click();await page.locator('.incident-workspace').waitFor();assert.equal(await page.getByRole('button',{name:'사건 종료',exact:true}).isEnabled(),false);checks.push('서버 종료 조건 미충족 시 종료 버튼 비활성');
 await page.getByRole('button',{name:'← 목록으로 돌아가기',exact:true}).click();await page.locator('.incident-table').waitFor();incident.closure={eligible:true,reasons:[]};
 await page.getByLabel('사건 검색',{exact:true}).fill('');await page.getByLabel('심각도 필터',{exact:true}).selectOption('all');await page.getByLabel('사건 상태 필터',{exact:true}).selectOption('all');await page.getByRole('button',{name:'검색 적용',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.incident-list-count')?.textContent.includes('총 2건'));
 await page.getByRole('button',{name:'상세 보기 →'}).nth(1).click();await page.getByRole('button',{name:'사건 접수',exact:true}).waitFor();checks.push('신규 사건 접수 버튼 유지');
 // Closed-case rendering uses only local fixtures; no extra POST requests.
 incident.status='closed';incident.closed_at='2026-10-26T04:10:00Z';incident.rule_id='monitoring_target_down';
 incident.monitoring={alert_name:'MonitoringTargetDown',state:'unknown',last_evaluated_at:'2026-10-26T04:09:00Z',recovery_confirmed:false};
 incident.evidence=[{id:'prom:fixture:1',kind:'prometheus',occurred_at:'2026-10-26T04:09:00Z',payload:{rule_id:'monitoring_target_down',state:'normal'}}];
 const beforeClosedPosts=posts.length;
 for(const viewport of [{width:1440,height:1000},{width:1280,height:900}]){
  await page.setViewportSize(viewport);
  // Open through the ordinary list to avoid depending on deep-link parameter names.
  await page.goto(base+'/#view=incidents&status=closed');await page.getByRole('button',{name:'상세 보기 →'}).first().click();
  await page.locator('.incident-prometheus-summary').waitFor();
  const panel=page.locator('.incident-prometheus-summary'),value=await panel.textContent();
  assert(value.includes('종료 전 저장 근거')&&value.includes('정상 지표 확인'));
  assert(value.includes('현재 상태나 종료 당시 복구 완료를 보증하지 않습니다.'));
  assert(!value.includes('복구 조건 미충족')&&!value.includes('수집 미확인'));
  const width=await page.locator('#detail').evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth}));assert(width.scroll<=width.width+1);
  await page.screenshot({path:path.join(out,viewport.width+'-closed-monitoring.png')});
  checks.push(viewport.width+'px: 종료 전 저장 근거·관측 시각 표시, 현재 상태와 구분, 추가 변경 요청 없음');
 }
 assert.equal(posts.length,beforeClosedPosts);
 assert.deepEqual(errors,[]);checks.push('브라우저 JavaScript 오류 0건');
 fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({data:'격리 검수 데이터이며 실제 운영 상태가 아닙니다.',scope:'desktop-only',checks,posts,errors},null,2));console.log(checks.join('\n'));
 }finally{await browser.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1});
