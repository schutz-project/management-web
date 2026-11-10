from datetime import timedelta
from unittest.mock import patch
from sqlalchemy import select, func
from test_incident_actions import IncidentActionFixture
from portal.models import now
from management.models import Incident, Evidence, IncidentEvidence, Job, Target


class SecurityIncidentFlowTests(IncidentActionFixture):
    def test_scope_default_operational_and_explicit_synthetic_or_all(self):
        at=now()
        with self.factory.begin() as db:
            db.get(Incident,'test-incident').detected_at=at-timedelta(seconds=10)
            db.add(Incident(id='real-unit',target_id='app',rule_id='response_delay',
                            synthetic=False,detected_at=at-timedelta(seconds=10)))
        self.login_cookie()
        for scope,expected in [(None,1),('synthetic',1),('all',2)]:
            response=self.client.get('/api/dashboard/incident-overview',params={} if scope is None else {'scope':scope})
            self.assertEqual(response.status_code,200)
            data=response.json()
            self.assertEqual(sum(b['detected'] for b in data['buckets']),expected)
            self.assertEqual(len(data['timeline']),expected)
            self.assertEqual(sum(data['types'].values()),expected)
            self.assertEqual(data['scope'],scope or 'operational')
        self.assertEqual(self.client.get('/api/dashboard/incident-overview?scope=invalid').status_code,400)

    def prepare_security_incident(self,rule='unauthorized_write'):
        at=now();target='sec:fixture'
        with self.factory.begin() as db:
            incident=db.get(Incident,'test-incident')
            incident.rule_id=rule;incident.target_id=target
            incident.detected_at=at-timedelta(seconds=90)
            db.add(Target(id=target,log_collection_at=at))
            db.add(Evidence(id='security-unit',target_id=target,kind='security',
                occurred_at=at-timedelta(seconds=80),payload={'synthetic':True}))
            db.flush()
            db.add(IncidentEvidence(incident_id='test-incident',evidence_id='security-unit'))
        self.login_cookie()
        self.assertEqual(self.post('accept',{}).status_code,200)
        self.assertEqual(self.post('actions',{'content':'기존 접근 거부·시험 데이터 미변경 확인. 추가 차단 미실행.'}).status_code,201)

    def test_security_closure_requires_stop_and_queues_one_closed_notification(self):
        self.prepare_security_incident()
        detail=self.client.get('/api/incidents/test-incident').json()
        self.assertTrue(detail['closure']['test_stop_confirmation_required'])
        self.assertTrue(detail['closure']['eligible'])
        self.assertEqual(self.post('close',{'resolution':'시험 종료'}).status_code,409)
        self.assertEqual(self.post('close',{'resolution':'시험 종료','test_stopped':True}).status_code,200)
        self.assertEqual(self.post('close',{'resolution':'다시 종료','test_stopped':True}).status_code,409)
        with self.factory() as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(Job).where(Job.kind=='slack_closed')),1)
            self.assertEqual(db.scalar(select(func.count()).select_from(Job).where(Job.kind=='slack_recovery')),0)
            self.assertIsNotNone(db.get(Target,'sec:fixture').security_cutoff)
        listed=self.client.get('/api/incidents?status=closed').json()
        closed_job=next(j for j in listed['items'][0]['jobs'] if j['kind']=='slack_closed')
        self.assertEqual(closed_job['status'],'pending')

    def test_stale_security_collection_cannot_be_closed(self):
        self.prepare_security_incident()
        with self.factory.begin() as db:
            db.get(Target,'sec:fixture').log_collection_at=now()-timedelta(seconds=61)
        response=self.post('close',{'resolution':'종료 시도','test_stopped':True})
        self.assertEqual(response.status_code,409)
        self.assertIn('LOG_COLLECTION_STALE',response.json()['details'])
        with self.factory() as db:
            self.assertNotEqual(db.get(Incident,'test-incident').status,'closed')
            self.assertEqual(db.scalar(select(func.count()).select_from(Job).where(Job.kind=='slack_closed')),0)

    def test_unauthorized_operator_cannot_trigger_closed_notification(self):
        self.prepare_security_incident()
        self.login_cookie('user')
        self.assertEqual(self.post('close',{'resolution':'not allowed','test_stopped':True}).status_code,403)
        with self.factory() as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(Job).where(Job.kind=='slack_closed')),0)
