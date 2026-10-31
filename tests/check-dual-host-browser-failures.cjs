'use strict';
// Read-only loopback fixtures. Separate from the custom-period browser review.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/monitoring-ui.json'),'utf8')).observability;
const at=new Date().toISOString(),ms=Date.now();
let server,browser,base;
function host(role,cpu,memory,disk){
 const history=v=>({status:'ok',points:[[ms-30000,v],[ms,v]]});
 return {host_id:'fixture-'+role,instance:'fixture-'+role,server_role:role,server_name:role==='service'?'서비스 서버':'모니터링 서버',status:'ok',metadata_status:'ok',cpu,memory,disk,last_collected_at:at,history:{cpu:history(cpu),memory:history(memory),disk:history(disk)}};
}
function resources(){return {status:'ok',items:[host('service',12,34,48),host('monitoring',55,42,53)]};}
before(async()=>{
 server=http.createServer((req,res)=>{
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  const url=new URL(req.url,'http://127.0.0.1');let relative;
  try{relative=url.pathname==='/'?'static/schutz-ui/index.html':decodeURIComponent(url.pathname).slice(1);}catch{res.writeHead(400);res.end();return;}
  const file=path.resolve(root,relative);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.setHeader('content-type',({'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});
});
after(async()=>{try{if(browser)await browser.close();}finally{if(server)await new Promise(resolve=>server.close(resolve));}});
async function review(width,data,run){
 const errors=[],requests=[];
 const context=await browser.newContext({viewport:{width,height:900},locale:'ko-KR',serviceWorkers:'block'});
 context.on('page',page=>page.on('pageerror',e=>errors.push(e.message)));
 try{
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());requests.push([req.method(),url.origin,url.pathname]);
   if(url.origin!==base||req.method()!=='GET'){errors.push('blocked '+req.method()+' '+url.origin);await route.abort();return;}
   let body;
   if(['/local/status','/api/management/capabilities'].includes(url.pathname))body={mode:'live',writes_enabled:false};
   else if(url.pathname==='/api/auth/context')body={user:{username:'fixture-admin',role:'admin'},csrf_token:'fixture-only'};
   else if(url.pathname==='/api/dashboard')body={as_of:at,incident_counts:{new:0,accepted:0,in_progress:0,closed:0},servers:[]};
   else if(url.pathname==='/api/observability')body={...structuredClone(fixture),as_of:at,resources:data};
   else if(url.pathname==='/api/incidents')body={items:[],total:0,page:1,page_count:1,page_size:20,counts:{new:0,accepted:0,in_progress:0,closed:0}};
   if(body!==undefined){await route.fulfill({json:body});return;}
   if(url.pathname.startsWith('/api/')){errors.push('unhandled '+url.pathname);await route.abort();return;}
   await route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(5000);await run(page);
  assert(requests.some(r=>r[2]==='/api/observability'));assert.deepEqual(errors,[]);assert(requests.every(r=>r[0]==='GET'&&r[1]===base));
 }finally{await context.close();}
}
async function dashboard(p){await p.goto(base+'/#view=dashboard');await p.locator('.host-overview-card').nth(1).waitFor();}
async function detail(p){await p.locator('.resources .resource-detail-link').first().click();await p.locator('.resource-detail-header').waitFor();}
const current=p=>p.locator('.resource-analysis-current');
for(const width of [1440,390]){
 test(width+'px: metadata failure preserves metrics without inventing role',{timeout:20000},async()=>{
  const data=resources();data.status='partial';data.metadata_status='unavailable';Object.assign(data.items[1],{server_role:'unknown',server_name:'역할 미지정 서버',metadata_status:'unavailable'});
  await review(width,data,async p=>{await dashboard(p);const card=p.locator('.host-overview-card').nth(1);const text=await card.textContent();assert.match(text,/서버 역할 조회 실패/);assert.match(text,/역할 미지정 서버/);assert.doesNotMatch(text,/모니터링 서버/);await card.click();assert.equal(await p.locator('.resources .res-value').first().textContent(),'55 %');});
 });
 test(width+'px: CPU failure preserves memory and disk',{timeout:20000},async()=>{
  const data=resources();data.status='partial';data.items[1].cpu=null;data.items[1].history.cpu={status:'unavailable',points:[]};
  await review(width,data,async p=>{await dashboard(p);await p.locator('.host-overview-card').nth(1).click();const values=p.locator('.resources .res-value');assert.deepEqual(await values.allTextContents(),['조회 실패','42 %','53 %']);await detail(p);assert.match(await current(p).textContent(),/미확인/);assert.match(await p.locator('.resource-analysis-heading').textContent(),/조회 실패/);await p.getByRole('tab',{name:'메모리',exact:true}).click();assert.equal(await current(p).textContent(),'42 %');});
 });
 test(width+'px: unavailable status hides retained old numeric values',{timeout:20000},async()=>{
  const data=resources();data.status='unavailable';data.items[1].status='unavailable';
  await review(width,data,async p=>{await dashboard(p);const card=p.locator('.host-overview-card').nth(1);await card.click();assert.match(await card.textContent(),/조회 실패/);assert.doesNotMatch(await card.textContent(),/CPU 55 %/);assert.deepEqual(await p.locator('.resources .res-value').allTextContents(),['조회 실패','조회 실패','조회 실패']);await detail(p);assert.match(await current(p).textContent(),/미확인/);});
 });
 test(width+'px: host and keyboard tab survive Back Forward and reload',{timeout:20000},async()=>{
  await review(width,resources(),async p=>{
   await p.goto(base+'/#view=resources&host=fixture-service&resource=cpu');const select=p.getByLabel('메트릭 수집 대상');await select.waitFor();await select.selectOption('fixture-monitoring');
   const cpu=p.getByRole('tab',{name:'CPU',exact:true});await cpu.focus();await cpu.press('End');assert.match(await p.locator('.resource-analysis-heading').textContent(),/루트 디스크/);assert.equal(await current(p).textContent(),'53 %');
   await p.goBack();await p.waitForFunction(()=>new URLSearchParams(location.hash.slice(1)).get('resource')==='cpu');assert.equal(await p.getByLabel('메트릭 수집 대상').inputValue(),'fixture-monitoring');assert.equal(await current(p).textContent(),'55 %');
   await p.goBack();await p.waitForFunction(()=>new URLSearchParams(location.hash.slice(1)).get('host')==='fixture-service');assert.equal(await current(p).textContent(),'12 %');
   await p.goForward();await p.waitForFunction(()=>new URLSearchParams(location.hash.slice(1)).get('host')==='fixture-monitoring');assert.equal(await current(p).textContent(),'55 %');
   await p.goForward();await p.waitForFunction(()=>new URLSearchParams(location.hash.slice(1)).get('resource')==='disk');assert.equal(await current(p).textContent(),'53 %');
   await p.reload();await p.locator('.resource-detail-header').waitFor();assert.equal(await p.getByLabel('메트릭 수집 대상').inputValue(),'fixture-monitoring');assert.equal(await current(p).textContent(),'53 %');
   const bounds=await p.locator('.view-panel').evaluate(e=>[e.scrollWidth,e.clientWidth]);assert(bounds[0]<=bounds[1]+2,'panel horizontal overflow');
  });
 });
}
