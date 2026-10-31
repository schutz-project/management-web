import unittest
from management.host_inventory import host_inventory


def target(instance, role):
    return {'metric': {'job': 'ec2-node', 'instance': instance, 'server_role': role}}


class HostInventoryTests(unittest.TestCase):
    def test_roles_do_not_depend_on_source_order(self):
        nodes = {'monitor:12345': {'cpu': 12, 'status': 'ok'},
                 'service:9100': {'cpu': 34, 'status': 'ok'}}
        hosts = host_inventory(nodes, [target('service:9100', 'service'), target('monitor:12345', 'monitoring')])
        self.assertEqual({h['server_role']: h['cpu'] for h in hosts}, {'service': 34, 'monitoring': 12})

    def test_missing_role_is_visible_without_invented_zero(self):
        hosts = host_inventory({}, [])
        self.assertEqual({h['server_role'] for h in hosts}, {'service', 'monitoring'})
        self.assertTrue(all(h['cpu'] is None and h['status'] == 'no_data' for h in hosts))

    def test_configured_target_without_samples_is_not_hidden(self):
        hosts = host_inventory({}, [target('monitor:12345', 'monitoring')])
        self.assertEqual(hosts[0]['instance'], 'monitor:12345')
        self.assertEqual(hosts[0]['status'], 'no_data')

    def test_failed_query_is_not_reported_as_no_data(self):
        hosts = host_inventory({}, TimeoutError(), source_failed=True)
        self.assertTrue(all(h['status'] == 'unavailable' for h in hosts))

    def test_unlabelled_legacy_node_is_not_guessed_to_be_monitoring(self):
        hosts = host_inventory({'legacy': {'cpu': 20, 'status': 'stale'}}, [])
        self.assertEqual(hosts[0]['server_role'], 'unknown')
        self.assertEqual(hosts[0]['status'], 'stale')
        self.assertEqual(len(hosts), 3)

    def test_target_role_after_old_limit_is_not_silently_dropped(self):
        targets = [target('other:'+str(i), 'unknown') for i in range(35)]
        targets.append(target('monitor:12345', 'monitoring'))
        hosts = host_inventory({}, targets)
        self.assertTrue(any(h['instance']=='monitor:12345' and h['server_role']=='monitoring' for h in hosts))
