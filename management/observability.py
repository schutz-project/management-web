"""Fixed, admin-only observability queries with bounded safe output and cache."""
import asyncio,json,math,re,time
from datetime import datetime,timezone
import httpx
from management.host_inventory import host_inventory

WINDOWS={'15m':(900,30),'1h':(3600,30),'6h':(21600,120),'24h':(86400,300)}
MAX_POINTS=300
NODE_SOURCE_QUERY='max by (instance) (timestamp(node_memory_MemTotal_bytes{job="ec2-node"}))'

# Return the status and its original sample time in one Prometheus evaluation.
SCRAPE_TARGET_QUERY='up or label_replace(timestamp(up), "schutz_sample_kind", "timestamp", "job", ".*")'

def source_time(value):
    """Value of timestamp(metric), not instant-vector evaluation time [0]."""
    stamp=number(value)
    try:
        return stamp,datetime.fromtimestamp(stamp,timezone.utc).isoformat() if stamp is not None else None
    except (ValueError,OverflowError,OSError):
        return None,None


CUSTOM_MAX_SECONDS=365*86400
KST_OFFSET_SECONDS=9*3600

def custom_bounds(start,end,now=None):
    try:
        a=datetime.fromisoformat(start.replace('Z','+00:00'))
        b=datetime.fromisoformat(end.replace('Z','+00:00'))
        if a.tzinfo is None or b.tzinfo is None: raise ValueError()
        a,b=a.timestamp(),b.timestamp()
    except (ValueError,TypeError,AttributeError,OverflowError):
        raise ValueError('INVALID_RANGE') from None
    current=time.time() if now is None else now
    kst_day_start=math.floor((current+KST_OFFSET_SECONDS)/86400)*86400-KST_OFFSET_SECONDS
    earliest=kst_day_start-CUSTOM_MAX_SECONDS
    if not (math.isfinite(a) and math.isfinite(b) and 60<=b-a<=CUSTOM_MAX_SECONDS and a>=earliest and b<=current+5):
        raise ValueError('INVALID_RANGE')
    step=max(30,math.ceil((b-a)/(MAX_POINTS-1)))
    return a,b,step

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
PUBLIC_METRIC_SOURCES = {}
for service_key in ('homepage', 'community'):
    service_selector = '{service="schutz-' + service_key + '"}'
    counter = 'schutz_service_http_requests_total'
    requests = 'sum(rate(' + counter + service_selector + '[2m]))'
    errors = 'sum(rate(' + counter + service_selector[:-1] + ',status_class="5xx"}[2m]))'
    METRICS.update({
        service_key+'_requests': requests,
        service_key+'_errors': errors,
        service_key+'_ms': '1000 * histogram_quantile(0.95,sum by (le) (rate(schutz_service_http_duration_seconds_bucket'+service_selector+'[5m])))',
    })
    PUBLIC_METRIC_SOURCES[service_key] = 'max(timestamp('+counter+service_selector+'))'

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
VISIBLE_JOBS={'prometheus','portal-otel','portal-health','portal-db-health','ec2-node','homepage-health','homepage-organization','community-health','community-questions','homepage-request-metrics','community-request-metrics'}
RESOURCE={
 'cpu':'100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{job="ec2-node",mode="idle"}[5m])))',
 'memory':'100 * (1 - node_memory_MemAvailable_bytes{job="ec2-node"} / node_memory_MemTotal_bytes{job="ec2-node"})',
 'disk':'max by (instance) (100 * (1 - node_filesystem_avail_bytes{job="ec2-node",mountpoint="/",fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes{job="ec2-node",mountpoint="/",fstype!~"tmpfs|overlay"}))',
}
FIELDS={'timestamp','occurred_at','request_id','trace_id','span_id','event_type','route','method','status','status_code','duration_ms','db_duration_ms','request_time','upstream_response_time','upstream_status','reason_code','synthetic','test_run_id'}
ROUTES={'other','/','/health','/proxy-health','/internal/check/employee','/api/auth/context','/api/auth/login','/api/auth/logout','/api/employees','/api/notices','/api/posts','/api/posts/{post_id}','/api/dashboard','/api/observability','/api/incidents','/api/incidents/{id}','/api/incidents/{id}/accept','/api/incidents/{id}/actions','/api/incidents/{id}/close'}
PUBLIC_LOG_ROUTES = {
    'schutz-homepage': {'/', '/health', '/api/organization'},
    'schutz-community': {'/', '/health', '/api/guides', '/api/questions'},
}
LOG_SERVICES = ('portal-api', 'portal-nginx', *PUBLIC_LOG_ROUTES)
UVICORN_ACCESS = re.compile(
    r'INFO:\s+\S+\s+- "(?P<method>[A-Z]+) (?P<target>/[^\s"]*) '
    r'HTTP/\d(?:\.\d)?" (?P<status>[1-5]\d{2})(?:\s[^\r\n]*)?'
)

def public_access_log(service, raw):
    if raw.startswith('{'):
        try: row=json.loads(raw)
        except ValueError: return None
        if not isinstance(row,dict) or row.get('event_type')!='http_request':
            return None
        status=row.get('status_code')
        if type(status) is not int or not 100<=status<=599:
            return None
        route=row.get('route')
        allowed=PUBLIC_LOG_ROUTES[service]
        if service=='schutz-community':
            route={'/api/guides/{guide_id}':'/api/guides/{id}','/api/questions/{question_id}':'/api/questions/{id}'}.get(route,route) if isinstance(route,str) else route
        if not isinstance(route,str) or (route not in allowed and route not in {p+'/{id}' for p in allowed}):
            route='other'
        result={'route':route,'status_code':status,'synthetic':row.get('synthetic') is True}
        elapsed=number(row.get('duration_ms'))
        if elapsed is not None and elapsed>=0: result['duration_ms']=elapsed
        method=row.get('method')
        if isinstance(method,str) and re.fullmatch(r'[A-Z]{1,10}',method): result['method']=method
        return result
    match = UVICORN_ACCESS.fullmatch(raw.rstrip('\r\n'))
    if not match:
        return None
    path = match['target'].partition('?')[0]
    routes = PUBLIC_LOG_ROUTES[service]
    parent, _, item = path.rpartition('/')
    if service == 'schutz-community' and parent in {'/api/guides', '/api/questions'} and item:
        path = parent + '/{id}'
    elif path not in routes:
        path = 'other'
    return {'method': match['method'], 'route': path, 'status_code': int(match['status'])}

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

    async def snapshot(self,window='15m',start=None,end=None):
        bounds=custom_bounds(start,end) if window=='custom' else None
        if window not in WINDOWS and window!='custom': raise ValueError('INVALID_WINDOW')
        if window!='custom' and (start is not None or end is not None): raise ValueError('INVALID_RANGE')
        async with self.lock:
            cached=self.cache.get(window)
            if cached and time.monotonic()-cached[0]<15 and (window!='custom' or cached[2]==bounds[:2]): return cached[1]
            async with httpx.AsyncClient(timeout=3,trust_env=False) as client:
                result=await self.collect(client,window=window,start=start,end=end) if window=='custom' else await self.collect(client,window=window)
            self.cache[window]=(time.monotonic(),result,bounds[:2] if bounds else None)
            return result

    async def collect(self,client,end=None,window='15m',start=None):
        if window=='custom':
            start,end,step=custom_bounds(start,end)
            seconds=end-start
        else:
            if window not in WINDOWS: raise ValueError('INVALID_WINDOW')
            seconds,step=WINDOWS[window]
            end=time.time() if end is None else end
            start=end-seconds
        live_end=time.time() if window=='custom' else end
        async def prom(expr,range_query=False,current=False):
            params={'query':expr,'start':start,'end':end,'step':step} if range_query else {'query':expr,'time':live_end if current else end}
            async with asyncio.timeout(4):
                response=await client.get(self.settings.prometheus_url.rstrip('/')+'/api/v1/'+('query_range' if range_query else 'query'),params=params)
                response.raise_for_status(); data=response.json()
                if data.get('status')!='success': raise ValueError('QUERY_FAILED')
                return data['data']['result']
        async def scrape_metadata():
            async with asyncio.timeout(4):
                response=await client.get(self.settings.prometheus_url.rstrip('/')+'/api/v1/targets',params={'state':'active'})
                response.raise_for_status()
                data=response.json()
                if data.get('status')!='success': raise ValueError('QUERY_FAILED')
                return data['data']['activeTargets']

        async def logs(service):
            async with asyncio.timeout(4):
                response=await client.get(self.settings.loki_url.rstrip('/')+'/loki/api/v1/query_range',params={'query':'{service="'+service+'"}','start':int((live_end-300)*1e9),'end':int(live_end*1e9),'limit':20,'direction':'backward'})
                response.raise_for_status();data=response.json()
                if data.get('status')!='success': raise ValueError('QUERY_FAILED')
                rows=[]
                for stream in data['data']['result']:
                    for stamp,raw in stream['values']:
                        safe=public_access_log(service,raw) if service in PUBLIC_LOG_ROUTES else safe_log(raw)
                        if safe is not None: rows.append({'collected_at':datetime.fromtimestamp(int(stamp)/1e9,timezone.utc).isoformat(),'fields':safe})
                rows.sort(key=lambda row:row['collected_at'],reverse=True)
                return rows[:20]
        async def loki_metric(expr):
            async with asyncio.timeout(4):
                response=await client.get(self.settings.loki_url.rstrip('/')+'/loki/api/v1/query_range',params={'query':expr,'start':start,'end':end,'step':step,'direction':'forward','limit':1000})
                response.raise_for_status();data=response.json()
                if data.get('status')!='success': raise ValueError('QUERY_FAILED')
                return data['data']['result']
        tasks={'source':prom('max(timestamp(portal_http_requests{job="portal-otel"}))'),'node_source':prom(NODE_SOURCE_QUERY)}
        tasks.update({key+'_source':prom(expr) for key,expr in PUBLIC_METRIC_SOURCES.items()})
        tasks.update({key:prom(expr,True) for key,expr in METRICS.items()});tasks.update({key:prom(expr) for key,expr in RESOURCE.items()})
        tasks.update({'history_'+key:prom(expr,True) for key,expr in RESOURCE.items()})
        tasks.update({service:logs(service) for service in LOG_SERVICES})
        tasks.update({'detail_'+key:prom(expr,True) for key,expr in DETAIL_PROM.items()})
        tasks.update({'detail_'+key:loki_metric(expr) for key,expr in DETAIL_LOKI.items()})
        tasks['firing_alerts']=prom('ALERTS{alertstate="firing"}',current=True)
        tasks['scrape_targets']=prom(SCRAPE_TARGET_QUERY,current=True)
        tasks['scrape_metadata']=scrape_metadata()
        probe = 'probe_success{job=~"homepage-health|homepage-organization|community-health|community-questions"}'
        tasks['service_probes']=prom(probe,current=True)
        tasks['service_probe_times']=prom('timestamp('+probe+')',current=True)
        results=await asyncio.gather(*tasks.values(),return_exceptions=True); data=dict(zip(tasks,results))
        def fresh(stamp):
            value=number(stamp);return value is not None and -5<=end-value<=60
        metrics={}
        for key in METRICS:
            service_key=key.partition('_')[0]
            source=data[service_key+'_source'] if service_key in PUBLIC_METRIC_SOURCES else data['source']
            source_ok=not isinstance(source,Exception)
            source_stamp=source[0]['value'][1] if source_ok and source else None
            source_fresh=fresh(source_stamp)
            result=data[key];status='unavailable' if isinstance(result,Exception) or not source_ok else 'stale' if source_stamp is not None and not source_fresh else 'no_data'
            points=[]; value=None
            if not isinstance(result,Exception) and result:
                points=[[float(t)*1000,number(v)] for t,v in result[0].get('values',[])][-MAX_POINTS:]
                if source_fresh and points and points[-1][0]/1000>=end-max(60,step):
                    value=points[-1][1]
                if value is not None: status='ok'
            metrics[key]={'status':status,'value':value,'points':points,'summary':point_summary(points)}
        nodes={};source=data['node_source']
        if not isinstance(source,Exception):
            for row in source:
                instance=row['metric'].get('instance','unknown')[:120];stamp,collected_at=source_time(row['value'][1]);nodes[instance]={'instance':instance,'status':'ok' if fresh(stamp) else 'stale','last_collected_at':collected_at,'cpu':None,'memory':None,'disk':None}
        for key in RESOURCE:
            if not isinstance(data[key],Exception):
                for row in data[key]:
                    instance=row['metric'].get('instance','unknown')[:120]
                    if instance in nodes and nodes[instance]['status']=='ok': nodes[instance][key]=number(row['value'][1])
        for instance,host in nodes.items():
            history={}
            for key in RESOURCE:
                rows=data['history_'+key]
                points=[]
                status='unavailable' if isinstance(rows,Exception) else 'no_data'
                if not isinstance(rows,Exception):
                    matching=[row for row in rows if row['metric'].get('instance')==instance]
                    if matching:
                        points=[[float(t)*1000,number(v)] for t,v in matching[0].get('values',[])][-MAX_POINTS:]
                        if any(v is not None for _,v in points):
                            status='ok' if host['status']=='ok' else 'stale'
                if isinstance(data[key],Exception): status='unavailable'
                elif host['status']=='ok' and host[key] is None: status='no_data'
                history[key]={'status':status,'points':points,'value':host[key],'summary':point_summary(points)}
            host['history']=history
        resource_status='unavailable' if isinstance(source,Exception) else 'ok' if nodes else 'no_data'
        metadata_status='unavailable' if isinstance(data['scrape_targets'],Exception) else 'ok'
        metric_status={key:'unavailable' if isinstance(data[key],Exception) else 'ok' if data[key] else 'no_data' for key in RESOURCE}
        if resource_status!='unavailable' and (metadata_status!='ok' or (nodes and any(v!='ok' for v in metric_status.values()))):
            resource_status='partial'
        targets=data['scrape_targets']
        sample_times={}
        if not isinstance(targets,Exception):
            status_rows=[]
            for row in targets:
                labels=row.get('metric',{})
                if labels.get('schutz_sample_kind')=='timestamp':
                    key=(labels.get('job'),labels.get('instance'))
                    sample_times[key]=number(row['value'][1]) if key not in sample_times else None
                else:
                    status_rows.append(row)
            targets=status_rows
        hosts=host_inventory(nodes,targets,isinstance(source,Exception))
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
                if points and points[-1][0]/1000 >= end-max(60,step):
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
        def probe_values(rows):
            values={}
            if isinstance(rows,list):
                for row in rows:
                    job=row['metric'].get('job')
                    values[job]=number(row['value'][1]) if job not in values else None
            return values

        probe_states=probe_values(data['service_probes'])
        probes={}
        for job,stamp in probe_values(data['service_probe_times']).items():
            value=probe_states.get(job)
            if value in (0,1) and stamp is not None and -5<=live_end-stamp<=60:
                probes[job]={'success':value==1,'checked_at':datetime.fromtimestamp(stamp,timezone.utc).isoformat()}
        target_rows=[]
        metadata={}
        if isinstance(data['scrape_metadata'],list):
            for target in data['scrape_metadata']:
                labels=target.get('labels',{})
                key=(labels.get('job'),labels.get('instance'))
                metadata[key]=target if key not in metadata else None
        if not isinstance(targets,Exception):
            for row in targets[:30]:
                labels=row.get('metric',{})
                job=labels.get('job','')
                if job not in VISIBLE_JOBS: continue
                instance=labels.get('instance','')
                up=number(row['value'][1])==1
                result={'job':job,'instance':instance[:120],'up':up}
                key=(job,instance)
                detail=metadata.get(key)
                sample_at=sample_times.get(key)
                if detail and sample_at is not None and detail.get('health')==('up' if up else 'down'):
                    try:
                        at=datetime.fromisoformat(detail['lastScrape'])
                        if at.tzinfo and at.year>1970:
                            # Prometheus stores sample times at millisecond precision.
                            scrape_at=at.replace(microsecond=at.microsecond//1000*1000)
                            if scrape_at.timestamp()==sample_at:
                                result['last_scrape_at']=at.isoformat()
                    except (KeyError, TypeError, ValueError, OverflowError, OSError):
                        pass
                    if not up and 'last_scrape_at' in result:
                        error=str(detail.get('lastError','')).lower()
                        if 'timeout' in error or 'deadline exceeded' in error:
                            result['failure_reason']='연결 시간 초과'
                        elif 'connection refused' in error:
                            result['failure_reason']='연결 거부'
                        elif match:=re.search(r'http status (\d{3})\b',error):
                            result['failure_reason']='HTTP '+match[1]
                target_rows.append(result)
        return {'as_of':datetime.fromtimestamp(end,timezone.utc).isoformat(),'current_as_of':datetime.fromtimestamp(live_end,timezone.utc).isoformat(),'historical':window=='custom','window_minutes':seconds//60,'window':window,'step_seconds':step,'range_start':datetime.fromtimestamp(start,timezone.utc).isoformat(),'metrics':metrics,'service_probes':probes,'details':details,'alerts':{'status':'unavailable' if isinstance(alerts,Exception) else 'ok','items':alert_rows},'targets':{'status':'unavailable' if isinstance(targets,Exception) else 'ok','items':target_rows},'resources':{'status':resource_status,'source_status':'unavailable' if isinstance(source,Exception) else 'ok' if nodes else 'no_data','metadata_status':metadata_status,'metric_status':metric_status,'items':hosts},'logs':{service:{'status':'unavailable' if isinstance(data[service],Exception) else 'ok','items':[] if isinstance(data[service],Exception) else data[service]} for service in LOG_SERVICES}}
