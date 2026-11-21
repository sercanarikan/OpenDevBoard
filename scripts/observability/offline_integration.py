#!/usr/bin/env python3
"""Run an isolated, synthetic-only Prometheus/Grafana integration check."""
import base64
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / '.local' / 'observability-stack'
ENV_FILE = LOCAL / 'integration.env'
OVERRIDE = LOCAL / 'integration.compose.yml'
NO_SECRET_ENV = LOCAL / 'no-grafana-secret.env'


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def update_test_ports(grafana_port, web_port):
    values = dict(line.split('=', 1) for line in ENV_FILE.read_text(encoding='utf-8').splitlines())
    values['GRAFANA_PORT'] = str(grafana_port)
    values['WEB_PORT'] = str(web_port)
    ENV_FILE.write_text(''.join(f'{key}={value}\n' for key, value in values.items()), encoding='utf-8')
    ENV_FILE.chmod(0o600)


def request(url, username=None, password=None, expected_status=200):
    req = urllib.request.Request(url)
    if username is not None:
        token = base64.b64encode(f'{username}:{password}'.encode()).decode()
        req.add_header('Authorization', f'Basic {token}')
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            payload = response.read()
            status = response.status
    except urllib.error.HTTPError as exc:
        payload, status = exc.read(), exc.code
    if status != expected_status:
        raise AssertionError(f'{url} returned HTTP {status}, expected {expected_status}')
    return payload


def compose(project, *args, capture=False):
    cmd = ['docker', 'compose', '--env-file', str(ENV_FILE), '-p', project,
           '-f', 'docker-compose.yml', '-f', str(OVERRIDE.relative_to(ROOT)), *args]
    result = subprocess.run(cmd, cwd=ROOT, check=True, text=True, capture_output=capture)
    return result.stdout if capture else ''


def verify_grafana_secret_guard(project, empty=False):
    command = ['docker', 'compose', '--env-file', str(NO_SECRET_ENV), '-p', project,
               '-f', 'docker-compose.yml', '-f', str(OVERRIDE.relative_to(ROOT)),
               '--profile', 'observability', 'run', '--rm', '--no-deps', 'grafana']
    environment = os.environ.copy()
    environment.pop('GRAFANA_ADMIN_PASSWORD', None)
    if empty:
        environment['GRAFANA_ADMIN_PASSWORD'] = ''
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, env=environment)
    output = (result.stdout or '') + (result.stderr or '')
    safely_rejected = ('GRAFANA_ADMIN_PASSWORD is required' in output or
                       'environment variable "GRAFANA_ADMIN_PASSWORD" required' in output)
    if result.returncode == 0 or not safely_rejected:
        reason = 'empty' if empty else 'missing'
        raise AssertionError(f'Grafana missing/empty secret guard was not reached ({reason}, exit={result.returncode}): {output[-500:]}')


def wait_until(label, check, timeout=120):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except Exception as exc:  # expected during startup; details are kept out of logs
            last_error = exc
        time.sleep(2)
    raise RuntimeError(f'timed out waiting for {label}' + (f' ({type(last_error).__name__})' if last_error else ''))


def prom_json(project, path):
    url = 'http://127.0.0.1:9090' + path
    encoded = urllib.parse.quote(url, safe=':/?=&%')
    output = compose(project, 'exec', '-T', 'prometheus', 'wget', '-qO-', encoded, capture=True)
    return json.loads(output)


def prom_query(project, expression):
    path = '/api/v1/query?query=' + urllib.parse.quote(expression, safe='')
    payload = prom_json(project, path)
    if payload.get('status') != 'success':
        raise AssertionError('Prometheus instant query failed')
    return payload['data']['result']


def prom_targets(project):
    payload = prom_json(project, '/api/v1/targets')
    targets = payload.get('data', {}).get('activeTargets', [])
    if payload.get('status') == 'success' and any(target.get('health') == 'up' and
            target.get('labels', {}).get('job') == 'opendevboard-api' for target in targets):
        return targets
    return None


def service_health(project, service):
    output = compose(project, 'ps', '--format', 'json', capture=True)
    rows = [json.loads(line) for line in output.splitlines() if line.strip()]
    match = next((row for row in rows if row.get('Service') == service), None)
    return bool(match and 'healthy' in match.get('Status', '').lower())


def grafana_dashboards(url, username, password):
    rows = json.loads(request(url + '/api/search?type=dash-db', username, password))
    return rows if len(rows) >= 3 else None


def api_http_health(project):
    body = compose(project, 'exec', '-T', 'api', 'curl', '-fsS',
                   'http://127.0.0.1:5000/api/health', capture=True)
    return 'healthy' in body


def main():
    if shutil.which('docker') is None:
        raise RuntimeError('docker is required')
    LOCAL.mkdir(parents=True, exist_ok=True)
    password = secrets.token_urlsafe(32)
    grafana_port, web_port = free_port(), free_port()
    if grafana_port == web_port:
        web_port = free_port()
    ENV_FILE.write_text(
        f'GRAFANA_ADMIN_USER=synthetic-admin\n'
        f'GRAFANA_ADMIN_PASSWORD={password}\n'
        f'GRAFANA_PORT={grafana_port}\nWEB_PORT={web_port}\n'
        'PROMETHEUS_STORAGE_LIMIT=128MB\n', encoding='utf-8')
    ENV_FILE.chmod(0o600)
    NO_SECRET_ENV.write_text(f'GRAFANA_PORT={grafana_port}\nWEB_PORT={web_port}\n', encoding='utf-8')
    NO_SECRET_ENV.chmod(0o600)
    OVERRIDE.write_text('''services:\n  api:\n    env_file: !reset []\n    environment:\n      DEVOPS_FIXTURE_MODE: "0"\n      DEVOPS_DATA_DIR: /data\n      AZURE_DEVOPS_ORG_URL: https://dev.azure.com/synthetic\n      AZURE_DEVOPS_PAT: synthetic-unused\n      OBSERVABILITY_METRICS_ENABLED: "1"\n    command: ["python", "/tmp/observability_synthetic_api.py"]\n    volumes:\n      - type: bind\n        source: ./tests/observability/synthetic_api.py\n        target: /tmp/observability_synthetic_api.py\n        read_only: true\n''', encoding='utf-8')
    project = 'opendevboard-obs-' + secrets.token_hex(5)
    off_project = project + '-off'
    missing_secret_project = project + '-missing-secret'
    empty_secret_project = project + '-empty-secret'
    try:
        no_secret_config = subprocess.run(
            ['docker', 'compose', '--env-file', str(NO_SECRET_ENV), '-f', 'docker-compose.yml',
             '-f', str(OVERRIDE.relative_to(ROOT)), 'config', '--quiet'],
            cwd=ROOT, check=True, text=True, capture_output=True)
        assert no_secret_config.returncode == 0
        normal_project = subprocess.run(
            ['docker', 'compose', '--env-file', str(NO_SECRET_ENV), '-f', 'docker-compose.yml',
             '-f', str(OVERRIDE.relative_to(ROOT)), 'config', '--format', 'json'],
            cwd=ROOT, check=True, text=True, capture_output=True)
        assert json.loads(normal_project.stdout)['name'] == 'opendevboard'
        verify_grafana_secret_guard(missing_secret_project)
        verify_grafana_secret_guard(empty_secret_project, empty=True)
        # Explicit env file plus Compose !reset removes the repository .env service env_file
        # from both isolated projects. All Compose-created names are unique to these projects.
        off_config = json.loads(compose(off_project, 'config', '--format', 'json', capture=True))
        assert set(off_config['services']) == {'api', 'web'}, f'profile-off services were {sorted(off_config["services"])}'
        compose(off_project, 'up', '--build', '-d')
        wait_until('default API and web health', lambda: all(
            service_health(off_project, name) for name in ('api', 'web')))
        off_services = compose(off_project, 'ps', '--services', capture=True).split()
        assert set(off_services) == {'api', 'web'}, f'profile-off services were {off_services}'
        off_ids = compose(off_project, 'ps', '-q', 'api', 'web', capture=True).split()
        off_stats = subprocess.run(['docker', 'stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}} {{.CPUPerc}}'] + off_ids,
                                    cwd=ROOT, check=True, text=True, capture_output=True).stdout.strip().splitlines()
        compose(off_project, 'down', '--volumes', '--remove-orphans')

        compose(project, '--profile', 'observability', 'config', '--quiet')
        config = json.loads(compose(project, '--profile', 'observability', 'config', '--format', 'json', capture=True))
        services = config['services']
        assert 'ports' not in services['prometheus'] and 'ports' not in services['api']
        assert services['grafana']['ports'][0]['host_ip'] == '127.0.0.1'
        assert services['grafana']['environment']['GF_AUTH_ANONYMOUS_ENABLED'] == 'false'
        assert services['grafana']['environment']['GF_ANALYTICS_REPORTING_ENABLED'] == 'false'
        assert services['grafana']['environment']['GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES'] == 'false'
        assert services['grafana']['environment']['GF_SECURITY_ADMIN_PASSWORD__FILE'] == '/run/secrets/grafana_admin_password'
        assert services['grafana']['profiles'] == services['prometheus']['profiles'] == ['observability']
        assert config['volumes']['prometheus_data']['name'] != config['volumes']['grafana_data']['name']
        assert config['networks']['observability_network']['driver'] == 'bridge'
        # Docker Desktop can occasionally race while installing host-port forwarding; only retry that condition
        # with fresh loopback ports, preserving the same isolated project and containers.
        for attempt in range(4):
            try:
                compose(project, '--profile', 'observability', 'up', '--build', '-d',
                        'web', 'prometheus', 'grafana', capture=True)
                break
            except subprocess.CalledProcessError as exc:
                details = (exc.stderr or '') + (exc.stdout or '')
                if 'ports are not available' not in details or attempt == 3:
                    raise
                grafana_port, web_port = free_port(), free_port()
                if grafana_port == web_port:
                    web_port = free_port()
                update_test_ports(grafana_port, web_port)
        wait_until('service health', lambda: all(service_health(project, name) for name in ('api', 'web', 'prometheus', 'grafana')))
        network_name = config['networks']['observability_network']['name']
        network_data = json.loads(subprocess.run(['docker', 'network', 'inspect', network_name], cwd=ROOT,
                                                 check=True, text=True, capture_output=True).stdout)[0]
        attached = {container['Name'].rsplit('-', 2)[-2] for container in network_data['Containers'].values()}
        assert attached == {'grafana', 'prometheus'}, f'observability network services were {sorted(attached)}'

        grafana = f'http://127.0.0.1:{grafana_port}'
        wait_until('Grafana HTTP', lambda: request(grafana + '/api/health'))
        request(grafana + '/api/org', expected_status=401)
        admin = 'synthetic-admin'
        datasources = json.loads(request(grafana + '/api/datasources', admin, password))
        assert any(ds.get('uid') == 'opendevboard-prometheus' and ds.get('type') == 'prometheus' for ds in datasources)
        dashboard_rows = wait_until('provisioned dashboards', lambda: grafana_dashboards(grafana, admin, password))
        titles = {row['title'] for row in dashboard_rows}
        assert {'OpenDevBoard Sync Overview', 'OpenDevBoard Azure DevOps HTTP', 'OpenDevBoard Performance'} <= titles

        # Evaluate each provisioned dashboard query through Prometheus, substituting only Grafana's range macros.
        dashboard_dir = ROOT / 'observability' / 'grafana' / 'dashboards'
        for dashboard_path in dashboard_dir.glob('*.json'):
            dashboard = json.loads(dashboard_path.read_text(encoding='utf-8'))
            for panel in dashboard.get('panels', []):
                for target in panel.get('targets', []):
                    expression = target['expr'].replace('$__rate_interval', '1m').replace('$__range', '24h')
                    encoded = urllib.parse.quote(expression, safe='')
                    assert prom_json(project, '/api/v1/query?query=' + encoded).get('status') == 'success', (dashboard_path.name, panel['title'])

        targets = wait_until('Prometheus scrape target', lambda: prom_targets(project))
        assert any(t.get('health') == 'up' and t.get('labels', {}).get('job') == 'opendevboard-api' for t in targets)
        series = wait_until('synthetic sync metric series', lambda: prom_query(project, 'opendevboard_sync_runs_total{mode="full",status="success"}') or None)
        assert float(series[0]['value'][1]) >= 1

        rules = prom_json(project, '/api/v1/rules?type=alert')
        alert_names = {rule['name'] for group in rules.get('data', {}).get('groups', []) for rule in group.get('rules', [])}
        assert {'MetricsTargetUnavailable', 'NoRecentSuccessfulSync', 'SyncErrorsIncreasing',
                'SyncContinuouslyPartial', 'AzureHttp429Increasing', 'HighProcessMemory'} <= alert_names
        for path in ('/metrics', '/api/metrics'):
            request(f'http://127.0.0.1:{web_port}{path}', expected_status=404)
        metrics_text = compose(project, 'exec', '-T', 'api', 'curl', '-fsS', 'http://127.0.0.1:5000/metrics', capture=True)
        for sensitive in ('10001', 'Synthetic Project', 'Synthetic test item', 'https://dev.azure.com/synthetic', 'synthetic-only'):
            assert sensitive not in metrics_text, f'metric payload contained a synthetic sensitive value: {sensitive}'

        prom_before = prom_query(project, 'opendevboard_sync_runs_total{mode="full",status="success"}')
        assert prom_before
        # Stop the exporter so a post-restart query can only succeed from the persistent Prometheus volume.
        compose(project, 'stop', 'api')
        compose(project, 'restart', 'prometheus')
        wait_until('Prometheus restart health', lambda: service_health(project, 'prometheus'))
        after = wait_until('persisted Prometheus sample after restart while API is stopped',
                           lambda: prom_query(project, 'opendevboard_sync_runs_total{mode="full",status="success"}') or None)
        assert after and prom_before[0]['metric'] == after[0]['metric']
        compose(project, '--profile', 'observability', 'up', '-d', 'api')
        wait_until('API HTTP health after persistence check', lambda: api_http_health(project))
        compose(project, 'restart', 'grafana')
        wait_until('Grafana restart health', lambda: service_health(project, 'grafana'))
        dashboard_rows_after = wait_until('Grafana dashboards after restart', lambda: grafana_dashboards(grafana, admin, password))
        assert len(dashboard_rows_after) >= 3

        stats_cmd = ['docker', 'stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}} {{.CPUPerc}}']
        ids = compose(project, 'ps', '-q', 'api', 'web', 'prometheus', 'grafana', capture=True).split()
        stats = subprocess.run(stats_cmd + ids, cwd=ROOT, check=True, text=True, capture_output=True).stdout.strip().splitlines()
        print('offline integration: PASS')
        print('checks: opt-in default API/web, missing/empty Grafana secret rejection, synthetic sync scrape, datasource, dashboard PromQL validation, 3 dashboards, 6 alert rules, restart persistence with exporter stopped, sensitive-value scan, auth and loopback/nginx protections')
        print('resource snapshot with observability off (default API + web):')
        for line in off_stats:
            print(line)
        print('resource snapshot with observability on:')
        for line in stats:
            print(line)
        extra = [line for line in stats if '-grafana-' in line or '-prometheus-' in line]
        print('optional Prometheus + Grafana service memory/CPU snapshot:')
        for line in extra:
            print(line)
    finally:
        # Both project names are generated uniquely above; cleanup is scoped to only their resources.
        for name in (project, off_project, missing_secret_project, empty_secret_project):
            subprocess.run(['docker', 'compose', '--env-file', str(ENV_FILE), '-p', name,
                            '-f', 'docker-compose.yml', '-f', str(OVERRIDE.relative_to(ROOT)),
                            '--profile', 'observability', 'down', '--volumes', '--remove-orphans'], cwd=ROOT,
                           check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for path in (ENV_FILE, OVERRIDE, NO_SECRET_ENV):
            try:
                path.unlink()
            except FileNotFoundError:
                pass


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'offline integration: FAIL ({type(exc).__name__}: {exc})', file=sys.stderr)
        sys.exit(1)
