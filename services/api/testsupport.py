"""Test isolation helpers (not a test module: the file name does not match ``test_*.py``).

Why this exists: ``sync_service`` resolves its SQLite path from ``DEVOPS_DATA_DIR`` once, at import time, and
``init_db()`` runs during that import. A test module that wants a scratch database therefore cannot rely on the
environment variable: a value that is already set (a developer's real cache directory) or an earlier import of
``sync_service`` by another module decides where the destructive test statements land.

Usage, as the FIRST project import of every test module that touches ``sync_service`` (directly, or through
``app``, ``query_service``, ``pr_service`` ...)::

    import testsupport  # noqa: F401  (must precede the project imports)
    ...
    testsupport.isolate_database(globals())   # modules that write to the cache database

* ``import testsupport`` imports ``sync_service`` against a throwaway directory (restoring the previous
  ``DEVOPS_DATA_DIR`` afterwards) and the service modules against a throwaway database, so importing can never
  open, create tables in, or migrate a real cache.
* ``isolate_database`` installs ``setUpModule`` / ``tearDownModule`` that bind ``sync_service.DB_PATH`` to a fresh
  temporary directory for the module and restore the previous path and delete the directory afterwards. Any
  ``setUpModule`` / ``tearDownModule`` the module already defines still runs.
"""
import atexit
import importlib
import os
import shutil
import sys
import tempfile


def import_sync_service():
    """Returns ``sync_service``; if it is not imported yet, imports it with ``DEVOPS_DATA_DIR`` pointing at a
    throwaway directory. Already imported (the usual case inside ``unittest discover``): nothing is touched."""
    if 'sync_service' in sys.modules:
        return sys.modules['sync_service']
    boot_dir = tempfile.mkdtemp(prefix='devopsflow-test-import-')
    atexit.register(shutil.rmtree, boot_dir, ignore_errors=True)
    previous = os.environ.get('DEVOPS_DATA_DIR')
    os.environ['DEVOPS_DATA_DIR'] = boot_dir
    try:
        import sync_service  # noqa: F401
    finally:
        if previous is None:
            os.environ.pop('DEVOPS_DATA_DIR', None)
        else:
            os.environ['DEVOPS_DATA_DIR'] = previous
    return sys.modules['sync_service']


sync_service = import_sync_service()
import persistence

# Each service creates its own tables while it is imported (``init_*_db()`` at module level) against whatever
# ``sync_service.DB_PATH`` is at that moment. Import them here with the path pointed at a throwaway database, so
# a later ``import pr_service`` in a test module is a no-op and cannot create tables in a database that was
# already bound (for example when ``sync_service`` was imported earlier with a real ``DEVOPS_DATA_DIR``).
SERVICE_MODULES = ('pr_service', 'pipeline_service', 'deployment_service', 'team_service', 'history_service',
                   'query_service', 'fixture_data')


def import_service_modules():
    scratch = tempfile.mkdtemp(prefix='devopsflow-test-import-')
    previous = sync_service.DB_PATH
    previous_persistence = persistence.DB_PATH
    sync_service.DB_PATH = os.path.join(scratch, 'devops_cache.db')
    persistence.DB_PATH = sync_service.DB_PATH
    try:
        for name in SERVICE_MODULES:
            importlib.import_module(name)
    finally:
        sync_service.DB_PATH = previous
        persistence.DB_PATH = previous_persistence
        shutil.rmtree(scratch, ignore_errors=True)


import_service_modules()


def import_app():
    """``app`` keeps its own cache table in a *relative* ``devops_cache.db`` (``app.DB_PATH``) and creates it while
    it is imported, independent of ``DEVOPS_DATA_DIR``. Import it from a throwaway working directory and park
    ``app.DB_PATH`` on a throwaway file, so neither the import nor a test can create or modify a
    ``devops_cache.db`` in the real working directory."""
    if 'app' in sys.modules:
        return sys.modules['app']
    scratch = tempfile.mkdtemp(prefix='devopsflow-test-app-')
    atexit.register(shutil.rmtree, scratch, ignore_errors=True)
    cwd = os.getcwd()
    os.chdir(scratch)
    try:
        module = importlib.import_module('app')
    finally:
        os.chdir(cwd)
    module.DB_PATH = os.path.join(scratch, 'devops_cache.db')
    return module


app = import_app()


def isolate_database(module_globals):
    """Gives the calling test module its own temporary SQLite database for the duration of the module."""
    state = {}
    previous_setup = module_globals.get('setUpModule')
    previous_teardown = module_globals.get('tearDownModule')

    def setUpModule():
        state['previous_db_path'] = sync_service.DB_PATH
        state['previous_persistence_db_path'] = persistence.DB_PATH
        state['dir'] = tempfile.mkdtemp(prefix='devopsflow-test-db-')
        sync_service.DB_PATH = os.path.join(state['dir'], 'devops_cache.db')
        persistence.DB_PATH = sync_service.DB_PATH
        sync_service.init_db()
        state['previous_app_db_path'] = app.DB_PATH
        app.DB_PATH = os.path.join(state['dir'], 'app_cache.db')
        app.init_db()
        if previous_setup:
            previous_setup()

    def tearDownModule():
        try:
            if previous_teardown:
                previous_teardown()
        finally:
            sync_service.DB_PATH = state.pop('previous_db_path')
            persistence.DB_PATH = state.pop('previous_persistence_db_path')
            app.DB_PATH = state.pop('previous_app_db_path')
            shutil.rmtree(state.pop('dir'), ignore_errors=True)

    module_globals['setUpModule'] = setUpModule
    module_globals['tearDownModule'] = tearDownModule


def assert_test_database(directory):
    """Safety net for destructive helpers: raises unless ``sync_service.DB_PATH`` lives in ``directory``."""
    if os.path.dirname(os.path.abspath(sync_service.DB_PATH)) != os.path.abspath(directory):
        raise RuntimeError(f'refusing to modify a database outside the test directory: {sync_service.DB_PATH}')
