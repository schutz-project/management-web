import asyncio
import unittest
from types import SimpleNamespace

from management.observability import Observer


class Response:
    def __init__(self, data):
        self.data = data

    def raise_for_status(self):
        return None

    def json(self):
        return self.data


class Client:
    def __init__(self, fail_proxy=False):
        self.fail_proxy = fail_proxy

    async def get(self, url, params):
        query = params["query"]
        if self.fail_proxy and "unwrap request_time" in query:
            raise TimeoutError("simulated")
        if "/loki/" in url:
            if "rate(" in query or "quantile_over_time" in query:
                result = [{"metric": {"route": "/health"}, "values": [[985, "0.2"], [995, "0.4"]]},
                          {"metric": {"route": "/private-path"}, "values": [[995, "9"]]}]
            else:
                result = []
        elif query.startswith("max(timestamp("):
            result = [{"metric": {}, "value": [1000, "995"]}]
        elif query.startswith("max by (instance) (timestamp("):
            result = [{"metric": {"instance": "service:9100"}, "value": [1000, "995"]}]
        elif query == 'ALERTS{alertstate="firing"}':
            result = [{"metric": {"alertname": "PortalProbeFailed", "severity": "critical",
                                   "alertstate": "firing"}, "value": [1000, "1"]}]
        elif query == "up":
            result = [{"metric": {"job": "ec2-node", "instance": "service:9100"}, "value": [1000, "1"]},
                      {"metric": {"job": "private-job", "instance": "secret"}, "value": [1000, "0"]}]
        elif "start" in params:
            result = [{"metric": {"http_route": "/health"}, "values": [[985, "1"], [995, "2"]]}]
        else:
            result = []
        return Response({"status": "success", "data": {"result": result}})


class ObservabilityParityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.observer = Observer(SimpleNamespace(prometheus_url="http://prometheus:9090",
                                                  loki_url="http://loki:3100"))

    async def test_bounded_route_alert_and_target_results(self):
        snapshot = await self.observer.collect(Client(), end=1000)
        self.assertEqual(snapshot["details"]["proxy_requests"]["status"], "ok")
        self.assertEqual({item["route"] for item in snapshot["details"]["proxy_requests"]["items"]},
                         {"/health", "other"})
        self.assertEqual(snapshot["alerts"]["items"][0]["name"], "PortalProbeFailed")
        self.assertEqual([item["job"] for item in snapshot["targets"]["items"]], ["ec2-node"])

    async def test_one_failed_query_does_not_hide_other_panels(self):
        snapshot = await self.observer.collect(Client(fail_proxy=True), end=1000)
        self.assertEqual(snapshot["details"]["proxy_p95"]["status"], "unavailable")
        self.assertEqual(snapshot["details"]["proxy_requests"]["status"], "ok")
        self.assertEqual(snapshot["alerts"]["status"], "ok")


if __name__ == "__main__":
    unittest.main()

