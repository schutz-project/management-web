import json
import httpx
from unittest.mock import patch
from sqlalchemy import select
from management.models import Incident, Evidence, IncidentEvidence, Action
from management.session_control import execute
from portal.models import now
from test_incident_actions import IncidentActionFixture

class SessionControlTests(IncidentActionFixture):
    def prepare(self):
        self.settings.session_control_enabled=True
        self.settings.session_control_secret='e'*32
        self.settings.session_control_url='https://service.internal/internal/security/revoke-test-sessions'
        with self.factory.begin() as db:
            incident=db.get(Incident,'test-incident');incident.rule_id='unauthorized_write';incident.test_run_id='CIA-UNIT'
            for n in range(3):
                db.add(Evidence(id='denied-'+str(n),target_id=incident.target_id,kind='security',occurred_at=now(),
                    payload={'service':'portal-api','event_type':'authorization_denied','reason_code':'FORBIDDEN',
                     'status_code':403,'method':'PUT','route':'/api/posts/{post_id}',
                     'account_ref':'test_user','synthetic':True,'test_run_id':'CIA-UNIT'}))
                db.flush();db.add(IncidentEvidence(incident_id=incident.id,evidence_id='denied-'+str(n)))
        self.login_cookie();self.assertEqual(self.post('accept',{}).status_code,200)

    def test_role_csrf_confirmation_and_read_incident_cannot_execute(self):
        self.prepare()
        with patch('management.session_control.execute') as call:
            self.login_cookie('user');self.assertEqual(self.post('revoke-test-sessions',{'confirm_account':'test_user'}).status_code,403)
            self.login_cookie();self.assertEqual(self.post('revoke-test-sessions',{'confirm_account':'test_user'},headers={}).status_code,403)
            self.assertEqual(self.post('revoke-test-sessions',{'confirm_account':'admin01'}).status_code,400)
            with self.factory.begin() as db: db.get(Incident,'test-incident').rule_id='unauthorized_read'
            self.assertEqual(self.post('revoke-test-sessions',{'confirm_account':'test_user'}).status_code,409)
            call.assert_not_called()

    def test_success_is_receipt_backed_and_repeated_click_does_not_send_again(self):
        self.prepare()
        with patch('management.session_control.execute',return_value={'status':'succeeded','revoked_count':1,'completed_at':now().isoformat()}) as call:
            first=self.post('revoke-test-sessions',{'confirm_account':'test_user'})
            self.assertEqual(first.status_code,200)
            again=self.post('revoke-test-sessions',{'confirm_account':'test_user'})
            self.assertEqual(again.json()['operation_id'],first.json()['operation_id']);self.assertEqual(call.call_count,1)
        detail=self.client.get('/api/incidents/test-incident').json()
        self.assertEqual(detail['session_control']['operation']['status'],'succeeded')
        self.assertTrue(any(a['kind']=='action' and '1건' in a['content'] for a in detail['actions']))

    def test_timeout_keeps_intent_and_blocks_close_until_same_id_receipt(self):
        self.prepare()
        with patch('management.session_control.execute',return_value={'status':'unknown','error_code':'CONTROL_RESULT_UNCONFIRMED'}):
            first=self.post('revoke-test-sessions',{'confirm_account':'test_user'})
            self.assertEqual(first.status_code,202)
        self.assertEqual(self.post('close',{'resolution':'종료','test_stopped':True}).json()['error_code'],'CONTROL_RESULT_UNCONFIRMED')
        with patch('management.session_control.execute',return_value={'status':'failed','error_code':'SERVICE_REJECTED'}):
            denied_retry=self.post('revoke-test-sessions',{'confirm_account':'test_user'})
            self.assertEqual(denied_retry.json()['status'],'unknown')
            self.assertEqual(self.post('close',{'resolution':'종료','test_stopped':True}).status_code,409)
        with patch('management.session_control.execute',return_value={'status':'succeeded','revoked_count':1,'completed_at':now().isoformat()}) as call:
            second=self.post('revoke-test-sessions',{'confirm_account':'test_user'})
            self.assertEqual(first.json()['operation_id'],second.json()['operation_id'])
        self.assertEqual(len(second.json()['attempts']),3)

    def test_disabled_connection_records_failure_without_success_action(self):
        self.prepare();self.settings.session_control_enabled=False
        result=self.post('revoke-test-sessions',{'confirm_account':'test_user'})
        self.assertEqual(result.status_code,202);self.assertEqual(result.json()['status'],'failed')
        with self.factory() as db:
            actions=db.scalars(select(Action).where(Action.kind=='action')).all();self.assertEqual(actions,[])

    def test_http_client_preserves_tls_no_redirects_and_checks_receipt_binding(self):
        self.prepare()
        intent={'operation_id':'op','incident_id':'test-incident','account_ref':'test_user','test_run_id':'CIA-UNIT','actor_id':1}
        def handler(request):
            self.assertEqual(request.url.scheme,'https')
            self.assertIn('x-session-control',request.headers)
            return httpx.Response(200,json={**intent,'status':'succeeded','revoked_count':1,'completed_at':now().isoformat()})
        self.assertEqual(execute(self.settings,intent,httpx.MockTransport(handler))['status'],'succeeded')
        self.assertEqual(execute(self.settings,intent,httpx.MockTransport(lambda r:httpx.Response(302,headers={'location':'https://other.invalid'})))['status'],'unknown')
        self.assertEqual(execute(self.settings,intent,httpx.MockTransport(lambda r:httpx.Response(200,json={'status':'succeeded'})))['status'],'unknown')

    def test_mixed_account_evidence_and_direct_control_route_are_rejected(self):
        self.prepare()
        self.assertEqual(self.client.post('/internal/security/revoke-test-sessions',json={}).status_code,404)
        with self.factory.begin() as db:
            row=db.get(Evidence,'denied-1');row.payload={**row.payload,'account_ref':'admin01'}
        with patch('management.session_control.execute') as call:
            self.assertEqual(self.post('revoke-test-sessions',{'confirm_account':'test_user'}).status_code,409)
            call.assert_not_called()
