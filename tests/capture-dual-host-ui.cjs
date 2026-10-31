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
let hosts=[host('service','example-service',12,34,48),host('monitoring','example-monitoring',55,42,53)];
const errors=[],requests=[],observationQueries=[];
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');requests.push(req.method+' '+url.pathname);
 if(req.method!=='GET'){res.statusCode=405;res.end();return}
 let data;
 if(url.pathname==='/local/status')data={mode:'live',writes_enabled:false};
 else if(url.pathname==='/api/auth/context')data={user:{username:'검수 관리자',role:'admin'},csrf_token:'fixture-only'};
 else if(url.pathname==='/api/management/capabilities')data={mode:'live',writes_enabled:false};
 else if(url.pathname==='/api/dashboard')data={as_of:at,incident_counts:{new:0,accepted:0,in_progress:0,closed:0},servers:[]};
 else if(url.pathname==='/api/observability'){observationQueries.push(url.searchParams.toString());data={...fixture,as_of:url.searchParams.get('end')||at,resources:{status:'ok',items:hosts}}}
 else if(url.pathname==='/api/incidents')data={items:[],total:0,page:1,page_size:20,page_count:1,counts:{new:0,accepted:0,in_progress:0,closed:0}};
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
   await page.locator('.host-overview-card').nth(1).click();
   assert.match(await page.locator('.resources .resource .res-value').first().textContent(),/55/);
   await page.locator('.resources .resource-detail-link').first().click();
   await page.locator('.resource-detail-header').waitFor();
   assert.match(page.url(),/host=example-monitoring/);
   assert.match(await page.locator('.resource-detail-header').textContent(),/모니터링 서버/);
   await page.reload();await page.locator('.resource-detail-header').waitFor();
   assert.match(await page.locator('.resource-detail-header').textContent(),/모니터링 서버/);
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
   await page.waitForFunction(()=>document.querySelector('.resource-detail-header')?.textContent.includes('선택 시점 메트릭 확인'));
   assert(observationQueries.some(query=>{const q=new URLSearchParams(query);return q.get('window')==='custom'&&q.get('start')===expectedStart&&q.get('end')===expectedEnd}));
   const previousQueries=observationQueries.length;
   const restoredResponse=page.waitForResponse(response=>response.url().includes('/api/observability?')&&response.status()===200);
   await page.reload();await restoredResponse;await page.locator('.resource-detail-header').waitFor();
   const restored=new URLSearchParams(page.url().split('#')[1]);
   assert.equal(restored.get('host'),'example-monitoring');
   assert.equal(restored.get('window'),'custom');
   assert.equal(restored.get('start'),expectedStart);
   assert.equal(restored.get('end'),expectedEnd);
   assert(observationQueries.slice(previousQueries).some(query=>{const q=new URLSearchParams(query);return q.get('window')==='custom'&&q.get('start')===expectedStart&&q.get('end')===expectedEnd}));
   assert.match(await page.locator('.resource-detail-header').textContent(),/모니터링 서버/);
   await context.close();
  }
  hosts=[host('service','example-service',12,34,48),{...host('monitoring','example-monitoring',55,42,53),status:'stale',cpu:null,memory:null,disk:null,last_collected_at:'2026-01-01T00:00:00Z'}];
  const {context:staleContext,page:stale}=await guardedPage(1440);
  await stale.goto(base+'/#view=dashboard');await stale.locator('.host-overview-card').nth(1).waitFor();
  assert.match(await stale.locator('.host-overview-card').nth(1).textContent(),/수집 지연/);
  assert.doesNotMatch(await stale.locator('.host-overview-card').nth(1).textContent(),/CPU 0 %/);
  hosts=[host('service','example-service',12,34,48),{...host('monitoring','example-monitoring',55,42,53),host_id:'expected:monitoring',instance:null,status:'no_data',cpu:null,memory:null,disk:null,last_collected_at:null,history:{}}];
  await stale.reload();await stale.locator('.host-overview-card').nth(1).waitFor();
  assert.match(await stale.locator('.host-overview-card').nth(1).textContent(),/수집 대상 미설정/);
  assert.doesNotMatch(await stale.locator('.host-overview-card').nth(1).textContent(),/CPU 0 %/);
  await staleContext.close();
  assert.deepEqual(errors,[]);assert(requests.every(x=>x.startsWith('GET ')));
  console.log('PASS: 1440/390px selection, detail URL/reload, custom range URL/API/reload, stale/no-data, no JS error or POST; isolated loopback fixture');
 }finally{await browser.close();server.close()}
})().catch(error=>{console.error(error);server.close();process.exitCode=1});
