import sqlite3
import unittest

import project_scope


class ProjectScopeStoreTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        project_scope.init_project_scope_db(self.conn)

    def tearDown(self):
        self.conn.close()

    def test_missing_snapshot_is_none_not_empty(self):
        self.assertIsNone(project_scope.load_project_set(self.conn, "https://dev.example.invalid/org"))

    def test_saved_set_is_loaded_sorted_and_deduplicated(self):
        project_scope.save_project_set(self.conn, "https://dev.example.invalid/org/", ["Beta", "Alpha", "Alpha"], "2026-11-25T10:00:00Z")
        self.assertEqual(project_scope.load_project_set(self.conn, "https://dev.example.invalid/org"), ["Alpha", "Beta"])

    def test_snapshot_is_per_organisation(self):
        project_scope.save_project_set(self.conn, "https://a.example.invalid/org", ["Alpha"], "2026-11-25T10:00:00Z")
        self.assertIsNone(project_scope.load_project_set(self.conn, "https://b.example.invalid/org"))


if __name__ == "__main__":
    unittest.main()
