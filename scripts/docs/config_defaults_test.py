"""Static default contracts: parse source only; do not import app or read environment."""
import ast
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]


def source(name):
    return (ROOT / name).read_text(encoding='utf-8')


def assignment(filename, name):
    tree = ast.parse(source(filename))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(x, ast.Name) and x.id == name for x in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f'missing assignment {name}')


class ConfigurationDefaults(unittest.TestCase):
    def test_sync_intervals(self):
        tree = ast.parse(source('services/api/run_backend.py'))
        values = {}
        for node in tree.body:
            if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id in ('SYNC_INTERVAL_SEC', 'RECONCILE_INTERVAL_SEC'):
                call = node.value.args[0]
                values[node.targets[0].id] = ast.literal_eval(call.args[1])
        self.assertEqual(values, {'SYNC_INTERVAL_SEC': 300, 'RECONCILE_INTERVAL_SEC': 21600})

    def test_worker_and_context_limits(self):
        self.assertEqual(assignment('services/api/azure_client.py', 'DEFAULT_DETAIL_WORKERS'), 1)
        self.assertEqual(assignment('services/api/azure_client.py', 'MAX_DETAIL_WORKERS'), 8)
        self.assertEqual(assignment('services/api/sync_service.py', 'MAX_CONTEXT_ITEMS'), 25000)

    def test_opt_in_and_metrics_defaults(self):
        self.assertRegex(source('services/api/sync_staging.py'), r"os\.environ\.get\('SYNC_CHUNKED',\s*''\)\.strip\(\)\s*==\s*'1'")
        self.assertRegex(source('services/api/observability.py'), r"os\.environ\.get\('OBSERVABILITY_METRICS_ENABLED',\s*'1'\)")
        self.assertRegex(source('services/api/feature_context.py'), r"os\.environ\.get\('DEVOPS_FIXTURE_MODE'\)\s*==\s*'1'")

    def test_compose_defaults(self):
        compose = source('docker-compose.yml')
        for expected in ('${DEVOPS_FIXTURE_MODE:-1}', '${WEB_PORT:-5174}', '${PROMETHEUS_STORAGE_LIMIT:-2GB}'):
            self.assertIn(expected, compose)

if __name__ == '__main__':
    unittest.main()
