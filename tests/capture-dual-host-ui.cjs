'use strict';
// Browser review using an isolated loopback server and fictional metrics only.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/monitoring-ui.json'),'utf8')).observability;
const at=new Date().toISOString(),ms=Date.now();
const history=value=>({status:'ok',points:[[ms-60000,value-1],[ms-30000,value],[ms,value]]});
const host=(role,instance,cpu,memory,disk,status='ok')=>({server_role:role,server_name:role==='service'?'서비스 서버':'모니터링 서버',host_id:instance,instance,status,cpu,memory,disk,last_collected_at:at,history:{cpu:history(cpu),memory:history(memory),disk:history(disk)}});
const recent={id:'fixture-delay',target_id:'database',rule_id:'response_delay',status:'closed',synthetic:false,detected_at:new Date(ms-240000).toISOString()};
let hosts=[host('service','example-service',12,34,48),host('monitoring','example-monitoring',55,42,53)];
const errors=[],requests=[],observationQueries=[];
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');requests.push(req.method+' '+url.pathname);
 if(req.method!=='GET'){res.statusCode=405;res.end();return}
 let data;
 if(url.pathname==='/local/status')data={mode:'live',writes_enabled:false};
 else if(url.pathname==='/api/auth/context')data={user:{username:'검수 관리자',role:'admin'},csrf_token:'fixture-only'};
 else if(url.pathname==='/api/management/capabilities')data={mode:'live',writes_enabled:false};
 else if(url.pathname==='/api/dashboard')data={as_of:at,incident_counts:{new:0,accepted:0,in_progress:0,closed:5},servers:['app','database','proxy'].map(target_id=>({target_id,status:'normal',last_checked_at:at,...target_id==='proxy'&&{http_status:200}}))};
 else if(url.pathname==='/api/dashboard/incident-overview')data={start:new Date(ms-900000).toISOString(),end:at,buckets:Array.from({length:12},(_,i)=>({start:new Date(ms-900000+i*75000).toISOString(),detected:[0,0,1,2,0,1,0,0,1,0,0,0][i],closed:[0,0,0,0,1,1,2,0,0,1,0,0][i]})),types:{delay:2,collection:2,other:1},timeline:[recent]};
 else if(url.pathname==='/api/observability'){observationQueries.push(url.searchParams.toString());data={...fixture,as_of:url.searchParams.get('end')||at,historical:url.searchParams.get('window')==='custom',resources:{status:'ok',items:hosts}}}
 else if(url.pathname==='/api/incidents')data={items:url.searchParams.get('status')==='closed'?[recent]:[],total:1,page:1,page_size:20,page_count:1,counts:{new:0,accepted:0,in_progress:0,closed:5}};
 else if(url.pathname==='/api/incidents/fixture-delay')data={...recent,jobs:[{kind:'ai',status:'succeeded',result:{summary:'검수 예시입니다. DB 기능 점검에서 응답 지연이 관측된 뒤 정상 범위로 돌아왔습니다.'}}]};
 if(data){res.setHeader('content-type','application/json');res.end(JSON.stringify(data));return}
 const relative=url.pathname==='/'?'static/schutz-ui/index.html':decodeURIComponent(url.pathname).replace(/^\//,'');
 const file=path.resolve(root,relative);
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.statusCode=404;res.end();return}
 res.setHeader('content-type',({'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true});
 try{
  const guardedPage=async width=>{
   const context=await browser.newContext({viewport:{width,height:900},locale:'ko-KR',serviceWorkers:'block'});
   await context.route('**/*',route=>{
    const request=route.request();
    if(new URL(request.url()).origin===base&&request.method()==='GET')return route.continue();
    errors.push('blocked request: '+request.method());return route.abort();
   });
   context.on('page',page=>page.on('pageerror',e=>errors.push(e.message)));
   return {context,page:await context.newPage()};
  };
  for(const width of [1440,390]){
   const {context,page}=await guardedPage(width);
   await page.goto(base+'/#view=dashboard');
   await page.locator('.host-overview-card').first().waitFor();
   assert.equal(await page.locator('.host-overview-card').count(),2);
   assert.equal(await page.locator('.dashboard-gauge').count(),6);
   const monitoring=page.locator('.host-overview-card').nth(1);
   assert.match(await monitoring.locator('.res-value').first().textContent(),/55/);
   assert.match(await page.locator('.service-health-card.service-proxy').textContent(),/HTTP 200/);
   assert.match(await page.locator('.incident-trend').textContent(),/발생 5건/);
   assert.match(await page.locator('.incident-timeline').textContent(),/복구 미확인/);
   assert.match(await page.locator('.monitoring-paths').textContent(),/외부 점검 미연결.*HTTP 200/);
   assert.match(await page.locator('.collector-preview').textContent(),/Loki/);
   assert.equal(await page.locator('.incident-breakdown + .collector-preview').count(),1);
   const layout=await page.locator('.dashboard-view').evaluate(e=>[e.scrollWidth,e.clientWidth]);
   assert(layout[0]<=layout[1]+2,width+'px dashboard horizontal overflow');
   if(process.env.SCHUTZ_PREVIEW_DIR){
    await page.getByText('검수 예시입니다.',{exact:false}).waitFor();
    await page.addStyleTag({content:'body{font-family:"Noto Sans KR",sans-serif!important}'});
    await page.locator('.demo-ribbon').evaluate(e=>e.textContent='배포 전 검수 · 테스트 데이터');
    await page.locator('.profile').evaluate(e=>e.textContent='검수 관리자');
    await page.screenshot({path:path.join(process.env.SCHUTZ_PREVIEW_DIR,'SCHUTZ-dashboard-'+width+'.png'),fullPage:true});
   }
   await monitoring.locator('.resource-detail-link').click();
   await page.locator('.resource-compare-selected').waitFor();
   const comparison=page.locator('.resource-compare');
   assert.equal(await comparison.locator('.resource-compare-host').count(),2);
   assert.equal(await comparison.locator('.resource-compare-metric').count(),6);
   await comparison.getByRole('button',{name:'변화 확대'}).click();
   const axes=await comparison.locator('.resource-axis-note').allTextContents();
   assert.equal(axes.length,6);
   assert.deepEqual(axes.slice(0,3),axes.slice(3));
   assert(axes.every(label=>label.includes('미세 변화 확대')));
   assert.match(page.url(),/host=example-monitoring/);
   assert.match(await page.locator('.resource-compare-host').nth(1).locator('.resource-compare-selected').textContent(),/CPU/);
   await page.reload();await page.locator('.resource-compare-selected').waitFor();
   assert.match(await page.locator('.resource-compare-host').nth(1).locator('.resource-compare-selected').textContent(),/CPU/);
   const overflow=await page.locator('.view-panel').evaluate(e=>({client:e.clientWidth,scroll:e.scrollWidth}));
   assert(overflow.scroll<=overflow.client+2,width+'px resource panel horizontal overflow');
   const kstInput=time=>new Date(time+9*3600000).toISOString().slice(0,16);
   const end=Date.now()-3600000,start=end-3600000;
   await page.locator('.custom-period').click();
   const enteredStart=kstInput(start),enteredEnd=kstInput(end);
   const expectedStart=new Date(enteredStart+'+09:00').toISOString();
   const expectedEnd=new Date(enteredEnd+'+09:00').toISOString();
   await page.locator('#range-start').fill(enteredStart);
   await page.locator('#range-end').fill(enteredEnd);
   await page.locator('.calendar-form button[type=submit]').click();
   await page.waitForURL(/window=custom/);
   const params=new URLSearchParams(page.url().split('#')[1]);
   assert.equal(params.get('host'),'example-monitoring');
   assert.equal(params.get('start'),expectedStart);
   assert.equal(params.get('end'),expectedEnd);
   await page.waitForFunction(()=>document.querySelector('.resource-compare-selected')?.textContent.includes('종료 시점'));
   assert(observationQueries.some(query=>{const q=new URLSearchParams(query);return q.get('window')==='custom'&&q.get('start')===expectedStart&&q.get('end')===expectedEnd}));
   const previousQueries=observationQueries.length;
   const restoredResponse=page.waitForResponse(response=>response.url().includes('/api/observability?')&&response.status()===200);
   await page.reload();await restoredResponse;await page.locator('.resource-compare-selected').waitFor();
   const restored=new URLSearchParams(page.url().split('#')[1]);
   assert.equal(restored.get('host'),'example-monitoring');
   assert.equal(restored.get('window'),'custom');
   assert.equal(restored.get('start'),expectedStart);
   assert.equal(restored.get('end'),expectedEnd);
   assert(observationQueries.slice(previousQueries).some(query=>{const q=new URLSearchParams(query);return q.get('window')==='custom'&&q.get('start')===expectedStart&&q.get('end')===expectedEnd}));
   assert.match(await page.locator('.resource-compare-host').nth(1).locator('.resource-compare-selected').textContent(),/CPU/);
   // Global navigation opens details directly; switch services only within the page.
   const serviceNav=page.locator('.nav>a').nth(2);
   if(width===1440){await serviceNav.focus();await page.keyboard.press('Enter')}else await serviceNav.click();
   await page.locator('#service-analysis-panel').waitFor();
   assert.equal(await page.locator('.nav .sub').count(),0);
   assert.equal(await page.locator('.nav>a').nth(2).getAttribute('aria-expanded'),null);
   assert.equal(await page.locator('.heading h1').textContent(),'서비스 모니터링');
   const tabs=page.locator('.service-tabs button');
   assert.equal(await tabs.count(),3);
   const checks=page.locator('.service-check-history');
   assert.match(await checks.textContent(),/최근 FastAPI 점검 기록/);
   const first=await tabs.nth(0).boundingBox(),last=await tabs.nth(2).boundingBox();
   assert(first&&last&&Math.abs(first.y-last.y)<2,width+'px services must share one row');
   await tabs.nth(0).focus();await page.keyboard.press('ArrowRight');
   await page.waitForURL(/service=database/);
   assert.equal(await page.locator('#service-tab-database').evaluate(e=>e===document.activeElement),true);
   assert.match(await checks.textContent(),/최근 PostgreSQL 점검 기록.*DB 점검 로그는 미수집/);
   await tabs.nth(2).click();await page.waitForURL(/service=proxy/);
   assert.match(await checks.textContent(),/최근 Nginx 점검 기록.*HTTP 200/);
   assert.doesNotMatch(await checks.textContent(),/FastAPI|PostgreSQL/);
   assert.match(await page.locator('.service-analysis-head').textContent(),/Nginx/);
   await page.goBack();await page.locator('#service-analysis-panel').waitFor();
   assert.match(await page.locator('.service-analysis-head').textContent(),/PostgreSQL/);
   await page.reload();await page.locator('#service-analysis-panel').waitFor();
   assert.match(await page.locator('.service-analysis-head').textContent(),/PostgreSQL/);
   const serviceParams=new URLSearchParams(page.url().split('#')[1]);
   assert.equal(serviceParams.get('start'),expectedStart);
   assert.equal(serviceParams.get('end'),expectedEnd);
   const serviceOverflow=await page.locator('.view-panel').evaluate(e=>({client:e.clientWidth,scroll:e.scrollWidth}));
   assert(serviceOverflow.scroll<=serviceOverflow.client+2,width+'px service panel horizontal overflow');
   await context.close();
  }
  hosts=[host('service','example-service',12,34,48),{...host('monitoring','example-monitoring',55,42,53),status:'stale',cpu:null,memory:null,disk:null,last_collected_at:'2026-01-01T00:00:00Z'}];
  const {context:staleContext,page:stale}=await guardedPage(1440);
  await stale.goto(base+'/#view=dashboard');await stale.locator('.host-overview-card').nth(1).waitFor();
  assert.match(await stale.locator('.host-overview-card').nth(1).textContent(),/수집 지연/);
  assert.doesNotMatch(await stale.locator('.host-overview-card').nth(1).textContent(),/CPU 0 %/);
  hosts=[host('service','example-service',12,34,48),{...host('monitoring','example-monitoring',55,42,53),host_id:'expected:monitoring',instance:null,expected:true,status:'no_data',cpu:null,memory:null,disk:null,last_collected_at:null,history:{}}];
  await stale.reload();await stale.locator('.host-overview-card').nth(1).waitFor();
  assert.match(await stale.locator('.host-overview-card').nth(1).textContent(),/수집 대상 미설정/);
  assert.doesNotMatch(await stale.locator('.host-overview-card').nth(1).textContent(),/CPU 0 %/);
  await staleContext.close();
  assert.deepEqual(errors,[]);assert(requests.every(x=>x.startsWith('GET ')));
  console.log('PASS: 1440/390px host and direct service navigation, horizontal service buttons/keyboard/history/reload, custom range, stale/no-data; no JS error or POST; isolated loopback fixture');
 }finally{await browser.close();server.close()}
})().catch(error=>{console.error(error);server.close();process.exitCode=1});
