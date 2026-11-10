import json
from datetime import datetime, timezone
from fastapi import Request
from fastapi.responses import FileResponse
from sqlalchemy import select,func,or_
from portal.main import create_app as portal_app, ApiError, invalid, ROOT
from portal.models import now
from management.models import Target, Incident, Evidence, IncidentEvidence, Action, Job, Attempt, PrometheusAlertState
from management.domain import utc, closure_reasons, change, target

def stamp(v): return utc(v).isoformat().replace('+00:00','Z') if v else None
def create_app(settings=None,engine=None,metric_readers=None,observer=None,session_control_transport=None):
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
                age=(current-utc(checked)).total_seconds() if checked else None
                # collection_delayed only marks samples older than 60 seconds.
                # Missing or future timestamps outside tolerance produce unknown status.
                collection_delayed=age is not None and age>60
                valid=age is not None and -5<=age<=60 and (row.id=='portal-login' or row.last_ok is not None)
                status='unknown' if not valid else ('normal' if row.id=='portal-login' or row.last_ok and row.duration_ms is not None and row.duration_ms<=2000 else 'abnormal')
                result={'target_id':row.id,'status':status,'last_checked_at':stamp(checked),'collection_delayed':collection_delayed,'duration_ms':row.duration_ms}
                if row.id=='proxy' and valid:
                    evidence=db.get(Evidence,'probe:proxy:'+str(row.last_sample))
                    if evidence and utc(evidence.occurred_at)==utc(checked):
                        code=evidence.payload.get('status_code')
                        if type(code) is int and 100<=code<=599:
                            result['http_status']=code
                servers.append(result)
            counts={k:db.scalar(select(func.count()).select_from(Incident).where(Incident.status==k)) for k in ['new','accepted','in_progress','closed']}
            return {'as_of':stamp(current),'servers':servers,'incident_counts':counts}
    @app.get('/api/dashboard/incident-overview')
    def incident_overview(request:Request,window:str='15m',start:str|None=None,end:str|None=None,scope:str='operational'):
        from management.observability import WINDOWS, custom_bounds
        if scope not in {'operational','synthetic','all'}: invalid('scope')
        from sqlalchemy import true
        scope_condition = Incident.synthetic.is_(False) if scope=='operational' else Incident.synthetic.is_(True) if scope=='synthetic' else true()
        current=now().timestamp()
        if window=='custom':
            try:
                first,last,_=custom_bounds(start,end,now=current)
            except ValueError: invalid('range')
        elif window in WINDOWS and start is None and end is None:
            last=current
            first=last-WINDOWS[window][0]
        else:
            invalid('range')
        lower=datetime.fromtimestamp(first,timezone.utc)
        upper=datetime.fromtimestamp(last,timezone.utc)
        with factory.begin() as db:
            admin(request,db)
            rows=db.execute(select(Incident.detected_at,Incident.closed_at,Incident.rule_id).where(
                scope_condition,
                or_((Incident.detected_at>=lower)&(Incident.detected_at<=upper),
                    (Incident.closed_at>=lower)&(Incident.closed_at<=upper))))
            step=(last-first)/12
            buckets=[{'start':stamp(datetime.fromtimestamp(first+i*step,timezone.utc)),
                      'detected':0,'closed':0} for i in range(12)]
            types={'delay':0,'collection':0,'other':0}
            for detected,closed,rule in rows:
                for name,at in (('detected',detected),('closed',closed)):
                    if at is None:
                        continue
                    seconds=utc(at).timestamp()
                    if not first<=seconds<=last:
                        continue
                    buckets[min(11,int((seconds-first)/step))][name]+=1
                    if name=='detected':
                        kind={'response_delay':'delay',
                              'monitoring_target_down':'collection','portal_telemetry_missing':'collection'}.get(rule,'other')
                        types[kind]+=1
            timeline_query=select(Incident).where(
                scope_condition,Incident.detected_at<=upper,
                or_(Incident.closed_at.is_(None),Incident.closed_at>=lower),
            ).order_by(Incident.detected_at.desc(),Incident.id).limit(21)
            incidents=list(db.scalars(timeline_query))
            selected={incident.id:incident for incident in incidents[:20]}
            observed_until=min(upper,datetime.fromtimestamp(current,timezone.utc))
            observations=db.execute(
                select(IncidentEvidence.incident_id,Evidence.target_id,Evidence.occurred_at,Evidence.payload)
                .join(Evidence,Evidence.id==IncidentEvidence.evidence_id)
                .where(IncidentEvidence.incident_id.in_(selected),Evidence.kind=='prometheus',
                       Evidence.occurred_at<=observed_until)
                .order_by(IncidentEvidence.incident_id,Evidence.occurred_at,Evidence.id)
            )
            verified={}
            last_normal={}
            for incident_id,target_id,observed,payload in observations:
                incident=selected[incident_id]
                observed=utc(observed)
                if (incident_id in verified or target_id!=incident.target_id
                    or payload.get('rule_id')!=incident.rule_id
                    or observed<utc(incident.detected_at)
                    or (incident.closed_at and observed>utc(incident.closed_at))):
                    continue
                if payload.get('state')!='normal':
                    last_normal.pop(incident_id,None)
                    continue
                previous=last_normal.get(incident_id)
                if previous and 0<(observed-previous).total_seconds()<=60:
                    verified[incident_id]=observed
                last_normal[incident_id]=observed
            timeline=[]
            for incident in selected.values():
                closed=utc(incident.closed_at)
                detected=utc(incident.detected_at)
                recovery=verified.get(incident.id)
                timeline.append({'id':incident.id,'target_id':incident.target_id,'synthetic':incident.synthetic,
                                 'rule_id':incident.rule_id,'detected_at':stamp(detected),
                                 'recovery_checked_at':stamp(recovery),'closed_at':stamp(closed)})
            return {'scope':scope,'start':stamp(lower),'end':stamp(upper),'buckets':buckets,'types':types,
                    'timeline':timeline,'timeline_truncated':len(incidents)>20}
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
    def incidents(request:Request,status:str='open',page:int=1,q:str='',severity:str='all',state:str='all'):
        from management.incident_list import list_incidents,STATES
        if (status not in ['open','closed','all'] or not 1<=page<=100000 or len(q)>80
            or severity not in ['all','unknown','warning','critical'] or state not in ['all',*STATES]): invalid('query')
        with factory.begin() as db:
            admin(request,db)
            return list_incidents(db,item,status,page,q.strip(),severity,state)
    @app.get('/api/incidents/{id}')
    def detail(id:str,request:Request):
        with factory.begin() as db:
            admin(request,db); row=db.get(Incident,id)
            if row is None: raise ApiError(404,'INCIDENT_NOT_FOUND','사건을 찾을 수 없습니다.')
            evidence=db.scalars(select(Evidence).join(IncidentEvidence,IncidentEvidence.evidence_id==Evidence.id).where(IncidentEvidence.incident_id==id).order_by(Evidence.occurred_at.desc()).limit(100)).all()
            jobs=[]
            for job in db.scalars(select(Job).where(Job.incident_id==id).order_by(Job.kind)):
                attempts=db.scalars(select(Attempt).where(Attempt.job_id==job.id).order_by(Attempt.number)).all()
                jobs.append({'kind':job.kind,'status':job.status,'mode':job.mode,'attempts':job.attempts,'model':job.model,'prompt_version':job.prompt_version,'result':job.result,'error_code':job.error_code,'input_evidence':job.input_evidence,'history':[{'number':a.number,'outcome':a.outcome,'error_code':a.error_code,'started_at':stamp(a.started_at),'finished_at':stamp(a.finished_at)} for a in attempts]})
            actions=db.scalars(select(Action).where(Action.incident_id==id).order_by(Action.created_at,Action.id)).all()
            reasons=closure_reasons(db,row,test_stopped=True) if row.status!='closed' else []
            from management.session_control import operation as control_operation
            pending_control=control_operation(db,id)
            if pending_control and json.loads(pending_control.content)['status'] in {'pending','unknown'}:
                reasons=sorted(set(reasons+['CONTROL_RESULT_UNCONFIRMED']))
            from management.incident_list import severity_expression
            severity=db.scalar(select(severity_expression()).where(Incident.id==id))
            from management.session_control import detail as control_detail
            return {**item(row,db),'session_control':control_detail(db,row,app.state.settings),'severity':severity,'severity_source':'stored_prometheus_evidence' if severity else None,'evidence':[{'id':e.id,'kind':e.kind,'occurred_at':stamp(e.occurred_at),'payload':e.payload} for e in evidence],'jobs':jobs,'actions':[{'id':a.id,'kind':a.kind,'content':a.content,'actor_id':a.actor_id,'created_at':stamp(a.created_at)} for a in actions],'closure':{'eligible':not reasons,'reasons':reasons,'test_stop_confirmation_required':row.rule_id in {'login_failures','unauthorized_read','unauthorized_write'} or row.rule_id=='notification_delivery_test' and row.synthetic}}
    def conflict(): raise ApiError(409,'STATE_CONFLICT','사건 상태가 변경되었습니다. 새로고침해 주세요.')
    @app.post('/api/incidents/{id}/revoke-test-sessions')
    def revoke_sessions(id:str,request:Request):
        from management import session_control as control
        with factory.begin() as db:
            user=admin(request,db,True); data=body(request)
            if data!={'confirm_account':'test_user'}: invalid('confirm_account')
            row=load(db,id)
            if row.status not in {'accepted','in_progress'}: conflict()
            if not control.eligible(db,row):
                raise ApiError(409,'TRIAL_WRITE_INCIDENT_REQUIRED','시험 계정의 권한 거부 사건만 실행할 수 있습니다.')
            record=control.operation(db,id)
            is_retry=record is not None
            if record is None:
                import uuid
                intent={'operation_id':uuid.uuid4().hex,'incident_id':id,'account_ref':'test_user',
                    'test_run_id':row.test_run_id,'actor_id':user.user_id,'status':'pending','attempts':[]}
                record=Action(incident_id=id,kind='session_revoke',content=json.dumps(intent),actor_id=user.user_id)
                db.add(record); db.flush()
            else: intent=json.loads(record.content)
            if intent['status']=='succeeded': return intent
            if len(intent['attempts'])>=20:
                raise ApiError(409,'CONTROL_REVIEW_REQUIRED','실행 이력을 검토해 주세요.')
            # Commit intent BEFORE any service call. Retry always reuses operation_id.
            intent['unconfirmed_prior']=bool(intent.get('unconfirmed_prior') or is_retry and intent['status'] in {'pending','unknown'})
            intent['status']='pending'
            record.content=json.dumps(intent,ensure_ascii=False)
            record_id=record.id
        result=control.execute(app.state.settings,intent,session_control_transport)
        if result['status']=='failed' and intent.get('unconfirmed_prior'):
            result={**result,'status':'unknown','error_code':'CONTROL_RESULT_UNCONFIRMED'}
        with factory.begin() as db:
            # Serializes with other actions and closure; never overwrite confirmed success.
            row=load(db,id); record=db.get(Action,record_id)
            stored=json.loads(record.content)
            if stored['status']=='succeeded': return stored
            stored.update(result)
            stored['unconfirmed_prior']=result['status']=='unknown'
            stored['attempts'].append({'at':stamp(now()),'actor_id':user.user_id,
                'status':result['status'],'error_code':result.get('error_code')})
            record.content=json.dumps(stored,ensure_ascii=False)
            if result['status']=='succeeded':
                if row.status in {'accepted','in_progress'}:
                    if not change(db,row,{'status':'in_progress'}): conflict()
                db.add(Action(incident_id=id,kind='action',actor_id=user.user_id,
                    content='시험 계정 test_user의 세션 폐기 서비스 확인: '+str(result['revoked_count'])+
                    '건. 기존 세션 접근 거부·시험 객체 미변경은 별도 검증 필요. 실행 ID '+stored['operation_id']))
            response=stored
        from fastapi.responses import JSONResponse
        return JSONResponse(response,status_code=200 if response['status']=='succeeded' else 202)

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
            from management.session_control import operation
            control_record=operation(db,id)
            if control_record and json.loads(control_record.content)['status'] in {'pending','unknown'}:
                raise ApiError(409,'CONTROL_RESULT_UNCONFIRMED','세션 폐기 실행 결과를 먼저 확인해 주세요.')
            reasons=closure_reasons(db,row,test_stopped=data.get('test_stopped') is True)
            if reasons: raise ApiError(409,'RECOVERY_NOT_CONFIRMED','복구 조건을 아직 충족하지 못했습니다.',details=reasons)
            if not change(db,row,{'status':'closed','closed_by':user.user_id,'closed_at':now(),'resolution':resolution,'open_key':None}): conflict()
            from management.alert_policy import RULE_IDS
            if row.rule_id not in RULE_IDS:
                state=target(db,row.target_id); state.failures=0; state.slows=0
                if row.rule_id in {'login_failures','unauthorized_read','unauthorized_write'}: state.security_cutoff=now()
            db.add(Action(incident_id=id,kind='close',content=resolution,actor_id=user.user_id))
            db.add(Job(incident_id=id,kind='slack_closed'))
            return item(row,db)
    return app

