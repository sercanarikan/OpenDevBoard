"""Static regression checks for the opt-in monitoring stack."""
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OBS = ROOT / 'observability'


class OptionalObservabilityStackTests(unittest.TestCase):
    def test_default_compose_project_name_and_services_are_preserved(self):
        compose = (ROOT / 'docker-compose.yml').read_text(encoding='utf-8')
        self.assertRegex(compose, r'(?m)^name: opendevboard$')
        services = re.search(r'(?ms)^services:\n(.*?)(?=^secrets:|^volumes:)', compose)
        self.assertIsNotNone(services)
        service_names = re.findall(r'(?m)^  ([a-zA-Z0-9_-]+):$', services.group(1))
        self.assertEqual(service_names, ['api', 'web', 'prometheus', 'grafana'])
        self.assertIn('profiles: ["observability"]', services.group(1))

    def test_compose_stack_is_opt_in_private_and_persistent(self):
        compose = (ROOT / 'docker-compose.yml').read_text(encoding='utf-8')
        prometheus = re.search(r'(?ms)^  prometheus:\n(.*?)(?=^  [a-zA-Z0-9_-]+:|^volumes:)', compose)
        grafana = re.search(r'(?ms)^  grafana:\n(.*?)(?=^  [a-zA-Z0-9_-]+:|^volumes:)', compose)
        self.assertIsNotNone(prometheus)
        self.assertIsNotNone(grafana)
        self.assertIn('profiles: ["observability"]', prometheus.group(1))
        self.assertIn('profiles: ["observability"]', grafana.group(1))
        self.assertRegex(prometheus.group(1), r'image: prom/prometheus:v[0-9]+\.[0-9]+\.[0-9]+')
        self.assertRegex(grafana.group(1), r'image: grafana/grafana:[0-9]+\.[0-9]+\.[0-9]+')
        self.assertNotRegex(prometheus.group(1), r'(?m)^\s+ports:')
        self.assertRegex(grafana.group(1), r'127\.0\.0\.1:\$\{GRAFANA_PORT')
        self.assertIn('GF_SECURITY_ADMIN_PASSWORD__FILE', grafana.group(1))
        self.assertIn('test -s /run/secrets/grafana_admin_password', grafana.group(1))
        self.assertIn('GF_AUTH_ANONYMOUS_ENABLED: "false"', grafana.group(1))
        self.assertIn('GF_ANALYTICS_REPORTING_ENABLED: "false"', grafana.group(1))
        self.assertIn('GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: "false"', grafana.group(1))
        self.assertIn('devopsflow_network', prometheus.group(1))
        self.assertIn('observability_network', prometheus.group(1))
        self.assertIn('observability_network', grafana.group(1))
        self.assertRegex(compose, r'(?m)^  prometheus_data:$')
        self.assertRegex(compose, r'(?m)^  grafana_data:$')
        self.assertIn('restart: unless-stopped', prometheus.group(1))
        self.assertIn('restart: unless-stopped', grafana.group(1))

    def test_prometheus_scrapes_internal_api_and_has_storage_limits(self):
        config = (OBS / 'prometheus' / 'prometheus.yml').read_text(encoding='utf-8')
        self.assertIn('api:5000', config)
        self.assertIn('/metrics', config)
        compose = (ROOT / 'docker-compose.yml').read_text(encoding='utf-8')
        self.assertIn('--storage.tsdb.retention.time=14d', compose)
        self.assertIn('--storage.tsdb.retention.size=${PROMETHEUS_STORAGE_LIMIT:-2GB}', compose)
        rules = (OBS / 'prometheus' / 'alert-rules.yml').read_text(encoding='utf-8')
        for name in ('MetricsTargetUnavailable', 'NoRecentSuccessfulSync', 'SyncErrorsIncreasing',
                     'SyncContinuouslyPartial', 'AzureHttp429Increasing', 'HighProcessMemory'):
            self.assertIn(name, rules)
        self.assertRegex(rules, r'last_successful_sync_timestamp_seconds[^\n]*> 0')
        self.assertNotIn('alertmanager', config.lower())
        rule_tests = (OBS / 'prometheus' / 'alert-rules.test.yml').read_text(encoding='utf-8')
        for name in ('MetricsTargetUnavailable', 'NoRecentSuccessfulSync', 'SyncErrorsIncreasing',
                     'SyncContinuouslyPartial', 'AzureHttp429Increasing', 'HighProcessMemory'):
            self.assertIn(f'alertname: {name}', rule_tests)

    def test_grafana_provisions_three_dashboards_and_private_prometheus_source(self):
        datasource = (OBS / 'grafana' / 'provisioning' / 'datasources' / 'prometheus.yml').read_text(encoding='utf-8')
        self.assertIn('http://prometheus:9090', datasource)
        provisioner = (OBS / 'grafana' / 'provisioning' / 'dashboards' / 'dashboards.yml').read_text(encoding='utf-8')
        self.assertIn('/var/lib/grafana/dashboards', provisioner)
        dashboard_dir = OBS / 'grafana' / 'dashboards'
        dashboards = sorted(dashboard_dir.glob('*.json'))
        self.assertEqual({path.stem for path in dashboards}, {'sync-overview', 'azure-devops-http', 'performance'})
        allowed_metrics = {
            'opendevboard_sync_runs_total', 'opendevboard_sync_duration_seconds',
            'opendevboard_sync_duration_seconds_bucket', 'opendevboard_sync_phase_duration_seconds_bucket',
            'opendevboard_scheduler_backoff_seconds', 'opendevboard_closure_dirty',
            'opendevboard_last_successful_sync_timestamp_seconds', 'opendevboard_http_attempts_total',
            'opendevboard_http_retries_total', 'opendevboard_http_results_total',
            'opendevboard_wiql_calls_total', 'opendevboard_process_rss_bytes',
            'opendevboard_process_peak_rss_bytes', 'opendevboard_sync_peak_rss_bytes',
            'opendevboard_process_cpu_seconds_total', 'opendevboard_sync_cpu_seconds_bucket',
            'opendevboard_work_items_processed_total', 'opendevboard_context_items_processed_total',
        }
        for path in dashboards:
            data = json.loads(path.read_text(encoding='utf-8'))
            serialized = json.dumps(data)
            self.assertFalse(re.search(r'(?i)(?:https://dev\.azure\.com|PAT\s*=|work item id|assignedTo)', serialized))
            queries = re.findall(r'"expr"\s*:\s*"((?:[^"\\]|\\.)*)"', serialized)
            self.assertTrue(queries, path.name)
            for query in queries:
                for metric in re.findall(r'opendevboard_[a-zA-Z0-9_]+', query):
                    self.assertIn(metric, allowed_metrics, (path.name, metric))

    def test_http_error_rate_covers_failure_labels_and_matches_result_fixture(self):
        dashboard = json.loads((OBS / 'grafana' / 'dashboards' / 'azure-devops-http.json').read_text(encoding='utf-8'))
        panel = next(panel for panel in dashboard['panels'] if panel['title'] == 'HTTP error rate / attempt')
        dashboard_expr = panel['targets'][0]['expr'].replace('$__rate_interval', '5m')
        rule_test = (OBS / 'prometheus' / 'dashboard-http-error-rate.test.yml').read_text(encoding='utf-8')
        match = re.search(r"(?m)^\s*- expr: '(.+)'$", rule_test)
        self.assertIsNotNone(match)
        self.assertEqual(dashboard_expr, match.group(1))
        for category in ('429', '503', '4xx', '5xx', 'network', 'other'):
            self.assertIn(category, dashboard_expr)
        self.assertNotIn('result="2xx"', dashboard_expr)
        self.assertIn('opendevboard_http_attempts_total', dashboard_expr)
        self.assertRegex(rule_test, r'(?m)^\s*value: 0\.04$')


if __name__ == '__main__':
    unittest.main()
