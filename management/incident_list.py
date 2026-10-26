"""Bounded incident list reads. Counts come from the database, not page length."""
from sqlalchemy import select, func, or_, true
from management.models import Incident, Evidence, IncidentEvidence, Job, Attempt, PrometheusAlertState
from management.domain import utc

RULE_NAMES={
    'availability_failure':'가용성 장애','response_delay':'응답 지연',
    'login_failures':'반복 로그인 실패','monitoring_target_down':'수집 대상 연결 실패',
    'portal_telemetry_missing':'앱 메트릭 누락','portal_high_error_rate':'5xx 비율 증가',
    'notification_delivery_test':'알림 전달 시험',
}
TARGET_NAMES={'app':'FastAPI','database':'데이터베이스 직원 조회','proxy':'Nginx 프록시','portal-login':'로그인 감시'}
STATES=('new','accepted','in_progress','closed')

def severity_expression():
    value=Evidence.payload['severity'].as_string()
    return (select(value).join(IncidentEvidence,IncidentEvidence.evidence_id==Evidence.id)
        .where(IncidentEvidence.incident_id==Incident.id,Evidence.kind=='prometheus',value.in_(['warning','critical']))
        .order_by(Evidence.occurred_at.desc(),Evidence.id.desc()).limit(1).correlate(Incident).scalar_subquery())

def query_conditions(q,severity):
    conditions=[];level=severity_expression()
    if q:
        aliases=[key for key,value in RULE_NAMES.items() if q.casefold() in value.casefold()]
        targets=[key for key,value in TARGET_NAMES.items() if q.casefold() in value.casefold()]
        source=select(PrometheusAlertState.id).where(
            PrometheusAlertState.target_key==Incident.target_id,
            or_(PrometheusAlertState.rule_name.icontains(q,autoescape=True),
                PrometheusAlertState.labels['job'].as_string().icontains(q,autoescape=True),
                PrometheusAlertState.labels['instance'].as_string().icontains(q,autoescape=True)),
        ).exists()
        conditions.append(or_(Incident.id.icontains(q,autoescape=True),
            Incident.rule_id.icontains(q,autoescape=True),Incident.target_id.icontains(q,autoescape=True),
            Incident.rule_id.in_(aliases),Incident.target_id.in_(targets),source))
    if severity!='all':conditions.append(level.is_(None) if severity=='unknown' else level==severity)
    return conditions or [true()]

def job_summaries(db,incident_ids):
    if not incident_ids:return {}
    jobs=db.scalars(select(Job).where(Job.incident_id.in_(incident_ids),Job.kind.in_(['ai','slack','slack_ai','slack_recovery']))).all()
    times=dict(db.execute(select(Attempt.job_id,func.max(Attempt.started_at)).where(
        Attempt.job_id.in_([j.id for j in jobs])).group_by(Attempt.job_id)).all()) if jobs else {}
    result={}
    for job in jobs:
        at=times.get(job.id)
        sent=job.result.get('sent') if isinstance(job.result,dict) else None
        result.setdefault(job.incident_id,[]).append({
            'kind':job.kind,'status':job.status,'mode':job.mode,'attempts':job.attempts,
            'sent':sent if isinstance(sent,bool) else None,
            'last_attempt_at':utc(at).isoformat() if at else None,
        })
    return result

def list_incidents(db,render,status,page,q,severity,state):
    base=query_conditions(q,severity)
    counts={name:0 for name in STATES}
    counts.update(dict(db.execute(select(Incident.status,func.count()).where(*base).group_by(Incident.status)).all()))
    conditions=list(base)
    if status!='all':conditions.append(Incident.status=='closed' if status=='closed' else Incident.status!='closed')
    if state!='all':conditions.append(Incident.status==state)
    total=db.scalar(select(func.count()).select_from(Incident).where(*conditions))
    rows=db.execute(select(Incident,severity_expression().label('severity')).where(*conditions)
        .order_by(Incident.detected_at.desc(),Incident.id).offset((page-1)*20).limit(20)).all()
    summaries=job_summaries(db,[row.id for row,_ in rows])
    items=[]
    for row,level in rows:
        item=render(row,db);item.update(severity=level,severity_source='stored_prometheus_evidence' if level else None,jobs=summaries.get(row.id,[]));items.append(item)
    return {'items':items,'total':total,'page':page,'page_size':20,'page_count':(total+19)//20,
            'counts':counts,'summary_total':sum(counts.values()),
            'scope':{'period':'all_time','summary':'query_severity_all_states','list':'query_severity_tab_state'},
            'filters':{'q':q,'severity':severity,'state':state,'status':status}}