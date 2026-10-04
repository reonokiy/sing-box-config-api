import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / 'agent'))
spec = importlib.util.spec_from_file_location('docker_agent', Path(__file__).parents[1] / 'agent/container.py')
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

class DockerOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'PROXY_DATA_VOLUME': 'test-volume'})
        self.env.start()
        self.docker_patch = patch.object(agent, 'Docker')
        self.client = self.docker_patch.start().return_value
        self.client.request.side_effect = lambda method,path,*args,**kw: [] if path.startswith('/containers/json?') else {'Labels': {'io.nokiy.managed-proxy.id': 'test-machine'}}
        self.runtime = agent.Runtime('test-machine', Path(self.temp.name))

    def tearDown(self):
        self.docker_patch.stop()
        self.env.stop()
        self.temp.cleanup()

    def test_foreign_container_is_never_stopped_or_adopted(self):
        self.client.request.reset_mock()
        self.client.request.side_effect = None
        self.client.request.return_value = {'Config': {'Labels': {}}, 'State': {'Running': True}}
        with self.assertRaises(RuntimeError):
            self.runtime.service('stop')
        self.assertEqual(self.client.request.call_count, 1)
        self.assertEqual(self.client.request.call_args.args[0], 'GET')

    def test_foreign_volume_is_rejected(self):
        self.client.request.side_effect = None
        self.client.request.return_value = {'Labels': {'io.nokiy.managed-proxy.id': 'another-machine'}}
        with self.assertRaises(RuntimeError):
            agent.Runtime('test-machine', Path(self.temp.name))

    def test_checker_is_isolated_and_neither_proxy_nor_checker_receives_agent_files(self):
        for checking in [False, True]:
            config = self.runtime.host_config(checking)
            self.assertEqual(config['Mounts'][0]['VolumeOptions']['Subpath'], 'proxy')
            self.assertNotIn('docker.sock', str(config))
            self.assertTrue(config['ReadonlyRootfs'])
            self.assertEqual(config['CapDrop'], ['ALL'])
            if checking:
                self.assertEqual(config['NetworkMode'], 'none')
                self.assertTrue(config['Mounts'][0]['ReadOnly'])
                self.assertEqual(config['CapAdd'], [])

    def test_checker_rejects_path_outside_proxy_subdirectory(self):
        self.client.request.reset_mock()
        with self.assertRaises(ValueError):
            self.runtime.check(Path(self.temp.name) / 'settings.json')
        self.client.request.assert_not_called()

    def test_restart_loop_is_not_reported_as_healthy(self):
        first = {'State': {'Running': True, 'StartedAt': 'first'}, 'RestartCount': 0}
        second = {'State': {'Running': True, 'StartedAt': 'second'}, 'RestartCount': 1}
        with patch.object(self.runtime, 'inspect', side_effect=[first, second]), patch.object(agent.time, 'sleep'):
            self.assertFalse(self.runtime.healthy())

    def test_interrupted_replacement_restores_committed_file_even_with_proxy_running(self):
        agent.sync.atomic(self.runtime.root / 'applied.json', agent.sync.encode({'enabled': True, 'document': '{}\n'}))
        agent.sync.atomic(self.runtime.config_path, b'{"uncommitted":true}')
        with patch.object(self.runtime, 'inspect', return_value={'State': {'Running': True}}), patch.object(self.runtime, 'service') as service, patch.object(self.runtime, 'healthy', return_value=True):
            self.runtime.restore()
        self.assertEqual(self.runtime.config_path.read_bytes(), b'{}\n')
        service.assert_called_once_with('restart')

if __name__ == '__main__':
    unittest.main()
