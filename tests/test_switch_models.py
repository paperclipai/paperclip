import importlib.util
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'packages/skills-catalog/catalog/optional/paperclip-operations/switch-agent-models/scripts/switch_models.py'
spec = importlib.util.spec_from_file_location('switch_models', SCRIPT)
switch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(switch)

class SwitchModelsTests(unittest.TestCase):
    def setUp(self):
        self.args = SimpleNamespace(connection_model='vendor/new(high)', model=None, drop_suffix=False)
        self.catalog = [dict(id='bound', kind='openrouter', models={'vendor/old'}), dict(id='other', kind='gateway', models={'vendor/new'})]

    def agent(self, harness='opencode_local'):
        return dict(id='a', name='A', adapterType=harness, adapterConfig={'model': 'openrouter/vendor/old(high)'}, runtimeConfig={'aiConnection': {'connectionId': 'bound'}})

    def test_bound_route_does_not_depend_on_target_membership(self):
        model, note = switch.target_model(self.agent(), self.args, self.catalog)
        self.assertEqual(model, 'openrouter/vendor/new(high)')
        self.assertFalse(switch.validate(self.agent(), model, self.catalog, None)[0])

    def test_pi_openrouter_prefix(self):
        self.assertEqual(switch.target_model(self.agent('pi_local'), self.args, self.catalog)[0], 'openrouter/vendor/new(high)')

    def test_missing_bound_route_does_not_guess_other_connection(self):
        model, _ = switch.target_model(self.agent(), self.args, self.catalog[1:])
        self.assertIsNone(model)

    def test_suffix_lookup_and_idempotence(self):
        self.catalog[0]['models'].add('vendor/new')
        model, _ = switch.target_model(self.agent(), self.args, self.catalog)
        self.assertTrue(switch.validate(self.agent(), model, self.catalog, None)[0])
        self.assertEqual(model.count('(high)'), 1)

    def test_native_openrouter_connection_and_responsible_user(self):
        for mode in ('shared', 'responsible_user'):
            for harness in ('opencode_local', 'pi_local'):
                with self.subTest(mode=mode, harness=harness):
                    agent = self.agent(harness)
                    agent['runtimeConfig']['aiConnection'] = {'provider': 'openrouter', 'method': 'api_key', 'mode': mode}
                    if mode == 'shared':
                        agent['runtimeConfig']['aiConnection']['connectionId'] = 'bound'
                    response = {'connections': [{'id': 'bound', 'provider': 'openrouter', 'method': 'api_key'}]}
                    with patch.object(switch, 'request', return_value=(200, response)):
                        catalog = switch.connection_catalog('c')
                    self.assertEqual(switch.target_model(agent, self.args, catalog)[0], 'openrouter/vendor/new(high)')

    def test_upstream_openrouter_auto_is_not_a_transport_prefix(self):
        self.args.connection_model = 'openrouter/auto'
        self.catalog[0]['models'] = {'openrouter/auto'}
        for harness, expected in [('codex_local', 'openrouter/auto(high)'), ('claude_local', 'openrouter/auto(high)'), ('opencode_local', 'openrouter/openrouter/auto(high)'), ('pi_local', 'openrouter/openrouter/auto(high)')]:
            with self.subTest(harness=harness):
                agent = self.agent(harness)
                model, _ = switch.target_model(agent, self.args, self.catalog)
                self.assertEqual(model, expected)
                self.assertTrue(switch.validate(agent, model, self.catalog, None)[0])

    def test_responsible_user_unknown_route_is_not_guessed(self):
        agent = self.agent()
        agent['runtimeConfig']['aiConnection'] = {'provider': 'openai', 'method': 'api_key', 'mode': 'responsible_user'}
        self.assertIsNone(switch.target_model(agent, self.args, self.catalog)[0])

    def test_responsible_user_pi_uses_the_binding_provider(self):
        # isAiConnectionCompatible() requires <provider>/<id> for Pi even when the
        # binding names no connection, so a responsible-user default is resolvable.
        for provider in ('openai', 'anthropic', 'google'):
            with self.subTest(provider=provider):
                agent = self.agent('pi_local')
                agent['runtimeConfig']['aiConnection'] = {'provider': provider, 'method': 'api_key', 'mode': 'responsible_user'}
                model, note = switch.target_model(agent, self.args, [])
                self.assertEqual((model, note), (f'{provider}/vendor/new(high)', ''))

    def test_native_opencode_without_a_route_is_not_guessed(self):
        agent = self.agent()
        agent['runtimeConfig']['aiConnection'] = {'provider': 'openai', 'method': 'api_key', 'mode': 'shared', 'connectionId': 'bound'}
        catalog = [{'id': 'bound', 'provider': 'openai', 'kind': None, 'models': {'vendor/new'}}]
        self.assertIsNone(switch.target_model(agent, self.args, catalog)[0])

    def test_force_does_not_guess_an_unknown_route(self):
        agent = self.agent()
        agent['runtimeConfig']['aiConnection'] = {'provider': 'openai', 'method': 'api_key', 'mode': 'responsible_user'}
        args = SimpleNamespace(company='c', all=True, select=None, model=None, connection_model='vendor/new', drop_suffix=True, force=True)
        with patch.object(switch, 'company_from', return_value={'id': 'c'}), patch.object(switch, 'list_agents', return_value=[agent]), patch.object(switch, 'connection_catalog', return_value=self.catalog), patch.object(switch, 'gateway_model_ids', return_value=None):
            _, rows, entries = switch.build_plan(args)
        self.assertFalse(entries[0]['ok'])
        self.assertEqual(rows[0]['validation'], 'cannot determine bound connection route')

    def test_gateway_keeps_upstream_openrouter_model_id(self):
        self.args.connection_model = 'openrouter/auto'
        catalog = [{'id': 'bound', 'kind': 'gateway', 'models': {'openrouter/auto'}}]
        agent = self.agent()
        model, _ = switch.target_model(agent, self.args, catalog)
        self.assertEqual(model, 'paperclip/openrouter/auto(high)')
        self.assertTrue(switch.validate(agent, model, catalog, None)[0])

    def test_non_openrouter_routing_does_not_apply_native_pi_prefix(self):
        agent = self.agent('pi_local')
        agent['runtimeConfig']['aiConnection']['provider'] = 'openai'
        catalog = [{'id': 'bound', 'provider': 'openai', 'kind': 'gateway', 'models': set()}]
        self.assertEqual(switch.model_prefix(agent, catalog), '')

    def test_native_pi_non_openrouter_uses_provider_prefix(self):
        agent = self.agent('pi_local')
        agent['runtimeConfig']['aiConnection']['provider'] = 'google'
        catalog = [{'id': 'bound', 'provider': 'google', 'kind': None, 'models': set()}]
        self.assertEqual(switch.target_model(agent, self.args, catalog)[0], 'google/vendor/new(high)')

    def test_uuid_does_not_list_companies(self):
        with patch.object(switch, 'list_companies', side_effect=AssertionError('listed')):
            self.assertEqual(switch.resolve_company('01234567-0123-0123-0123-0123456789ab')['id'], '01234567-0123-0123-0123-0123456789ab')

    def test_snapshot_unique_private_and_atomic_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'snapshot.json')
            first = switch.create_snapshot(path, {'v': 1})
            second = switch.create_snapshot(path, {'v': 2})
            self.assertNotEqual(first, second)
            self.assertEqual(stat.S_IMODE(os.stat(first).st_mode), 0o600)
            with patch.object(switch.os, 'replace', side_effect=OSError('failed')):
                with self.assertRaises(OSError):
                    switch.write_snapshot(first, {'v': 3})
            with open(first) as f:
                self.assertEqual(json.load(f), {'v': 1})

    def test_rollback_detects_normalized_null(self):
        snapshot = {'agents': [{'id': 'a', 'name': 'A', 'before': None, 'after': 'new', 'applied': True}], 'companyId': 'c'}
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 's.json')
            with open(path, 'w') as f: json.dump(snapshot, f)
            with patch.object(switch, 'list_agents', return_value=[{'id':'a', 'adapterConfig': {'model':'new'}}]), patch.object(switch, 'request', return_value=(200, {'adapterConfig': {'model': 'default'}})):
                self.assertEqual(switch.cmd_rollback(SimpleNamespace(snapshot=path, yes=True)), 2)

    def test_rollback_rejects_a_different_api_instance(self):
        snapshot = {'apiUrl': 'https://original.example', 'companyId': 'c', 'agents': []}
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 's.json')
            with open(path, 'w') as f: json.dump(snapshot, f)
            with patch.object(switch, 'api_base', return_value='https://other.example'), patch.object(switch, 'list_agents') as list_agents:
                with self.assertRaises(SystemExit):
                    switch.cmd_rollback(SimpleNamespace(snapshot=path, yes=True))
                list_agents.assert_not_called()

    def test_rollback_does_not_overwrite_later_changes(self):
        snapshot = {'agents': [{'id':'a', 'name':'A', 'before':'old', 'after':'new', 'applied':True}], 'companyId':'c'}
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 's.json')
            with open(path, 'w') as f: json.dump(snapshot, f)
            with patch.object(switch, 'list_agents', return_value=[{'id':'a','adapterConfig':{'model':'later'}}]), patch.object(switch, 'request') as request:
                self.assertEqual(switch.cmd_rollback(SimpleNamespace(snapshot=path, yes=True)), 2)
                request.assert_not_called()

if __name__ == '__main__': unittest.main()
