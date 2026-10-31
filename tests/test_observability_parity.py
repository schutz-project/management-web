import asyncio
import unittest
from types import SimpleNamespace

from management.observability import Observer, RESOURCE, WINDOWS, point_summary, custom_bounds
from unittest.mock import AsyncMock, MagicMock, patch


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



class ResourceClient(Client):
    def __init__(self, stale=False):
        super().__init__()
        self.calls=[]
        self.stale=stale

    async def get(self,url,params):
        self.calls.append((url,params))
        if params["query"] in RESOURCE.values():
            if "start" in params:
                return Response({"status":"success","data":{"result":[
                    {"metric":{"instance":"service:9100"},"values":[
                        [params["start"],"10"],[params["end"]-30,"NaN"],[params["end"],"30"]]}]}})
            return Response({"status":"success","data":{"result":[
                {"metric":{"instance":"service:9100"},"value":[params["time"],"30"]}]}})
        response=await super().get(url,params)
        if self.stale and "timestamp(" in params["query"]:
            for row in response.data["data"]["result"]:
                row["value"][1]="800"
        return response


class TimeWindowTests(unittest.IsolatedAsyncioTestCase):
    def observer(self):
        return Observer(SimpleNamespace(prometheus_url="http://prometheus:9090",loki_url="http://loki:3100"))

    async def test_all_windows_bound_queries_and_keep_live_logs_separate(self):
        for window,(seconds,step) in WINDOWS.items():
            with self.subTest(window=window):
                client=ResourceClient()
                result=await self.observer().collect(client,end=1000,window=window)
                ranges=[params for url,params in client.calls if "step" in params]
                self.assertTrue(ranges)
                self.assertTrue(all(p["start"]==1000-seconds and p["end"]==1000 and p["step"]==step for p in ranges))
                self.assertLessEqual(seconds//step+1,300)
                self.assertEqual(result["window_minutes"],seconds//60)
                cpu=result["resources"]["items"][0]["history"]["cpu"]
                self.assertEqual(cpu["summary"],{"mean":20,"max":30,"samples":2})
                self.assertIsNone(cpu["points"][1][1])
                log_calls=[p for u,p in client.calls if p.get("query")=='{service="portal-api"}']
                self.assertEqual(log_calls[0]["start"],700*1_000_000_000)

    async def test_stale_source_keeps_history_but_not_a_fresh_value(self):
        result=await self.observer().collect(ResourceClient(stale=True),end=1000,window="1h")
        self.assertEqual(result["metrics"]["requests"]["status"],"stale")
        self.assertIsNone(result["metrics"]["requests"]["value"])
        self.assertTrue(result["metrics"]["requests"]["points"])
        host=result["resources"]["items"][0]
        self.assertEqual(host["status"],"stale")
        self.assertIsNone(host["cpu"])
        self.assertEqual(host["history"]["cpu"]["status"],"stale")

    async def test_cache_is_separate_for_each_window(self):
        observer=self.observer()
        observer.collect=AsyncMock(side_effect=[{"window":"15m"},{"window":"1h"}])
        manager=MagicMock()
        manager.__aenter__=AsyncMock()
        manager.__aexit__=AsyncMock(return_value=False)
        with patch("management.observability.httpx.AsyncClient",return_value=manager):
            first=await observer.snapshot("15m")
            second=await observer.snapshot("1h")
            cached=await observer.snapshot("15m")
        self.assertEqual(first,cached)
        self.assertNotEqual(first,second)
        self.assertEqual(observer.collect.await_count,2)

    async def test_invalid_window_is_rejected_before_querying(self):
        observer=self.observer()
        with self.assertRaisesRegex(ValueError,"INVALID_WINDOW"):
            await observer.collect(ResourceClient(),window="7d")
        with self.assertRaisesRegex(ValueError,"INVALID_WINDOW"):
            await observer.snapshot("7d")

    def test_empty_summary_does_not_invent_zero(self):
        self.assertEqual(point_summary([[1,None]]),{"mean":None,"max":None,"samples":0})

class CustomRangeTests(unittest.IsolatedAsyncioTestCase):
    def settings(self): return SimpleNamespace(prometheus_url="http://prometheus:9090",loki_url="http://loki:3100")

    async def test_bounds_and_timezone_validation(self):
        start="2026-10-25T10:00:00+09:00"
        end="2026-10-25T11:00:00+09:00"
        # Use an explicit test clock rather than the execution date.
        from datetime import datetime
        current=datetime.fromisoformat("2026-10-25T12:00:00+09:00").timestamp()
        a,b,step=custom_bounds(start,end,now=current)
        self.assertEqual(b-a,3600)
        self.assertLessEqual(int((b-a)//step)+1,300)
        for x,y in [(end,start),(start,"2026-10-27T11:00:00+09:00"),("2026-10-01T10:00:00+09:00",end),("2026-10-25T10:00:00",end),(None,end),(start,"2026-10-25T13:00:00+09:00")]:
            with self.subTest(x=x,y=y),self.assertRaises(ValueError): custom_bounds(x,y,now=current)

    async def test_historical_metrics_keep_alerts_targets_and_logs_current(self):
        from datetime import datetime
        current=datetime.fromisoformat("2026-10-25T12:00:00+09:00").timestamp()
        client=ResourceClient()
        with patch("management.observability.time.time",return_value=current):
            result=await Observer(self.settings()).collect(client,window="custom",start="2026-10-25T10:00:00+09:00",end="2026-10-25T11:00:00+09:00")
        self.assertTrue(result["historical"])
        for url,p in client.calls:
            if "step" in p:
                self.assertEqual(p["end"],current-3600)
                self.assertLessEqual(int((p["end"]-p["start"])//p["step"])+1,300)
            if p["query"] in ['up','ALERTS{alertstate="firing"}']: self.assertEqual(p["time"],current)
            if p["query"]=='{service="portal-api"}': self.assertEqual(p["end"],int(current*1e9))

    async def test_custom_cache_is_bounded_and_distinguishes_ranges(self):
        from datetime import datetime
        current=datetime.fromisoformat("2026-10-25T12:00:00+09:00").timestamp()
        observer=Observer(self.settings());observer.collect=AsyncMock(return_value={"historical":True})
        manager=MagicMock();manager.__aenter__=AsyncMock();manager.__aexit__=AsyncMock(return_value=False)
        with patch("management.observability.time.time",return_value=current),patch("management.observability.httpx.AsyncClient",return_value=manager):
            for hour in [10,10,9]:
                await observer.snapshot(window="custom",start=f"2026-10-25T{hour:02}:00:00+09:00",end="2026-10-25T11:00:00+09:00")
        self.assertEqual(observer.collect.await_count,2)
        self.assertEqual(len(observer.cache),1)

    def test_retired_blackbox_job_is_not_visible(self):
        from management.observability import VISIBLE_JOBS
        self.assertNotIn('blackbox-exporter', VISIBLE_JOBS)
        self.assertTrue({'portal-otel', 'portal-health', 'portal-db-health', 'ec2-node'} <= VISIBLE_JOBS)

if __name__ == "__main__":
    unittest.main()
