# Public release: main branch ruleset

Do not enable this policy during private preparation. After explicit public-release approval:

1. Confirm CI is green and the status-check names below match the latest workflow run.
2. Make the repository public using GitHub settings.
3. Immediately create an active branch ruleset targeting `main`; select no bypass actors unless an emergency exception is explicitly required.
4. Require pull requests before merging with zero approvals and require conversation resolution. Require the checks `web`, `api-tests`, `compose`, and `secret-scan`, require branches to be up to date, require linear history, restrict deletions, and block force pushes.
5. Confirm the active policy applies to administrators and test the PR flow. Do not create a release or tag without separate authorization.

GitHub documents branch rulesets as available for public repositories on GitHub Free; private repositories require Pro, Team, or Enterprise Cloud. Active and disabled enforcement are documented; availability depends on the account plan. See [GitHub ruleset availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) and [available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets). The exact check names must be verified from the actual Actions run before enforcement.
