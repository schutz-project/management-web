import unittest
from datetime import timedelta
from sqlalchemy import select,func
from sqlalchemy.dialects import postgresql
from management.models import Incident,Job,Attempt,Evidence,IncidentEvidence,Target
from management.incident_list import query_conditions,severity_expression
from portal.models import now
from test_incident_actions import IncidentActionFixture


class IncidentListTests(IncidentActionFixture):
    def seed(self):
        with self.factory.begin() as db:
            for number in range(25):
                at=now()-timedelta(minutes=number+1)
                state=['new','accepted','in_progress','closed'][number%4]
                row=Incident(target_id='app',rule_id='availability_failure',status=state,
                             synthetic=True,detected_at=at,closed_at=at+timedelta(seconds=20) if state=='closed' else None)
                db.add(row);db.flush()

    def test_server_pagination_counts_and_all_status_are_not_page_estimates(self):
        self.seed();self.login_cookie()
        first=self.client.get('/api/incidents?status=all').json()
        self.assertEqual(first['total'],26);self.assertEqual(len(first['items']),20)
        self.assertEqual(first['page_count'],2)
        self.assertEqual(first['counts'],{'new':8,'accepted':6,'in_progress':6,'closed':6})
        second=self.client.get('/api/incidents?status=all&page=2').json()
        self.assertEqual(len(second['items']),6)
        self.assertFalse({r['id'] for r in first['items']}&{r['id'] for r in second['items']})
        closed=self.client.get('/api/incidents?status=closed').json()
        self.assertEqual(closed['total'],6);self.assertEqual(closed['summary_total'],26)
        self.assertEqual(closed['scope']['period'],'all_time')

    def test_search_aliases_literal_wildcards_and_state_filter(self):
        self.seed();self.login_cookie()
        for q in ['가용성','FastAPI']:
            data=self.client.get('/api/incidents',params={'status':'all','q':q}).json()
            self.assertEqual(data['total'],25)
        for q in ['%',"' OR 1=1 --"]:
            data=self.client.get('/api/incidents',params={'status':'all','q':q}).json()
            self.assertEqual(data['total'],0,q)
        # An underscore is literal and is present in every seeded rule ID.
        self.assertEqual(self.client.get('/api/incidents',params={'status':'all','q':'_'}).json()['total'],26)
        data=self.client.get('/api/incidents?status=all&state=accepted').json()
        self.assertEqual(data['total'],6)
        self.assertTrue(all(row['status']=='accepted' for row in data['items']))

    def test_only_stored_severity_is_exposed_and_filterable(self):
        self.login_cookie()
        with self.factory.begin() as db:
            ev=Evidence(id='severity-source',target_id='delivery-test',kind='prometheus',
                        occurred_at=now(),payload={'severity':'warning'})
            db.add(ev);db.flush()
            db.add(IncidentEvidence(incident_id='test-incident',evidence_id=ev.id))
        data=self.client.get('/api/incidents?severity=warning').json()
        self.assertEqual(data['total'],1);self.assertEqual(data['items'][0]['severity'],'warning')
        self.assertEqual(self.client.get('/api/incidents?severity=critical').json()['total'],0)
        self.assertEqual(self.client.get('/api/incidents?severity=unknown').json()['total'],0)
        self.assertEqual(self.client.get('/api/incidents/test-incident').json()['severity'],'warning')

    def test_job_summaries_include_delivery_not_secrets_or_full_ai_input(self):
        self.login_cookie()
        with self.factory.begin() as db:
            job=db.scalar(select(Job).where(Job.kind=='slack'));job.attempts=1
            db.add(Attempt(job_id=job.id,number=1,started_at=now(),outcome='succeeded'))
        data=self.client.get('/api/incidents').json();jobs=data['items'][0]['jobs']
        slack=next(j for j in jobs if j['kind']=='slack')
        self.assertTrue(slack['sent']);self.assertEqual(slack['attempts'],1)
        self.assertIsNotNone(slack['last_attempt_at'])
        self.assertNotIn('result',slack);self.assertNotIn('input_evidence',slack)
        self.assertFalse(any(j['kind']=='slack_recovery' for j in jobs))

    def test_list_validation_and_admin_access(self):
        self.assertEqual(self.client.get('/api/incidents?status=all').status_code,401)
        self.login_cookie('user');self.assertEqual(self.client.get('/api/incidents').status_code,403)
        self.login_cookie()
        for query in ['status=invalid','state=other','severity=high','page=0','q='+'a'*81]:
            self.assertEqual(self.client.get('/api/incidents?'+query).status_code,400)

    def test_reading_detail_does_not_create_monitoring_targets(self):
        self.login_cookie()
        with self.factory() as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(Target)),0)
        self.assertEqual(self.client.get('/api/incidents/test-incident').status_code,200)
        with self.factory() as db:
            self.assertEqual(db.scalar(select(func.count()).select_from(Target)),0)
            self.assertEqual(db.get(Incident,'test-incident').status,'new')

    def test_postgresql_query_compiles_with_bound_search_and_json_severity(self):
        query=select(Incident,severity_expression()).where(*query_conditions('blackbox','warning'))
        compiled=query.compile(dialect=postgresql.dialect())
        self.assertIn('blackbox',compiled.params.values())
        self.assertIn('SELECT',str(compiled))


if __name__=='__main__':unittest.main()