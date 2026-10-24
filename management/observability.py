"""Fixed, admin-only observability queries with bounded safe output and cache."""
import asyncio,json,math,re,time
from datetime import datetime,timezone
import httpx

WINDOWS={'15m':(900,30),'1h':(3600,30),'6h':(21600,120),'24h':(86400,300)}
MAX_POINTS=300

def point_summary(points):
    values=[v for _,v in points if v is not None]
    return {'mean':sum(values)/len(values),'max':max(values),'samples':len(values)} if values else {'mean':None,'max':None,'samples':0}

REQUESTS='sum(rate(portal_http_requests{job="portal-otel"}[2m]))'
METRICS={
 'requests':REQUESTS,
 'errors':'(sum(rate(portal_http_requests{job="portal-otel",http_response_status_code=~"5.."}[2m])) or vector(0)) and on() '+REQUESTS,
 'app_ms':'histogram_quantile(0.95,sum by (le) (rate(portal_http_duration_bucket{job="portal-otel"}[5m])))',
 'db_ms':'histogram_quantile(0.95,sum by (le) (rate(portal_db_duration_bucket{job="portal-otel"}[5m])))',
}
# These fixed queries preserve the operational panels used before Grafana retirement.
DETAIL_PROM={
 'app_routes':'sum by (http_route) (rate(portal_http_requests{job="portal-otel"}[2m]))',
 'app_p95_routes':'histogram_quantile(0.95,sum by (le,http_route) (rate(portal_http_duration_bucket{job="portal-otel"}[5m])))',
}
DETAIL_LOKI={
 'proxy_requests':'sum by (route) (rate({service="portal-nginx"} | json | __error__="" [5m]))',
 'proxy_errors':'sum by (route) (rate({service="portal-nginx"} | json | status >= 500 | status <= 599 | __error__="" [5m]))',
 'proxy_p95':'quantile_over_time(0.95,{service="portal-nginx"} | json | unwrap request_time | __error__="" [5m]) by (route)',
 'upstream_p95':'quantile_over_time(0.95,{service="portal-nginx"} | json | unwrap upstream_response_time | __error__="" [5m]) by (route)',
}
VISIBLE_JOBS={'prometheus','portal-otel','blackbox-exporter','portal-health','portal-db-health','ec2-node'}
RESOURCE={
 'cpu':'100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{job="ec2-node",mode="idle"}[5m])))',
 'memory':'100 * (1 - node_memory_MemAvailable_bytes{job="ec2-node"} / node_memory_MemTotal_bytes{job="ec2-node"})',
 'disk':'max by (instance) (100 * (1 - node_filesystem_avail_bytes{job="ec2-node",mountpoint="/",fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes{job="ec2-node",mountpoint="/",fstype!~"tmpfs|overlay"}))',
}
FIELDS={'timestamp','occurred_at','request_id','trace_id','span_id','event_type','route','method','status','status_code','duration_ms','db_duration_ms','request_time','upstream_response_time','upstream_status','reason_code','synthetic','test_run_id'}
ROUTES={'other','/','/health','/proxy-health','/internal/check/employee','/api/auth/context','/api/auth/login','/api/auth/logout','/api/employees','/api/notices','/api/posts','/api/posts/{post_id}','/api/dashboard','/api/observability','/api/incidents','/api/incidents/{id}','/api/incidents/{id}/accept','/api/incidents/{id}/actions','/api/incidents/{id}/close'}
def number(value):
    try: result=float(value)
    except (ValueError,TypeError,OverflowError): return None
    return result if math.isfinite(result) else None

def safe_log(raw):
    try: row=json.loads(raw)
    except (ValueError,TypeError): return None
    if not isinstance(row,dict): return None
    result={k:(v[:160] if isinstance(v,str) else v) for k,v in row.items() if k in FIELDS and (v is None or type(v) in (str,int,float,bool))}
    for key in ['request_id','trace_id','span_id']:
        if key in result and (not isinstance(result[key],str) or not re.fullmatch(r'[a-fA-F0-9-]{16,40}',result[key])): result.pop(key)
    if result.get('route') not in ROUTES: result['route']='other'
    for key,value in list(result.items()):
        if type(value) is float and not math.isfinite(value): result.pop(key)
    return result

class Observer:
    def __init__(self,settings):
        self.settings=settings;self.cache={};self.lock=asyncio.Lock()

    async def snapshot(self,window='15m'):
        if window not in WINDOWS: raise ValueError('INVALID_WINDOW')
        async with self.lock:
            cached=self.cache.get(window)
            if cached and time.monotonic()-cached[0]<15: return cached[1]
            async with httpx.AsyncClient(timeout=3,trust_env=False) as client:
                result=await self.collect(client,window=window)
            self.cache[window]=(time.monotonic(),result)
            return result

    async def collect(self,client,end=None,window='15m'):
        if window not in WINDOWS: raise ValueError('INVALID_WINDOW')
        seconds,step=WINDOWS[window]
        end=time.time() if end is None else end
        start=end-seconds
        async def prom(expr,range_query=False):
            params={'query':expr,'start':start,'end':end,'step':step} if range_query else {'query':expr,'time':end}
            async with asyncio.timeout(4):
                response=await client.get(self.settings.prometheus_url.rstrip('/')+'/api/v1/'+('query_range' if range_query else 'query'),params=params)
                response.raise_for_status(); data=response.json()
                if data.get('status')!='success': raise ValueError('QUERY_FAILED')
                return data['data']['result']
        async def logs(service):
            async with asyncio.timeout(4):
                response=await client.get(self.settings.loki_url.rstrip('/')+'/loki/api/v1/query_range',params={'query':'{service="'+service+'"}','start':int((end-300)*1e9),'end':int(end*1e9),'limit':20,'direction':'backward'})
                response.raise_for_status();data=response.json()
                if data.get('status')!='success': raise ValueError('QUERY_FAILED')
                rows=[]
                for stream in data['data']['result']:
                    for stamp,raw in stream['values']:
                        safe=safe_log(raw)
                        if safe is not None: rows.append({'collected_at':datetime.fromtimestamp(int(stamp)/1e9,timezone.utc).isoformat(),'fields':safe})
                rows.sort(key=lambda row:row['collected_at'],reverse=True)
                return rows[:20]
        async def loki_metric(expr):
            async with asyncio.timeout(4):
                response=await client.get(self.settings.loki_url.rstrip('/')+'/loki/api/v1/query_range',params={'query':expr,'start':start,'end':end,'step':step,'direction':'forward','limit':1000})
                response.raise_for_status();data=response.json()
                if data.get('status')!='success': raise ValueError('QUERY_FAILED')
                return data['data']['result']
        tasks={'source':prom('max(timestamp(portal_http_requests{job="portal-otel"}))'),'node_source':prom('max by (instance) (timestamp(node_memory_MemTotal_bytes{job="ec2-node"}))')}
        tasks.update({key:prom(expr,True) for key,expr in METRICS.items()});tasks.update({key:prom(expr) for key,expr in RESOURCE.items()})
        tasks.update({'history_'+key:prom(expr,True) for key,expr in RESOURCE.items()})
        tasks.update({service:logs(service) for service in ['portal-api','portal-nginx']})
        tasks.update({'detail_'+key:prom(expr,True) for key,expr in DETAIL_PROM.items()})
        tasks.update({'detail_'+key:loki_metric(expr) for key,expr in DETAIL_LOKI.items()})
        tasks['firing_alerts']=prom('ALERTS{alertstate="firing"}')
        tasks['scrape_targets']=prom('up')
        results=await asyncio.gather(*tasks.values(),return_exceptions=True); data=dict(zip(tasks,results))
        def fresh(stamp):
            value=number(stamp);return value is not None and -5<=end-value<=60
        source=data['source'];source_ok=not isinstance(source,Exception)
        source_stamp=source[0]['value'][1] if source_ok and source else None
        source_fresh=fresh(source_stamp)
        metrics={}
        for key in METRICS:
            result=data[key];status='unavailable' if isinstance(result,Exception) or not source_ok else 'stale' if source_stamp is not None and not source_fresh else 'no_data'
            points=[]; value=None
            if not isinstance(result,Exception) and result:
                points=[[float(t)*1000,number(v)] for t,v in result[0].get('values',[])][-MAX_POINTS:]
                if source_fresh and points and points[-1][0]/1000>=end-60:
                    value=points[-1][1]
                if value is not None: status='ok'
            metrics[key]={'status':status,'value':value,'points':points,'summary':point_summary(points)}
        nodes={};source=data['node_source']
        if not isinstance(source,Exception):
            for row in source[:20]:
                instance=row['metric'].get('instance','unknown')[:120];nodes[instance]={'instance':instance,'status':'ok' if fresh(row['value'][1]) else 'stale','cpu':None,'memory':None,'disk':None}
        for key in RESOURCE:
            if not isinstance(data[key],Exception):
                for row in data[key][:20]:
                    instance=row['metric'].get('instance','unknown')[:120]
                    if instance in nodes and nodes[instance]['status']=='ok': nodes[instance][key]=number(row['value'][1])
        for instance,host in nodes.items():
            history={}
            for key in RESOURCE:
                rows=data['history_'+key]
                points=[]
                status='unavailable' if isinstance(rows,Exception) else 'no_data'
                if not isinstance(rows,Exception):
                    matching=[row for row in rows[:20] if row['metric'].get('instance')==instance]
                    if matching:
                        points=[[float(t)*1000,number(v)] for t,v in matching[0].get('values',[])][-MAX_POINTS:]
                        if any(v is not None for _,v in points):
                            status='ok' if host['status']=='ok' else 'stale'
                history[key]={'status':status,'points':points,'value':host[key],'summary':point_summary(points)}
            host['history']=history
        resource_status='unavailable' if isinstance(source,Exception) else 'ok' if nodes else 'no_data'
        def series(key,label):
            rows=data['detail_'+key]
            if isinstance(rows,Exception): return {'status':'unavailable','items':[]}
            items=[]
            for row in rows[:30]:
                metric=row.get('metric',{})
                route=metric.get(label,'')
                if route not in ROUTES: route='other'
                points=[]
                for stamp,value in row.get('values',[])[-MAX_POINTS:]:
                    points.append([float(stamp)*1000,number(value)])
                if points and points[-1][0]/1000 >= end-60:
                    items.append({'route':route,'value':points[-1][1],'points':points})
            items.sort(key=lambda item:(item['route'], item['value'] is None))
            return {'status':'ok','items':items[:12]}
        details={key:series(key,'http_route' if key in DETAIL_PROM else 'route') for key in (*DETAIL_PROM,*DETAIL_LOKI)}
        alerts=data['firing_alerts'];alert_rows=[]
        if not isinstance(alerts,Exception):
            for row in alerts[:20]:
                labels=row.get('metric',{})
                if labels.get('alertstate')!='firing': continue
                name=labels.get('alertname','')
                if not re.fullmatch(r'[A-Za-z0-9_]{1,80}',name): continue
                alert_rows.append({'name':name,'severity':labels.get('severity','')[:30]})
        targets=data['scrape_targets'];target_rows=[]
        if not isinstance(targets,Exception):
            for row in targets[:30]:
                labels=row.get('metric',{})
                job=labels.get('job','')
                if job not in VISIBLE_JOBS: continue
                target_rows.append({'job':job,'instance':labels.get('instance','')[:120],'up':number(row['value'][1])==1})
        return {'as_of':datetime.fromtimestamp(end,timezone.utc).isoformat(),'window_minutes':seconds//60,'window':window,'step_seconds':step,'range_start':datetime.fromtimestamp(start,timezone.utc).isoformat(),'metrics':metrics,'details':details,'alerts':{'status':'unavailable' if isinstance(alerts,Exception) else 'ok','items':alert_rows},'targets':{'status':'unavailable' if isinstance(targets,Exception) else 'ok','items':target_rows},'resources':{'status':resource_status,'items':list(nodes.values())},'logs':{service:{'status':'unavailable' if isinstance(data[service],Exception) else 'ok','items':[] if isinstance(data[service],Exception) else data[service]} for service in ['portal-api','portal-nginx']}}

