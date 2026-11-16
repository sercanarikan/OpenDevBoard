"""Read-only discovery of the Azure DevOps projects the configured PAT can access."""

import logging
from typing import List, Tuple

import requests

import azure_http

logger = logging.getLogger("project_inventory")

PROJECT_PAGE_SIZE = 100
PROJECT_MAX_PAGES = 100


def discover_projects(org_url: str, headers: dict) -> Tuple[List[str], bool]:
    """Returns (project names, complete) from `_apis/projects`, following continuation tokens.

    `complete` is True only when every page was read and the last page was proven to be the last one.
    A full page without a continuation marker cannot prove that, so it is reported as incomplete.
    """
    projects: List[str] = []
    token = None
    seen = set()
    for _ in range(PROJECT_MAX_PAGES):
        try:
            params = {"$top": PROJECT_PAGE_SIZE, "api-version": "7.1"}
            if token:
                params["continuationToken"] = token
            response = azure_http.get(f"{org_url.rstrip('/')}/_apis/projects", headers=headers, params=params, timeout=15)
            if response.status_code != 200:
                return projects, False
            values = response.json().get("value", [])
            if any(not isinstance(p, dict) or not p.get("name") for p in values):
                return projects, False
            projects.extend(p["name"] for p in values)
            next_token = (getattr(response, "headers", {}) or {}).get("x-ms-continuationtoken")
            if not next_token:
                return projects, len(values) < PROJECT_PAGE_SIZE
            if next_token in seen:
                return projects, False
            seen.add(next_token)
            token = next_token
        except (requests.RequestException, ValueError, TypeError):
            return projects, False
    return projects, False
