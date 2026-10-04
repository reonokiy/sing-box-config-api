import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sync', Path(__file__).parents[1] / 'agent/sync.py')
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.config = self.directory / 'config.json'
        self.path_patch = patch.object(agent, 'CONFIG_PATH', self.config)
        self.path_patch.start()
        self.settings = {'url':'https://example.com/sing-box','id':'edge-01'}
        self.old = {'log':{'level':'info'},'inbounds':[]}
        self.new = {'log':{'level':'warn'},'inbounds':[]}
        agent.atomic(self.config,agent.encode(self.old))
        self.state = self.directory / 'applied.json'
        agent.atomic(self.state,agent.encode({'version':1,'enabled':True,'etag':'"'+hashlib.sha256(agent.encode(self.old)).hexdigest()+'"'}))
        self.desired = {'version':2,'enabled':True,'config':self.new,'hash':hashlib.sha256(agent.encode(self.new)).hexdigest()}
        self.reports = []
    def tearDown(self):
        self.path_patch.stop()
        self.temp.cleanup()
    def request(self,settings,path,body=None,etag=None):
        if path == 'status':
            self.reports.append(body)
            return 200,{},{}
        return 200,{'ETag':'"'+self.desired['hash']+'"'},self.desired
    def run_sync(self,valid=True,operations=None,health=True):
        with patch.object(agent,'request',side_effect=self.request), patch.object(agent.subprocess,'run',return_value=subprocess.CompletedProcess([],0 if valid else 1)), patch.object(agent,'healthy',return_value=health), patch.object(agent,'service',side_effect=operations) as service:
            agent.sync(self.settings,self.directory)
            return service
    def test_apply_commits_config_and_reports_actual_version(self):
        service=self.run_sync()
        self.assertEqual(service.call_args.args,('restart',))
        self.assertEqual(json.loads(self.config.read_text()),self.new)
        self.assertEqual(json.loads(self.state.read_text())['version'],2)
        self.assertEqual(self.reports[-1],{'version':2,'runningVersion':2,'status':'applied'})
        self.assertEqual(self.config.stat().st_mode & 0o777,0o600)
    def test_invalid_config_retains_old_file_and_running_version(self):
        service=self.run_sync(valid=False)
        self.assertFalse(service.called)
        self.assertEqual(json.loads(self.config.read_text()),self.old)
        self.assertEqual(self.reports[-1],{'version':2,'runningVersion':1,'status':'failed_validation'})
        service=self.run_sync()
        self.assertFalse(service.called)
        self.assertEqual(self.reports[-1]['status'],'failed_validation')
    def test_failed_start_rolls_back_and_keeps_old_state(self):
        service=self.run_sync(operations=[RuntimeError('synthetic failure'),None])
        self.assertEqual(service.call_count,2)
        self.assertEqual(json.loads(self.config.read_text()),self.old)
        self.assertEqual(json.loads(self.state.read_text())['version'],1)
        self.assertEqual(self.reports[-1],{'version':2,'runningVersion':1,'status':'failed_start'})
    def test_failed_rollback_is_reported_without_claiming_running_version(self):
        self.run_sync(operations=[RuntimeError(),RuntimeError()])
        self.assertEqual(self.reports[-1],{'version':2,'runningVersion':0,'status':'failed_rollback'})
    def test_disabled_policy_stops_service(self):
        self.desired['enabled']=False
        service=self.run_sync()
        self.assertEqual(service.call_args.args,('stop',))
        self.assertEqual(self.reports[-1],{'version':2,'runningVersion':0,'status':'stopped'})
    def test_hash_mismatch_does_not_replace_config(self):
        self.desired['hash']='0'*64
        with self.assertRaises(ValueError):
            self.run_sync()
        self.assertEqual(json.loads(self.config.read_text()),self.old)
    def test_304_advances_identical_config_version_and_reports_it(self):
        def response(settings,path,body=None,etag=None):
            if path=='status': return self.request(settings,path,body,etag)
            self.assertIsNotNone(etag)
            return 304,{'X-Config-Version':'3'},None
        with patch.object(agent,'request',side_effect=response),patch.object(agent,'healthy',return_value=True):agent.sync(self.settings,self.directory)
        self.assertEqual(json.loads(self.state.read_text())['version'],3)
        self.assertEqual(self.reports[-1],{'version':3,'runningVersion':3,'status':'applied'})
    def test_local_file_damage_forces_redownload(self):
        agent.atomic(self.config,b'{}')
        def response(settings,path,body=None,etag=None):
            if path=='config':self.assertIsNone(etag)
            return self.request(settings,path,body,etag)
        with patch.object(agent,'request',side_effect=response),patch.object(agent.subprocess,'run',return_value=subprocess.CompletedProcess([],0)),patch.object(agent,'healthy',return_value=True),patch.object(agent,'service'):agent.sync(self.settings,self.directory)
        self.assertEqual(json.loads(self.config.read_text()),self.new)
    def test_url_validation_rejects_plaintext_and_credentials_in_urls(self):
        for url in ['http://example.com','https://example.com?api_key=synthetic','https://user:synthetic@example.com','https://example.com/#fragment']:
            with self.assertRaises(ValueError):agent.validate_url(url)

if __name__=='__main__':unittest.main()
