# Documentation governance

Update documentation when a change affects user behavior, public API, configuration, operations, security, or supported environments. A PR with no such effect may explain why no documentation change is needed. Reviewers check accuracy and ownership; the checklist does not require edits in every PR. Significant, durable architecture decisions follow the [ADR process](adr/README.md).

For paired English and Turkish documents, compare commands, defaults, links, security and operational guidance in both languages. Update both when the change applies to both; if translation must follow later, explain the gap, identify an owner and link the follow-up. A document without an existing translation does not automatically need a new one. Human review is required for meaning and usability.

From the repository root, use Node 22 and Python 3.12:

```sh
npm ci --prefix scripts
npm --prefix scripts run docs:lint
npm --prefix scripts run docs:links
npm --prefix scripts run docs:test
python3 scripts/docs/config_defaults_test.py
```

The offline link check validates relative files, Markdown heading anchors and explicit reference links; external URLs are not fetched. The lint configuration enables a small whitespace and final-newline baseline without reformatting existing documents. Tests include valid and invalid examples. Configuration contracts read source syntax and Compose text without importing the application or accessing environment files and databases. When changing a deliberate default, update the matching documentation and contract in the same PR. The `docs` CI job runs these checks independently of existing application jobs.
