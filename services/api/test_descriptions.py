"""Synthetic tests for full pull request / work item descriptions (no Azure DevOps access required)."""

import unittest
from unittest import mock

import testsupport  # noqa: E402,F401  (must precede the project imports)
import app as api_app  # noqa: E402
import pr_service  # noqa: E402
import sync_service  # noqa: E402

testsupport.isolate_database(globals())

LONG_MARKDOWN = "## Summary\n\n" + "\n".join(f"- change {i}: **synthetic** detail line" for i in range(60))
BUG_REPRO_HTML = "<ol><li>Open the synthetic page</li><li>Click <b>Save</b></li></ol><script>alert(1)</script>"


class FakeResp:
    def __init__(self, payload, status=200):
        self._p, self.status_code = payload, status

    def json(self):
        return self._p


def raw_item(item_id, wtype, **fields):
    base = {'System.Title': f'Synthetic {item_id}', 'System.WorkItemType': wtype, 'System.State': 'Active',
            'System.TeamProject': 'Synth', 'System.ChangedDate': '2026-11-05T08:00:00Z',
            'System.CreatedDate': '2026-11-01T08:00:00Z'}
    base.update(fields)
    return {'id': item_id, 'fields': base, 'relations': []}


def store(row):
    with sync_service.db_lock, sync_service.get_db_connection() as conn:
        conn.execute(sync_service._UPSERT_MAIN_SQL, sync_service._row_params(row, '2026-11-05T09:00:00Z', False))
        conn.commit()


class WorkItemDescriptionTests(unittest.TestCase):
    def test_task_description_and_bug_repro_steps_are_parsed(self):
        task = sync_service.parse_work_item(raw_item(1, 'Task', **{'System.Description': '<p>Task body</p>'}), 'https://dev.azure.com/o')
        bug = sync_service.parse_work_item(raw_item(2, 'Bug', **{'Microsoft.VSTS.TCM.ReproSteps': BUG_REPRO_HTML}), 'https://dev.azure.com/o')
        self.assertEqual(task['description'], '<p>Task body</p>')
        self.assertEqual(bug['repro_steps'], BUG_REPRO_HTML)
        self.assertEqual(bug['description'], '')

    def test_synced_items_expose_text_only_in_detail_and_empty_is_distinct_from_unknown(self):
        store(sync_service.parse_work_item(raw_item(9100001, 'Task', **{'System.Description': 'Plain text body'}), 'https://x'))
        store(sync_service.parse_work_item(raw_item(9100002, 'Bug', **{'Microsoft.VSTS.TCM.ReproSteps': BUG_REPRO_HTML}), 'https://x'))
        store(sync_service.parse_work_item(raw_item(9100003, 'Task'), 'https://x'))

        task = sync_service.get_single_item(9100001)
        bug = sync_service.get_single_item(9100002)
        empty = sync_service.get_single_item(9100003)
        self.assertEqual((task['description'], task['descriptionStatus']), ('Plain text body', 'available'))
        self.assertEqual((bug['reproSteps'], bug['descriptionStatus']), (BUG_REPRO_HTML, 'available'))
        self.assertEqual((empty['description'], empty['descriptionStatus']), ('', 'empty'))

        with sync_service.db_lock, sync_service.get_db_connection() as conn:
            listed = sync_service.row_to_work_item_dict(conn.execute('SELECT * FROM work_items WHERE id = 9100001').fetchone())
        self.assertNotIn('description', listed)

    def _legacy_row(self, item_id):
        store(sync_service.parse_work_item(raw_item(item_id, 'Bug'), 'https://x'))
        with sync_service.db_lock, sync_service.get_db_connection() as conn:
            conn.execute('UPDATE work_items SET description = NULL, repro_steps = NULL WHERE id = ?', (item_id,))
            conn.commit()

    def test_legacy_row_is_read_live_once_and_kept(self):
        self._legacy_row(9100004)
        payload = {'fields': {'Microsoft.VSTS.TCM.ReproSteps': '<p>live repro</p>'}}
        with mock.patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                mock.patch.object(sync_service.requests, 'get', return_value=FakeResp(payload)) as get:
            item = sync_service.get_single_item(9100004, org_url='https://dev.azure.com/o', pat='synthetic-pat')
        self.assertEqual(item['reproSteps'], '<p>live repro</p>')
        self.assertEqual(item['descriptionStatus'], 'available')
        self.assertIn('fields=System.Description,Microsoft.VSTS.TCM.ReproSteps', get.call_args.args[0])
        with mock.patch.object(sync_service.requests, 'get') as get:
            again = sync_service.get_single_item(9100004)
        get.assert_not_called()
        self.assertEqual(again['reproSteps'], '<p>live repro</p>')

    def test_failed_live_read_is_unavailable_not_empty(self):
        self._legacy_row(9100005)
        with mock.patch.object(sync_service, 'is_fixture_mode', return_value=False), \
                mock.patch.object(sync_service.requests, 'get', return_value=FakeResp({}, status=503)):
            item = sync_service.get_single_item(9100005, org_url='https://dev.azure.com/o', pat='synthetic-pat')
        self.assertEqual(item['descriptionStatus'], 'unavailable')

    def test_detail_endpoint_returns_description_fields(self):
        store(sync_service.parse_work_item(raw_item(9100006, 'Task', **{'System.Description': 'Endpoint body'}), 'https://x'))
        with mock.patch.object(sync_service, 'is_fixture_mode', return_value=True):
            response = api_app.app.test_client().get('/api/work-items/9100006')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['description'], 'Endpoint body')


class PullRequestDescriptionTests(unittest.TestCase):
    def setUp(self):
        self.pr = dict(pr_service.build_fixture_prs()[0], description='x' * 400)

    def test_full_description_replaces_the_shortened_list_text(self):
        with mock.patch.object(pr_service.requests, 'get', return_value=FakeResp({'description': LONG_MARKDOWN})) as get:
            result = pr_service.with_full_description(self.pr, 'https://dev.azure.com/o', 'synthetic-pat')
        self.assertEqual(result['description'], LONG_MARKDOWN)
        self.assertEqual(result['descriptionStatus'], 'available')
        self.assertGreater(len(LONG_MARKDOWN), 400)
        self.assertIn('/_apis/git/repositories/', get.call_args.args[0])
        self.assertEqual(get.call_args.kwargs['params'], {'api-version': '7.1'})

    def test_confirmed_empty_and_failed_read_are_different_statuses(self):
        with mock.patch.object(pr_service.requests, 'get', return_value=FakeResp({})):
            self.assertEqual(pr_service.with_full_description(self.pr, 'https://dev.azure.com/o', 'p')['descriptionStatus'], 'empty')
        with mock.patch.object(pr_service.requests, 'get', return_value=FakeResp({}, status=500)):
            failed = pr_service.with_full_description(self.pr, 'https://dev.azure.com/o', 'p')
        self.assertEqual(failed['descriptionStatus'], 'unavailable')
        self.assertEqual(failed['description'], 'x' * 400)
        with mock.patch.object(pr_service.requests, 'get', side_effect=pr_service.requests.ConnectionError()):
            self.assertEqual(pr_service.with_full_description(self.pr, 'https://dev.azure.com/o', 'p')['descriptionStatus'], 'unavailable')

    def test_fixture_mode_uses_cached_text_without_network(self):
        with mock.patch.object(pr_service.requests, 'get') as get:
            result = pr_service.with_full_description(self.pr)
        get.assert_not_called()
        self.assertEqual(result['descriptionStatus'], 'available')

    def test_detail_endpoint_reports_the_status(self):
        fixture = pr_service.build_fixture_prs()
        with mock.patch.object(sync_service, 'is_fixture_mode', return_value=True), \
                mock.patch.object(api_app, '_get_pr_current_user', return_value={'id': 'u'}), \
                mock.patch.object(api_app, '_load_all_prs', return_value=fixture):
            response = api_app.app.test_client().get(f"/api/pull-requests/{fixture[0]['id']}")
        self.assertEqual(response.status_code, 200)
        self.assertIn(response.get_json()['descriptionStatus'], {'available', 'empty'})


if __name__ == '__main__':
    unittest.main()
