import unittest
from datetime import datetime,timedelta,timezone
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from management.models import PrometheusAlertState,Incident,Action
from management.domain import closure_reasons
from management.alert_policy import recovery_ready
from portal.models import Base

class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.engine=create_engine('sqlite://');Base.metadata.create_all(self.engine)
        self.factory=sessionmaker(self.engine);self.at=datetime.now(timezone.utc)
        with self.factory.begin() as db:
            db.add(Incident(id='unit-incident',target_id='pa-unit',rule_id='monitoring_target_down',status='in_progress'))
            db.add(PrometheusAlertState(id='unit',target_key='pa-unit',rule_name='MonitoringTargetDown',labels={'job':'ec2-node','instance':'unit:9100'},last_sample=self.at.timestamp(),evaluated_at=self.at,state='normal',normal_samples=2,incident_id='unit-incident'))
    def tearDown(self):self.engine.dispose()
    def test_normal_metrics_do_not_bypass_admin_action(self):
        with self.factory.begin() as db:
            incident=db.get(Incident,'unit-incident')
            self.assertEqual(closure_reasons(db,incident,at=self.at),['ACTION_REQUIRED'])
            db.add(Action(incident_id=incident.id,kind='action',content='점검 완료',actor_id=1));db.flush()
            self.assertEqual(closure_reasons(db,incident,at=self.at),[])
    def test_stale_or_unknown_rule_is_not_closeable(self):
        with self.factory() as db:
            incident=db.get(Incident,'unit-incident')
            self.assertFalse(recovery_ready(db,incident,self.at+timedelta(seconds=61)))
            state=db.get(PrometheusAlertState,'unit');state.state='unknown';db.flush()
            self.assertIn('PROMETHEUS_RECOVERY_NOT_CONFIRMED',closure_reasons(db,incident,at=self.at))
    def test_normal_signal_for_different_incident_is_not_reused(self):
        with self.factory() as db:
            db.get(PrometheusAlertState,'unit').incident_id='newer';db.flush()
            self.assertFalse(recovery_ready(db,db.get(Incident,'unit-incident'),self.at))
if __name__=='__main__':unittest.main()
