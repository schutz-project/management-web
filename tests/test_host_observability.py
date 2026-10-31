import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch
from management.observability import Observer, NODE_SOURCE_QUERY, RESOURCE, source_time
from test_observability_parity import ResourceClient, Response


class HostClient(ResourceClient):
    def __init__(self, *, metadata_fail=False, source_fail=False, cpu_fail=False, age=5):
        super().__init__()
        self.metadata_fail, self.source_fail = metadata_fail, source_fail
        self.cpu_fail, self.age = cpu_fail, age

    async def get(self, url, params):
        query = params['query']
        if query == NODE_SOURCE_QUERY:
            if self.source_fail:
                raise TimeoutError('source')
            # [0] is evaluation time; [1] is timestamp(metric)'s value.
            return Response({'status': 'success', 'data': {'result': [
                {'metric': {'instance': 'service:9100'},
                 'value': [params['time'], str(params['time']-self.age)]}]}})
        if query == 'up':
            if self.metadata_fail:
                raise TimeoutError('metadata')
            return Response({'status': 'success', 'data': {'result': [
                {'metric': {'job': 'ec2-node', 'instance': 'service:9100', 'server_role': 'service'},
                 'value': [params['time'], '1']}]}})
        if self.cpu_fail and query == RESOURCE['cpu']:
            raise TimeoutError('cpu')
        return await super().get(url, params)


class HostObservabilityTests(unittest.IsolatedAsyncioTestCase):
    def observer(self):
        return Observer(SimpleNamespace(prometheus_url='http://prometheus:9090', loki_url='http://loki:3100'))

    async def test_timestamp_function_value_is_used_instead_of_evaluation_time(self):
        result = await self.observer().collect(HostClient(age=200), end=1000)
        host = result['resources']['items'][0]
        self.assertEqual(host['last_collected_at'], datetime.fromtimestamp(800, timezone.utc).isoformat())
        self.assertEqual(host['status'], 'stale')
        self.assertIsNone(host['cpu'])

    async def test_metadata_failure_preserves_valid_metrics_but_not_role_claim(self):
        result = await self.observer().collect(HostClient(metadata_fail=True), end=1000)
        resources = result['resources']
        self.assertEqual(resources['metadata_status'], 'unavailable')
        self.assertEqual(resources['source_status'], 'ok')
        self.assertEqual(resources['status'], 'partial')
        self.assertEqual(resources['items'][0]['cpu'], 30)
        self.assertEqual(resources['items'][0]['server_role'], 'unknown')
        self.assertTrue(all(h['status']=='unavailable' for h in resources['items'][1:]))

    async def test_source_failure_keeps_known_role_as_unavailable(self):
        result = await self.observer().collect(HostClient(source_fail=True), end=1000)
        resources = result['resources']
        self.assertEqual(resources['source_status'], 'unavailable')
        self.assertEqual(resources['metadata_status'], 'ok')
        self.assertTrue(all(h['status']=='unavailable' for h in resources['items']))

    async def test_cpu_failure_does_not_hide_memory_or_report_cpu_as_no_data(self):
        result = await self.observer().collect(HostClient(cpu_fail=True), end=1000)
        resources = result['resources']; host = resources['items'][0]
        self.assertEqual(resources['status'], 'partial')
        self.assertEqual(resources['metric_status']['cpu'], 'unavailable')
        self.assertEqual(host['history']['cpu']['status'], 'unavailable')
        self.assertIsNone(host['cpu'])
        self.assertEqual(host['memory'], 30)

    async def test_historical_freshness_is_relative_to_selected_end(self):
        with patch('management.observability.time.time', return_value=1800000000):
            result = await self.observer().collect(HostClient(), window='custom',
                start=datetime.fromtimestamp(1799992800, timezone.utc).isoformat(),
                end=datetime.fromtimestamp(1799996400, timezone.utc).isoformat())
        host = result['resources']['items'][0]
        self.assertEqual(host['status'], 'ok')
        self.assertEqual(host['last_collected_at'], datetime.fromtimestamp(1799996395, timezone.utc).isoformat())

    def test_invalid_timestamp_does_not_crash_datetime(self):
        for value in ['NaN', 'Inf', '1e100', None]:
            self.assertEqual(source_time(value), (None, None))
