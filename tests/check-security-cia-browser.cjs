'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const observation=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/monitoring-ui.json'),'utf8')).observability;
const id='11111111-1111-4111-8111-111111111111';
const current=Date.now(),stamp=delta=>new Date(current+delta).toISOString();
let browser,server,base;
const evidence=[0,1,2].map(i=>({id:'event:cia-unit-'+i,kind:'security',occurred_at:stamp(-180000+i*1000),payload:{event_type:'authorization_denied',reason_code:'FORBIDDEN',status_code:403,method:'PUT',route:'/api/posts/{post_id}',account_ref:'test_user',source_ref:'lab-fixture',synthetic:true,test_run_id:'CIA-PREVIEW'}}));
const detail=(status='closed')=>({id,target_id:'sec:fixture',rule_id:'unauthorized_write',synthetic:true,test_run_id:'CIA-PREVIEW',status,detected_at:stamp(-175000),closed_at:status==='closed'?stamp(-60000):null,evidence,actions:[{kind:'action',created_at:stamp(-90000),content:'로컬 시험 기록: 변경 거부와 시험 데이터 미변경 확인. 추가 네트워크 차단 미실행.'}],closure:{eligible:true,reasons:[],test_stop_confirmation_required:true},jobs:[{kind:'ai',status:'succeeded',mode:'demo',attempts:1,history:[],input_evidence:evidence,result:{summary:'로컬 예시: 타인 게시글 변경 요청 3건이 HTTP 403으로 거부됐습니다.',hypotheses:[],evidence_ids:evidence.map(e=>e.id),next_checks:['원본 데이터와 요청 전후 해시를 비교하고 정상 사용자 이용을 확인하세요.'],limitations:'출처는 시험 식별자입니다. 공격 성공·정보 유출·추가 차단 완료는 확인하지 않았습니다.'}},...['slack','slack_ai',...(status==='closed'?['slack_closed']:[])].map(kind=>({kind,status:'succeeded',mode:'demo',attempts:1,result:{sent:false},history:[]}))]});
before(async()=>{
 server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');let file;
  try{file=path.resolve(root,url.pathname==='/'?'static/schutz-ui/index.html':decodeURIComponent(url.pathname).slice(1));}catch{res.writeHead(400);res.end();return;}
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.setHeader('content-type',({'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});
});
after(async()=>{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));});
async function review(width,status,run,controlEnabled=false){
 let controlOp=null;
 const context=await browser.newContext({viewport:{width,height:1000},locale:'ko-KR',serviceWorkers:'block'});
 const errors=[],posts=[];
 try{
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(controlEnabled&&url.origin===base&&req.method()==='POST'&&url.pathname==='/api/incidents/'+id+'/revoke-test-sessions'){assert.deepEqual(req.postDataJSON(),{confirm_account:'test_user'});assert.equal(req.headers()['x-csrf-token'],'fixture-only');posts.push(req.method()+' '+url.pathname);controlOp={operation_id:'fixture-operation',status:'succeeded',revoked_count:1};await route.fulfill({json:controlOp});return;}
   if(url.origin!==base||req.method()!=='GET'){posts.push(req.method()+' '+url.pathname);await route.abort();return;}
   let body;
   if(['/local/status','/api/management/capabilities'].includes(url.pathname))body={mode:'live',writes_enabled:true};
   else if(url.pathname==='/api/auth/context')body={user:{username:'fixture-admin',role:'admin'},csrf_token:'fixture-only'};
   else if(url.pathname==='/api/dashboard')body={as_of:stamp(0),incident_counts:{new:0,accepted:0,in_progress:status==='closed'?0:1,closed:status==='closed'?1:0},servers:[]};
   else if(url.pathname==='/api/observability')body=observation;
   else if(url.pathname==='/api/incidents')body={items:[detail(status)],total:1,page:1,page_count:1,page_size:20,counts:{new:0,accepted:0,in_progress:status==='closed'?0:1,closed:status==='closed'?1:0}};
   else if(url.pathname==='/api/incidents/'+id){body=detail(status);if(controlEnabled)body.session_control={enabled:true,eligible:true,account_ref:'test_user',operation:controlOp,notice:'지정 시험 계정의 기존 세션만 폐기합니다.'};}
   else if(url.pathname==='/api/dashboard/incident-overview'){
    const scope=url.searchParams.get('scope')||'operational',count=scope==='operational'?0:1;
    body={scope,start:stamp(-900000),end:stamp(0),buckets:Array.from({length:12},(_,i)=>({start:stamp(-900000+i*75000),detected:i===9?count:0,closed:i===11&&status==='closed'?count:0})),types:{delay:0,collection:0,other:count},timeline:count?[{id,synthetic:true,target_id:'sec:fixture',rule_id:'unauthorized_write',detected_at:stamp(-175000),closed_at:status==='closed'?stamp(-60000):null,recovery_checked_at:null}]:[]};
   }
   if(body!==undefined){await route.fulfill({json:body});return;}
   if(url.pathname.startsWith('/api/')){errors.push('Unhandled API '+url.pathname);await route.abort();return;}
   await route.continue();
  });
  await run(page);
  assert.deepEqual(errors,[]);assert.deepEqual(posts,controlEnabled?['POST /api/incidents/'+id+'/revoke-test-sessions']:[]);
 }finally{await context.close();}
}
async function capture(page,name){
 if(!process.env.CIA_CAPTURE_DIR)return;
 await page.evaluate(()=>{const note=document.createElement('p');note.textContent='로컬 모의 데이터 검수 화면 · 실제 운영 결과 아님';note.style.cssText='position:fixed;top:0;left:0;right:0;background:#fff3c9;color:#593d00;text-align:center;padding:6px;z-index:99999;margin:0;font:14px sans-serif';document.body.append(note)});
 fs.mkdirSync(process.env.CIA_CAPTURE_DIR,{recursive:true});
 await page.screenshot({path:path.join(process.env.CIA_CAPTURE_DIR,name+'.png'),fullPage:false});
}
for(const width of [1440,390]){
 test(width+'px: scope selects trial and persists across reload',async()=>review(width,'closed',async page=>{
  await page.goto(base+'/#view=dashboard');await page.locator('.incident-scope-select').waitFor();
  assert.match(await page.locator('.incident-chart-legend').textContent(),/발생 0건/);
  await page.locator('.incident-scope-select').selectOption('synthetic');
  await page.waitForFunction(()=>document.querySelector('.incident-chart-legend')?.textContent.includes('발생 1건'));
  assert.match(await page.locator('.incident-timeline').textContent(),/자동 복구 판정 해당 없음/);
  assert.match(page.url(),/incident_scope=synthetic/);
  await page.reload();await page.locator('.incident-scope-select').waitFor();
  assert.equal(await page.locator('.incident-scope-select').inputValue(),'synthetic');
  if(width===1440)await capture(page,'security-scope-preview');
 }));
 test(width+'px: recovery and closed notifications are distinct',async()=>review(width,'closed',async page=>{
  await page.goto(base+'/#view=incidents&overlay=incident-'+id);await page.locator('.incident-workspace').waitFor();
  const text=await page.locator('.incident-slack-card').textContent();
  assert.match(text,/해당 없음/);assert.match(text,/사건 종료 알림/);assert.match(text,/시험 처리 · 실제 연결 아님/);
  assert.match(await page.locator('.incident-closure-section').textContent(),/자동 증명되지는 않습니다/);
  if(width===1440){await page.locator('.incident-slack-card').scrollIntoViewIfNeeded();await capture(page,'security-notifications-preview');}
 }));
 test(width+'px: security closure requires manual stopped confirmation',async()=>review(width,'in_progress',async page=>{
  await page.goto(base+'/#view=incidents&overlay=incident-'+id);await page.locator('#test-stopped').waitFor();
  assert(await page.locator('.close-incident-action').isDisabled());
  await page.locator('#test-stopped').check();assert(!(await page.locator('.close-incident-action').isDisabled()));
  assert((await page.locator('.incident-evidence-table tbody tr').count())===3);
 }));
}

for(const width of [1440,390]){
 test(width+'px: explicit trial-session confirmation executes and displays receipt',async()=>review(width,'in_progress',async page=>{
  await page.goto(base+'/#view=incidents&overlay=incident-'+id);await page.getByRole('button',{name:'시험 세션 폐기 실행',exact:true}).waitFor();
  const run=page.getByRole('button',{name:'시험 세션 폐기 실행',exact:true});assert(await run.isDisabled());
  await page.getByText('시험 계정 test_user의 기존 세션 폐기를 실행합니다.',{exact:true}).locator('..').locator('input').check();
  assert(!(await run.isDisabled()));await run.click();
  await page.getByText(/서비스 폐기 확인 · 1건/).waitFor();
  assert.equal(await page.getByRole('button',{name:'시험 세션 폐기 실행',exact:true}).count(),0);
 },true));
}
