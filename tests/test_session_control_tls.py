"""Real loopback TLS: certificate chain and IP matching must remain enforced."""
import json
import ssl
import subprocess
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from management.session_control import execute

class TLSControlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.root=Path(cls.temp.name)
        for name,ip in [('trusted','127.0.0.1'),('wrong-address','127.0.0.2'),('untrusted','127.0.0.1')]:
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes',
                '-keyout',str(cls.root/(name+'.key')),'-out',str(cls.root/(name+'.crt')),
                '-days','1','-subj','/CN=local-fixture','-addext','subjectAltName=IP:'+ip,
                '-addext','basicConstraints=critical,CA:FALSE','-addext','extendedKeyUsage=serverAuth'],
                check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def setUp(self):
        self.intent={'operation_id':'tls-op','incident_id':'tls-incident','account_ref':'test_user',
                     'test_run_id':'TLS-UNIT','actor_id':1}
        self.settings=SimpleNamespace(session_control_enabled=True,environment='test',
            session_control_secret='e'*32,app_secret='a'*32,proxy_secret='b'*32,
            test_context_secret='d'*32,internal_check_token='c'*32,session_control_ca_file='')
        self.requests=[]

    def request(self,certificate,trust):
        owner=self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length','0')))
                owner.requests.append({'path':self.path,'signed':bool(self.headers.get('X-Session-Control'))})
                payload={**owner.intent,'status':'succeeded','revoked_count':1,
                         'completed_at':datetime.now(timezone.utc).isoformat()}
                body=json.dumps(payload).encode()
                self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers()
                self.wfile.write(body)
            def log_message(self,*args):pass
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(self.root/(certificate+'.crt')),str(self.root/(certificate+'.key')))
        server.socket=context.wrap_socket(server.socket,server_side=True)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.settings.session_control_url='https://127.0.0.1:'+str(server.server_port)+'/internal/security/revoke-test-sessions'
        self.settings.session_control_ca_file=trust
        try:return execute(self.settings,self.intent)
        finally:server.shutdown();server.server_close();thread.join(timeout=5)

    def test_explicit_trust_and_matching_ip_sends_signed_request(self):
        result=self.request('trusted',str(self.root/'trusted.crt'))
        self.assertEqual(result['status'],'succeeded');self.assertEqual(result['revoked_count'],1)
        self.assertEqual(self.requests,[{'path':'/internal/security/revoke-test-sessions','signed':True}])

    def test_unknown_issuer_is_rejected_before_signed_request(self):
        result=self.request('untrusted',str(self.root/'trusted.crt'))
        self.assertEqual(result['status'],'unknown');self.assertEqual(self.requests,[])

    def test_trusted_certificate_with_wrong_ip_is_rejected(self):
        result=self.request('wrong-address',str(self.root/'wrong-address.crt'))
        self.assertEqual(result['status'],'unknown');self.assertEqual(self.requests,[])

    def test_default_public_trust_does_not_trust_self_signed_fixture(self):
        result=self.request('trusted','')
        self.assertEqual(result['status'],'unknown');self.assertEqual(self.requests,[])

    def test_invalid_trust_file_fails_before_creating_http_client(self):
        self.settings.session_control_url='https://service.invalid/internal/security/revoke-test-sessions'
        invalid=self.root/'invalid.pem';invalid.write_text('not a certificate')
        with patch('management.session_control.httpx.Client') as client:
            for path in ('relative.crt',str(self.root/'missing.crt'),str(invalid)):
                self.settings.session_control_ca_file=path
                self.assertEqual(execute(self.settings,self.intent),{'status':'failed','error_code':'CONTROL_TLS_CONFIG'})
            client.assert_not_called()
