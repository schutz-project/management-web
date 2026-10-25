import json
from fastapi import Request
from fastapi.responses import FileResponse
from sqlalchemy import select,func
from portal.main import create_app as portal_app, ApiError, invalid, ROOT
from portal.models import now
from management.models import Target, Incident, Evidence, IncidentEvidence, Action, Job, Attempt
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
        target(db,row.target_id)
        return db.scalar(select(Incident).where(Incident.id==id).with_for_update())
    def item(row):
        return {**{k:getattr(row,k) for k in ['id','target_id','rule_id','status','synthetic','test_run_id','accepted_by','closed_by','resolution','version']},'detected_at':stamp(row.detected_at),'accepted_at':stamp(row.accepted_at),'closed_at':stamp(row.closed_at)}
    @app.get('/')
    @app.get('/incidents/{path_id}')
    def index(path_id:str=''): return FileResponse(ROOT/'static/schutz-ui/index.html')
    @app.get('/api/dashboard')
    def dashboard(request:Request):
        with factory.begin() as db:
            admin(request,db); servers=[]; current=now()
            for row in db.scalars(select(Target).order_by(Target.id)):
                checked=row.log_collection_at if row.id=='portal-login' else row.collection_at
                stale=not checked or (current-utc(checked)).total_seconds()>60
                status='unknown' if stale else ('normal' if row.id=='portal-login' or row.last_ok and row.duration_ms<=2000 else 'abnormal')
                servers.append({'target_id':row.id,'status':status,'last_checked_at':stamp(checked),'collection_delayed':stale,'duration_ms':row.duration_ms})
            counts={k:db.scalar(select(func.count()).select_from(Incident).where(Incident.status==k)) for k in ['new','accepted','in_progress','closed']}
            return {'as_of':stamp(current),'servers':servers,'incident_counts':counts}
    @app.get('/api/observability')
    async def observability(request:Request,window:str='15m'):
        with factory.begin() as db: admin(request,db)
        from management.observability import WINDOWS
        if window not in WINDOWS: invalid('window')
        return await app.state.observer.snapshot(window=window)
    @app.get('/api/incidents')
    def incidents(request:Request,status:str='open',page:int=1):
        if status not in ['open','closed'] or not 1<=page<=100000: invalid('query')
        with factory.begin() as db:
            admin(request,db)
            conditions=Incident.status=='closed' if status=='closed' else Incident.status!='closed'
            rows=db.scalars(select(Incident).where(conditions).order_by(Incident.detected_at.desc(),Incident.id).offset((page-1)*20).limit(20)).all()
            return {'items':[item(r) for r in rows],'total':db.scalar(select(func.count()).select_from(Incident).where(conditions)),'page':page,'page_size':20}
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
            return {**item(row),'evidence':[{'id':e.id,'kind':e.kind,'occurred_at':stamp(e.occurred_at),'payload':e.payload} for e in evidence],'jobs':jobs,'actions':[{'id':a.id,'kind':a.kind,'content':a.content,'actor_id':a.actor_id,'created_at':stamp(a.created_at)} for a in actions],'closure':{'eligible':not reasons,'reasons':reasons,'test_stop_confirmation_required':row.rule_id=='login_failures'}}
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
            return item(row)
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
            state=target(db,row.target_id); state.failures=0; state.slows=0
            if row.rule_id=='login_failures': state.security_cutoff=now()
            db.add(Action(incident_id=id,kind='close',content=resolution,actor_id=user.user_id))
            return item(row)
    return app
