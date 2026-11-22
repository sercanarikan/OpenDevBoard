"""Synthetic-only API runner for the offline Compose integration test.

It replaces both Azure HTTP transports in-process before running exactly one sync,
then serves the normal Flask app so Prometheus can scrape that process-local series.
"""
import os
import sys
sys.path.insert(0, '/app/api')

os.environ['DEVOPS_FIXTURE_MODE'] = '0'
os.environ['OBSERVABILITY_METRICS_ENABLED'] = '1'
os.environ['DEVOPS_DATA_DIR'] = '/data'

import azure_client
import sync_service
from app import app

ORG = 'https://dev.azure.com/synthetic'
ITEM = {
    'id': 10001,
    'fields': {
        'System.Title': 'Synthetic test item',
        'System.WorkItemType': 'Task',
        'System.State': 'New',
        'System.TeamProject': 'Synthetic Project',
        'System.ChangedDate': '2026-11-22T00:00:00Z',
        'System.CreatedDate': '2026-11-22T00:00:00Z',
        'Microsoft.VSTS.Common.Priority': 2,
        'System.AssignedTo': None,
    },
    'relations': [],
    '_links': {},
}


class Response:
    status_code = 200
    headers = {}
    text = ''

    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return self.payload


def synthetic_post(_url, **_kwargs):
    return Response({'workItems': [{'id': ITEM['id']}]})


def synthetic_get(_url, **_kwargs):
    return Response({'value': [ITEM]})


azure_client.requests.post = synthetic_post
azure_client.requests.get = synthetic_get
result = sync_service.sync_work_items(ORG, 'synthetic-only', force_full=True)
if result.get('status') != 'success':
    raise SystemExit('synthetic sync did not succeed')
print('synthetic sync outcome: success', flush=True)
app.run(host='0.0.0.0', port=5000, threaded=True, use_reloader=False)
