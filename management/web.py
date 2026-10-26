import json
from fastapi import Request
from fastapi.responses import FileResponse
from sqlalchemy import select,func
from portal.main import create_app as portal_app, ApiError, invalid, ROOT
from portal.models import now
from management.models import Target, Incident, Evidence, IncidentEvidence, Action, Job, Attempt, PrometheusAlertState
from management.domain import utc, closure_reasons, change, target

def stamp(v): return utc(v).isoformat().replace('+00:00','Z') if v else None
def create_app(settings=None,engine=None,metric_readers=None,observer=None):
    app=portal_app(settings,engine,metric_readers)
    app.title='Schutz 사건 관리'
    # The management service has its own DB; do not expose portal business routes.
    removed={'/','/api/employees','/internal/check/employee','/api/notices','/api/posts','/api/posts/{post_id}'}
    app.router.routes[:]=[r for r in app.router.routes if getattr(r,'path',None) not in removed]
    factory=app.state.sessions
    from management.observability import Observer
    from management.config import WorkerSettings
    app.state.observer=observer or Observer(WorkerSettings(database_url=app.state.settings.database_url))
    def admin(request,db,write=False):
        session,user,_=app.state.authenticate(request,db,lock=write)
        if user.role!='admin': raise ApiError(403,'FORBIDDEN','관리자 계정이 필요합니다.')
        if write and not app.state.settings.management_actions_enabled:
            raise ApiError(403,'ACTIONS_DISABLED','현재 사건 처리가 비활성화되어 있습니다.')
        if write: app.state.csrf(request,session.csrf_token_hash)
        return user
    def body(request):
        if request.headers.get('content-type','').split(';')[0]!='application/json': invalid('body')
        try: data=json.loads(request.state.raw_body)
        except (ValueError,UnicodeError): invalid('body')
        if not isinstance(data,dict): invalid('body')
        return data
    def text(data,key):
        value=data.get(key)
        if not isinstance(value,str) or not 1<=len(value.strip())<=1000: invalid(key)
        return value.strip()
    def load(db,id):
        row=db.get(Incident,id)
        if row is None: raise ApiError(404,'INCIDENT_NOT_FOUND','사건을 찾을 수 없습니다.')
        # Consistent target -> incident lock order with the detector.
        from management.alert_policy import RULE_IDS
        if row.rule_id in RULE_IDS:
            db.scalar(select(PrometheusAlertState).where(PrometheusAlertState.target_key==row.target_id).with_for_update())
        else: target(db,row.target_id)
        return db.scalar(select(Incident).where(Incident.id==id).with_for_update())
    def monitor_info(db,row):
        from management.alert_policy import RULE_IDS,recovery_ready
        if row.rule_id not in RULE_IDS: return None
        state=db.scalar(select(PrometheusAlertState).where(PrometheusAlertState.target_key==row.target_id))
        if state is None: return {'source':'prometheus','state':'unknown','recovery_confirmed':False}
        same=state.incident_id==row.id
        fresh=bool(state.evaluated_at and -5<=(now()-utc(state.evaluated_at)).total_seconds()<=60)
        return {'source':'prometheus','alert_name':state.rule_name,'labels':state.labels,'state':state.state if same and fresh else 'unknown','last_evaluated_at':stamp(state.evaluated_at) if same else None,'recovery_confirmed':same and recovery_ready(db,row,now()),'target_display':state.rule_name+' / '+state.labels.get('job','portal')+' / '+state.labels.get('instance','전체')}
    def item(row,db=None):
        info=monitor_info(db,row) if db is not None else None
        result={**{k:getattr(row,k) for k in ['id','target_id','rule_id','status','synthetic','test_run_id','accepted_by','closed_by','resolution','version']},'detected_at':stamp(row.detected_at),'accepted_at':stamp(row.accepted_at),'closed_at':stamp(row.closed_at)}
        if info: result.update(monitoring=info,target_display=info.get('target_display','Prometheus 경보'))
        return result
    @app.get('/')
    @app.get('/incidents/{path_id}')
    def index(path_id:str=''): return FileResponse(ROOT/'static/schutz-ui/index.html')
    @app.get('/api/management/capabilities')
    def capabilities(request:Request):
        with factory.begin() as db:
            admin(request,db)
            return {'mode':'live','writes_enabled':app.state.settings.management_actions_enabled}
    @app.get('/api/dashboard')
    def dashboard(request:Request):
        with factory.begin() as db:
            admin(request,db); servers=[]; current=now()
            for row in db.scalars(select(Target).where(Target.id.in_(['proxy','app','database','portal-login'])).order_by(Target.id)):
                checked=row.log_collection_at if row.id=='portal-login' else row.collection_at
                stale=not checked or (current-utc(checked)).total_seconds()>60
                status='unknown' if stale else ('normal' if row.id=='portal-login' or row.last_ok and row.duration_ms<=2000 else 'abnormal')
                servers.append({'target_id':row.id,'status':status,'last_checked_at':stamp(checked),'collection_delayed':stale,'duration_ms':row.duration_ms})
            counts={k:db.scalar(select(func.count()).select_from(Incident).where(Incident.status==k)) for k in ['new','accepted','in_progress','closed']}
            return {'as_of':stamp(current),'servers':servers,'incident_counts':counts}
    @app.get('/api/observability')
    async def observability(request:Request,window:str='15m',start:str|None=None,end:str|None=None):
        with factory.begin() as db: admin(request,db)
        from management.observability import WINDOWS, custom_bounds
        if window=='custom':
            try:
                custom_bounds(start,end)
                return await app.state.observer.snapshot(window=window,start=start,end=end)
            except ValueError: invalid('range')
        if window not in WINDOWS: invalid('window')
        if start is not None or end is not None: invalid('range')
        return await app.state.observer.snapshot(window=window)
    @app.get('/api/incidents')
    def incidents(request:Request,status:str='open',page:int=1):
        if status not in ['open','closed'] or not 1<=page<=100000: invalid('query')
        with factory.begin() as db:
            admin(request,db)
            conditions=Incident.status=='closed' if status=='closed' else Incident.status!='closed'
            rows=db.scalars(select(Incident).where(conditions).order_by(Incident.detected_at.desc(),Incident.id).offset((page-1)*20).limit(20)).all()
            return {'items':[item(r,db) for r in rows],'total':db.scalar(select(func.count()).select_from(Incident).where(conditions)),'page':page,'page_size':20}
    @app.get('/api/incidents/{id}')
    def detail(id:str,request:Request):
        with factory.begin() as db:
            admin(request,db); row=load(db,id)
            evidence=db.scalars(select(Evidence).join(IncidentEvidence,IncidentEvidence.evidence_id==Evidence.id).where(IncidentEvidence.incident_id==id).order_by(Evidence.occurred_at.desc()).limit(100)).all()
            jobs=[]
            for job in db.scalars(select(Job).where(Job.incident_id==id).order_by(Job.kind)):
                attempts=db.scalars(select(Attempt).where(Attempt.job_id==job.id).order_by(Attempt.number)).all()
                jobs.append({'kind':job.kind,'status':job.status,'mode':job.mode,'attempts':job.attempts,'model':job.model,'prompt_version':job.prompt_version,'result':job.result,'error_code':job.error_code,'input_evidence':job.input_evidence,'history':[{'number':a.number,'outcome':a.outcome,'error_code':a.error_code,'started_at':stamp(a.started_at),'finished_at':stamp(a.finished_at)} for a in attempts]})
            actions=db.scalars(select(Action).where(Action.incident_id==id).order_by(Action.created_at,Action.id)).all()
            reasons=closure_reasons(db,row,test_stopped=True) if row.status!='closed' else []
            return {**item(row,db),'evidence':[{'id':e.id,'kind':e.kind,'occurred_at':stamp(e.occurred_at),'payload':e.payload} for e in evidence],'jobs':jobs,'actions':[{'id':a.id,'kind':a.kind,'content':a.content,'actor_id':a.actor_id,'created_at':stamp(a.created_at)} for a in actions],'closure':{'eligible':not reasons,'reasons':reasons,'test_stop_confirmation_required':row.rule_id=='login_failures' or row.rule_id=='notification_delivery_test' and row.synthetic}}
    def conflict(): raise ApiError(409,'STATE_CONFLICT','사건 상태가 변경되었습니다. 새로고침해 주세요.')
    @app.post('/api/incidents/{id}/accept')
    def accept(id:str,request:Request):
        with factory.begin() as db:
            user=admin(request,db,True); data=body(request)
            if data: invalid('body')
            row=load(db,id)
            if row.status!='new': conflict()
            if not change(db,row,{'status':'accepted','accepted_by':user.user_id,'accepted_at':now()}): conflict()
            db.add(Action(incident_id=id,kind='accept',content='사건 접수',actor_id=user.user_id))
            return item(row,db)
    @app.post('/api/incidents/{id}/actions',status_code=201)
    def action(id:str,request:Request):
        with factory.begin() as db:
            user=admin(request,db,True); data=body(request)
            if set(data)!={'content'}: invalid('body')
            content=text(data,'content'); row=load(db,id)
            if row.status not in ['accepted','in_progress']: conflict()
            if not change(db,row,{'status':'in_progress'}): conflict()
            record=Action(incident_id=id,kind='action',content=content,actor_id=user.user_id); db.add(record); db.flush()
            return {'action_id':record.id,'status':row.status}
    @app.post('/api/incidents/{id}/close')
    def close(id:str,request:Request):
        with factory.begin() as db:
            user=admin(request,db,True); data=body(request)
            if not set(data)<= {'resolution','test_stopped'}: invalid('body')
            resolution=text(data,'resolution'); row=load(db,id)
            if row.status=='closed': conflict()
            reasons=closure_reasons(db,row,test_stopped=data.get('test_stopped') is True)
            if reasons: raise ApiError(409,'RECOVERY_NOT_CONFIRMED','복구 조건을 아직 충족하지 못했습니다.',details=reasons)
            if not change(db,row,{'status':'closed','closed_by':user.user_id,'closed_at':now(),'resolution':resolution,'open_key':None}): conflict()
            from management.alert_policy import RULE_IDS
            if row.rule_id not in RULE_IDS:
                state=target(db,row.target_id); state.failures=0; state.slows=0
                if row.rule_id=='login_failures': state.security_cutoff=now()
            db.add(Action(incident_id=id,kind='close',content=resolution,actor_id=user.user_id))
            return item(row,db)
    return app

