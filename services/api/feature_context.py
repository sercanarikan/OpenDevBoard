"""Stateless runtime context shared by feature services and sync orchestration."""
import os
from base64 import b64encode


def is_fixture_mode():
    return os.environ.get('DEVOPS_FIXTURE_MODE') == '1'


def get_devops_headers(pat):
    token = b64encode(f':{pat}'.encode()).decode()
    return {
        'Authorization': f'Basic {token}',
        'Content-Type': 'application/json',
    }
