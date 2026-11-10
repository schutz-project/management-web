"""Explicit operator action, durable intent and authenticated service receipt."""
import json
import time
import ssl
from pathlib import Path
from urllib.parse import urlsplit
from datetime import datetime, timezone
import httpx
from sqlalchemy import select
from management.models import Action, Evidence, IncidentEvidence
from management.security_events import classify
from portal.security import sign

PATH='/internal/security/revoke-test-sessions'
PURPOSE='revoke-trial-sessions-v1'
ACCOUNT='test_user'


def configured(settings):
    url=urlsplit(settings.session_control_url)
    return bool(settings.session_control_enabled and settings.environment=='test'
        and len(settings.session_control_secret)>=32
        and settings.session_control_secret not in {settings.app_secret,settings.proxy_secret,
            settings.test_context_secret,settings.internal_check_token}
        and url.scheme=='https' and url.hostname and not url.username and not url.password
        and not url.query and not url.fragment and url.path==PATH)


def eligible(db, incident):
    if not incident.synthetic or incident.rule_id!='unauthorized_write' or not incident.test_run_id:
        return False
    rows=db.scalars(select(Evidence).join(IncidentEvidence,
        IncidentEvidence.evidence_id==Evidence.id).where(IncidentEvidence.incident_id==incident.id)).all()
    return len(rows)>=3 and all(e.kind=='security' and classify(e.payload)=='unauthorized_write'
        and e.payload.get('synthetic') is True and e.payload.get('account_ref')==ACCOUNT
        and e.payload.get('test_run_id')==incident.test_run_id for e in rows)


def operation(db, incident_id):
    return db.scalar(select(Action).where(Action.incident_id==incident_id,
        Action.kind=='session_revoke').order_by(Action.created_at,Action.id))


def detail(db, incident, settings):
    record=operation(db,incident.id)
    result=json.loads(record.content) if record else None
    return {'enabled':configured(settings),'eligible':eligible(db,incident),
        'account_ref':ACCOUNT if eligible(db,incident) else None,
        'operation':result,
        'notice':'지정 시험 계정의 기존 유효 세션만 폐기합니다. 재로그인·계정 잠금·요청 차단은 별도입니다.'}


def execute(settings, intent, transport=None):
    # Caller supplies only a stored, authorized intent, never a browser URL/account.
    if not configured(settings): return {'status':'failed','error_code':'CONTROL_DISABLED'}
    # A dedicated public certificate/CA bundle; never disable chain or address verification.
    verify = True
    ca_file = getattr(settings, 'session_control_ca_file', '')
    if ca_file:
        try:
            path = Path(ca_file)
            if not path.is_absolute() or not path.is_file():
                raise ValueError('invalid trust path')
            verify = ssl.create_default_context(cafile=str(path))
        except (OSError, ssl.SSLError, ValueError):
            return {'status':'failed','error_code':'CONTROL_TLS_CONFIG'}
    payload={k:intent[k] for k in ('operation_id','incident_id','account_ref','test_run_id','actor_id')}
    payload['exp']=int(time.time())+30
    try:
        with httpx.Client(timeout=5,follow_redirects=False,trust_env=False,verify=verify,transport=transport) as client:
            response=client.post(settings.session_control_url,
                headers={'X-Session-Control':sign(payload,settings.session_control_secret,PURPOSE)},json={})
        if response.status_code!=200:
            return {'status':'failed' if response.status_code in {400,401,403,404,409} else 'unknown',
                    'error_code':'SERVICE_REJECTED' if response.status_code<500 else 'SERVICE_UNAVAILABLE'}
        if len(response.content)>8192: raise ValueError('invalid receipt')
        receipt=response.json()
        if (not isinstance(receipt,dict) or receipt.get('status')!='succeeded'
            or any(receipt.get(k)!=payload[k] for k in ('operation_id','incident_id','account_ref','test_run_id'))
            or type(receipt.get('revoked_count')) is not int or not 0<=receipt['revoked_count']<=1000000
            or not isinstance(receipt.get('completed_at'),str)):
            raise ValueError('invalid receipt')
        completed=datetime.fromisoformat(receipt['completed_at'].replace('Z','+00:00'))
        if completed.utcoffset() is None or completed>datetime.now(timezone.utc): raise ValueError('invalid time')
        return {k:receipt[k] for k in ('status','revoked_count','completed_at')}
    except (httpx.HTTPError,ValueError,TypeError,KeyError):
        # Timeout or malformed receipt is not evidence of no execution. Retry the SAME operation.
        return {'status':'unknown','error_code':'CONTROL_RESULT_UNCONFIRMED'}
