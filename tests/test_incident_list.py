import unittest
from datetime import timedelta
from sqlalchemy import select,func
from sqlalchemy.dialects import postgresql
from management.models import Incident,Job,Attempt,Evidence,IncidentEvidence,Target,PrometheusAlertState
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

class DashboardOverviewTests(IncidentActionFixture):
    def test_selected_period_counts_detected_and_closed_independently(self):
        moment=now()
        with self.factory.begin() as db:
            db.add_all([
                Incident(target_id='app',rule_id='response_delay',detected_at=moment-timedelta(minutes=3)),
                Incident(target_id='proxy',rule_id='monitoring_target_down',status='closed',
                         detected_at=moment-timedelta(hours=2),closed_at=moment-timedelta(minutes=1)),
                Incident(target_id='app',rule_id='response_delay',synthetic=True,
                         detected_at=moment-timedelta(minutes=2)),
            ])
        url='/api/dashboard/incident-overview'
        self.assertEqual(self.client.get(url).status_code,401)
        self.login_cookie()
        result=self.client.get(url,params={'window':'custom','start':(moment-timedelta(minutes=10)).isoformat(),'end':moment.isoformat()})
        self.assertEqual(result.status_code,200)
        data=result.json()
        self.assertEqual(len(data['buckets']),12)
        self.assertEqual(sum(b['detected'] for b in data['buckets']),1)
        self.assertEqual(sum(b['closed'] for b in data['buckets']),1)
        self.assertEqual(data['types'],{'delay':1,'collection':0,'other':0})
        self.assertEqual([row['rule_id'] for row in data['recent_detected']],['response_delay'])
        self.assertFalse(data['recent_detected'][0]['synthetic'])

    def test_date_only_end_includes_last_minute_in_dashboard(self):
        from datetime import timezone
        kst=timezone(timedelta(hours=9))
        day_end=now().astimezone(kst).replace(hour=23,minute=59,second=59,microsecond=999999)-timedelta(days=2)
        start=day_end.replace(hour=0,minute=0,second=0,microsecond=0)
        midnight=day_end+timedelta(microseconds=1)
        with self.factory.begin() as db:
            db.add_all([
                Incident(id='last-minute',target_id='app',rule_id='response_delay',
                         detected_at=day_end.astimezone(timezone.utc)-timedelta(seconds=30),
                         closed_at=day_end.astimezone(timezone.utc),status='closed'),
                Incident(id='next-day',target_id='app',rule_id='response_delay',detected_at=midnight.astimezone(timezone.utc)),
            ])
        self.login_cookie()
        response=self.client.get('/api/dashboard/incident-overview',params={
            'window':'custom','start':start.isoformat(),'end':day_end.isoformat()})
        self.assertEqual(response.status_code,200)
        result=response.json()
        self.assertEqual(sum(bucket['detected'] for bucket in result['buckets']),1)
        self.assertEqual(sum(bucket['closed'] for bucket in result['buckets']),1)
        self.assertEqual(result['types']['delay'],1)
        self.assertEqual([row['id'] for row in result['timeline']],['last-minute'])
        self.assertEqual([row['id'] for row in result['recent_detected']],['last-minute'])

    def test_dashboard_uses_http_status_from_the_same_fresh_proxy_probe(self):
        from management.domain import record_probe
        moment=now()
        with self.factory.begin() as db:
            record_probe(db,'proxy',1234.5,True,15,moment,status_code=200)
            record_probe(db,'app',1234.5,True,15,moment-timedelta(seconds=120))
            db.add(Target(id='database'))
            db.add(Target(id='portal-login',log_collection_at=moment+timedelta(seconds=30)))
        self.login_cookie()
        rows={row['target_id']:row for row in self.client.get('/api/dashboard').json()['servers']}
        self.assertEqual(rows['proxy']['http_status'],200)
        self.assertTrue(rows['app']['collection_delayed'])
        self.assertFalse(rows['database']['collection_delayed'])
        self.assertEqual(rows['database']['status'],'unknown')
        self.assertFalse(rows['portal-login']['collection_delayed'])
        self.assertEqual(rows['portal-login']['status'],'unknown')

    def test_timeline_keeps_recovery_after_the_next_incident_on_the_same_target(self):
        moment=now()
        detected=moment-timedelta(minutes=8)
        recovered=moment-timedelta(minutes=6)
        closed=moment-timedelta(minutes=5)
        with self.factory.begin() as db:
            db.add(Incident(id='verified-recovery',target_id='shared-target',
                            rule_id='monitoring_target_down',status='closed',
                            detected_at=detected,closed_at=closed))
            db.add(Incident(id='closed-only',target_id='closed-only',
                            rule_id='monitoring_target_down',status='closed',
                            detected_at=detected,closed_at=closed))
            db.flush()
            for index,at in enumerate((recovered-timedelta(seconds=30),recovered)):
                evidence_id=f'stored-normal-{index}'
                db.add(Evidence(id=evidence_id,target_id='shared-target',kind='prometheus',
                                occurred_at=at,payload={'rule_id':'monitoring_target_down',
                                                        'state':'normal'}))
                db.flush()
                db.add(IncidentEvidence(incident_id='verified-recovery',evidence_id=evidence_id))
            db.add(PrometheusAlertState(id='shared-state',target_key='shared-target',
                                        rule_name='MonitoringTargetDown',labels={},state='normal',
                                        normal_samples=2,incident_id='verified-recovery',
                                        evaluated_at=recovered))
        self.login_cookie()

        def historical_timeline():
            response=self.client.get('/api/dashboard/incident-overview',params={
                'window':'custom','start':(moment-timedelta(minutes=10)).isoformat(),
                'end':(moment-timedelta(minutes=4)).isoformat()})
            self.assertEqual(response.status_code,200)
            return {row['id']:row for row in response.json()['timeline']}

        before=historical_timeline()
        self.assertIsNone(before['closed-only']['recovery_checked_at'])
        self.assertEqual(before['verified-recovery']['recovery_checked_at'],
                         recovered.isoformat().replace('+00:00','Z'))

        with self.factory.begin() as db:
            db.add(Incident(id='next-incident',target_id='shared-target',
                            rule_id='monitoring_target_down',status='new',
                            detected_at=moment-timedelta(minutes=2)))
            db.flush()
            state=db.get(PrometheusAlertState,'shared-state')
            state.incident_id='next-incident'
            state.state='firing'
            state.normal_samples=0
            state.evaluated_at=moment-timedelta(minutes=2)

        self.assertEqual(historical_timeline(),before)
