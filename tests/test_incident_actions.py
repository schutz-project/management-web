import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import select
from portal.config import Settings
from portal.db import build_engine, session_factory
from portal.models import Base, Employee, UserAccount, LoginSession, now
from portal.security import digest
from management.models import Incident, Job, Action
from management.web import create_app


class IncidentActionFixture(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.engine = build_engine('sqlite:///' + str(Path(self.directory.name)/'test.db'))
        Base.metadata.create_all(self.engine)
        self.factory = session_factory(self.engine)
        self.settings = Settings(
            _env_file=None, database_url=str(self.engine.url), app_secret='a'*32,
            proxy_secret='b'*32, internal_check_token='c'*32, test_context_secret='d'*32,
            allowed_origin='https://manage.example',
        )
        with self.factory.begin() as db:
            for uid, role in [(1,'admin'), (2,'user')]:
                db.add(Employee(employee_id=uid, employee_code='EMP00'+str(uid),
                                name='시험 사용자', department='개발', position='직원',
                                email=str(uid)+'@example.invalid'))
                db.flush()
                db.add(UserAccount(user_id=uid, employee_id=uid, username=role,
                                   password_hash='unused', role=role))
                db.flush()
                db.add(LoginSession(user_id=uid, session_token_hash=digest(role+'-session'),
                                    csrf_token_hash=digest('unit-csrf'),
                                    expires_at=now()+timedelta(hours=1)))
            db.add(Incident(id='test-incident',target_id='delivery-test',
                            rule_id='notification_delivery_test',synthetic=True))
            db.flush()
            for kind in ('slack','ai','slack_ai'):
                db.add(Job(incident_id='test-incident',kind=kind,status='succeeded',
                           mode='live', result={'summary':'모의 분석'} if kind=='ai' else {'sent':True}))
        self.app = create_app(settings=self.settings, engine=self.engine, observer=object())
        self.client = TestClient(self.app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None,None,None)
        self.engine.dispose()
        self.directory.cleanup()

    def login_cookie(self, role='admin'):
        self.client.cookies.set('portal_session', role+'-session')

    def post(self, action, body, **kwargs):
        return self.client.post('/api/incidents/test-incident/'+action, json=body,
            headers=kwargs.get('headers',{'X-CSRF-Token':'unit-csrf','Origin':'https://manage.example'}))

class IncidentActionTests(IncidentActionFixture):
    def test_capabilities_requires_authenticated_admin(self):
        self.assertEqual(self.client.get('/api/management/capabilities').status_code,401)
        self.login_cookie('user')
        self.assertEqual(self.client.get('/api/management/capabilities').status_code,403)
        self.login_cookie()
        self.assertEqual(self.client.get('/api/management/capabilities').json(),
                         {'mode':'live','writes_enabled':True})
        with self.factory() as db:
            self.assertEqual(len(db.scalars(select(Action)).all()),0)

    def test_csrf_and_origin_and_role_still_protect_writes(self):
        self.login_cookie()
        self.assertEqual(self.post('accept',{},headers={}).status_code,403)
        self.assertEqual(self.post('accept',{},headers={'X-CSRF-Token':'unit-csrf','Origin':'https://evil.invalid'}).status_code,403)
        self.login_cookie('user')
        self.assertEqual(self.post('accept',{}).status_code,403)
        with self.factory() as db:
            self.assertEqual(db.get(Incident,'test-incident').status,'new')

    def test_disabled_flag_blocks_backend_not_just_buttons(self):
        self.login_cookie(); self.settings.management_actions_enabled=False
        self.assertFalse(self.client.get('/api/management/capabilities').json()['writes_enabled'])
        self.assertEqual(self.post('accept',{}).json()['error_code'],'ACTIONS_DISABLED')

    def test_manual_accept_action_and_delivery_test_closure(self):
        self.login_cookie()
        self.assertEqual(self.post('close',{'resolution':'아직 조치 없음','test_stopped':True}).status_code,409)
        self.assertEqual(self.post('accept',{}).status_code,200)
        self.assertEqual(self.post('actions',{'content':'실제 모의 알림 수신 확인'}).status_code,201)
        detail=self.client.get('/api/incidents/test-incident').json()
        self.assertTrue(detail['closure']['test_stop_confirmation_required'])
        self.assertTrue(detail['closure']['eligible'])
        self.assertEqual(self.post('close',{'resolution':'수신 및 시험 종료 확인'}).status_code,409)
        closed=self.post('close',{'resolution':'수신 및 시험 종료 확인','test_stopped':True})
        self.assertEqual(closed.status_code,200)
        with self.factory() as db:
            self.assertEqual(db.get(Incident,'test-incident').status,'closed')
            self.assertEqual([a.kind for a in db.scalars(select(Action).order_by(Action.created_at))],['accept','action','close'])

    def test_demo_or_unconfirmed_delivery_does_not_allow_closure(self):
        self.login_cookie(); self.post('accept',{}); self.post('actions',{'content':'점검'})
        with self.factory.begin() as db:
            job=db.scalar(select(Job).where(Job.kind=='slack_ai'));job.result={'sent':False}
        response=self.post('close',{'resolution':'완료','test_stopped':True})
        self.assertEqual(response.status_code,409)
        self.assertIn('DELIVERY_SUCCESS_REQUIRED',response.json()['details'])
        with self.factory.begin() as db:
            incident=db.get(Incident,'test-incident');incident.synthetic=False
        # A real incident cannot use the synthetic notification-test shortcut.
        response=self.post('close',{'resolution':'완료','test_stopped':True})
        self.assertEqual(response.status_code,409)
        self.assertIn('TWO_HEALTHY_CHECKS_REQUIRED',response.json()['details'])


if __name__ == '__main__':
    unittest.main()
