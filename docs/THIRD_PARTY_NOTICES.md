# Third-Party Notices — OpenDevBoard Public Edition

## Distribution scope

The initial distribution is the GitHub source repository only. It contains OpenDevBoard source, dependency manifests/lockfiles, Dockerfiles, and test scripts; it does **not** contain installed npm/Python packages, built application bundles, container images, or Playwright browser binaries. Listing a dependency in a manifest does not redistribute its package files.

Classification:

| Class | Material in this source release | Status and obligations |
|---|---|---|
| A — Included third-party source/assets/vendor | No verified third-party package implementation or font asset is included in the allowlist. Lucide is referenced as an installed dependency, not vendored source. | **VERIFIED (scope)** — no dependency notice text is required solely because a package is declared. The MIT root license covers only authorized OpenDevBoard contributions, not external dependencies. If later packaging includes dependency code/assets, preserve their exact copyright and license notices. |
| B — Declared dependencies, downloaded by users/builds | 218 npm lockfile records and 44 Python constraints pins; dependencies are installed by consumers/builds, not committed. | **NOT APPLICABLE TO SOURCE DISTRIBUTION** for reproducing package license texts in this repo solely due to declarations. Metadata findings are recorded below for downstream packaging; distributors of installed packages/build output must inventory the exact artifacts and carry applicable notices. |
| C — External runtime resources | `apps/web/index.html` requests Inter and JetBrains Mono through Google Fonts CSS API. | **VERIFIED** as external runtime URL use; **NOT APPLICABLE TO SOURCE DISTRIBUTION** as bundled-font redistribution. Browser users contact Google. Exact delivered font artifacts are not pinned; if fonts are self-hosted or bundled later, verify and include the relevant font license/copyright notices. |
| D — Possible future binaries/images | Dockerfiles describe images; Playwright can download browser binaries during E2E provisioning. Neither image nor browser binary is in this source candidate. | **NOT APPLICABLE TO SOURCE DISTRIBUTION**. If distributed later, generate exact image/browser inventories and include applicable notices before that distribution. |

Category statuses: **VERIFIED**, **NOT APPLICABLE TO SOURCE DISTRIBUTION**, or **BLOCKED / UNKNOWN** are used to distinguish established scope from future artifact questions.

Playwright package metadata/terms do not make downloaded browser binaries part of this source distribution; browser binary license notices apply only if those binaries are separately redistributed.

## Focused exact-version evidence

All entries below are **VERIFIED** as stated license metadata/upstream terms for the exact versions, not proof that those package files are part of this source repository:

- `et-xmlfile==2.0.0` — PyPI exact-release metadata declares MIT: <https://pypi.org/pypi/et-xmlfile/2.0.0/json>. The official docs for 2.0.0 state MIT/Expat: <https://openpyxl.pages.heptapod.net/et_xmlfile>. Exact sdist license-file contents were not extracted in this review.
- `Flask-Cors==6.0.5` — PyPI exact-release metadata declares MIT: <https://pypi.org/pypi/Flask-Cors/6.0.5/json>. Exact sdist license-file contents were not extracted in this review.
- `openpyxl==3.1.5` — PyPI exact-release metadata declares MIT: <https://pypi.org/pypi/openpyxl/3.1.5/json>. Exact sdist license-file contents were not extracted in this review.
- `pip==26.3` — PyPI exact-release metadata declares MIT and lists license files, including vendored dependency licenses: <https://pypi.org/pypi/pip/26.3/json>. No project use/distribution of pip 26.3 as a runtime dependency was established; if a future package includes it, inspect and preserve all listed vendored notices.
- `lightningcss@1.33.0` — npm lockfile pins version; registry metadata declares MPL-2.0: <https://registry.npmjs.org/lightningcss/1.33.0>; upstream license: <https://raw.githubusercontent.com/parcel-bundler/lightningcss/master/LICENSE>. MPL obligations apply if the package source/binary is redistributed; no such package files are in this source repository.
- `caniuse-lite` — lockfile resolves version `1.0.30001819`; registry metadata for the exact locked version declares CC-BY-4.0: <https://registry.npmjs.org/caniuse-lite/1.0.30001819>. If redistributing the data, provide applicable CC-BY attribution.
- `lucide-react@1.68.0` — npm lockfile pins version; registry metadata declares ISC: <https://registry.npmjs.org/lucide-react/1.68.0>; upstream license/notice: <https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE>. Preserve the ISC notice and any applicable Feather-derived icon notice if redistributing package/icon assets; package files are not in this source repository.
- Inter — upstream project states SIL Open Font License 1.1: <https://github.com/rsms/inter/blob/master/LICENSE.txt>.
- JetBrains Mono — JetBrains states SIL Open Font License 1.1 and provides its license: <https://www.jetbrains.com/lp/mono>; <https://github.com/JetBrains/JetBrainsMono/blob/master/OFL.txt>.

Focused metadata is exact-release authoritative evidence for package license declarations; **exact archive license-file contents remain BLOCKED / UNKNOWN** for all named package tarballs. This gap is only a source-release blocker if those package artifacts are actually included in a distribution.

## SBOM and completeness limits

`docs/public-package-sbom.json` inventories 218 npm lockfile records (215 unique name/version pairs) and 44 Python constraint identities (262 records total); it describes dependency declarations, not bundled source. Python SBOM license expressions remain empty because exact distribution archives have not been inspected. The 41/44 local license-filename observation is not treated as a source-release blocker: those distributions are not part of this source archive and filename matches do not prove archive contents.

Source distribution license status: **NOT READY for claims of a complete third-party notice bundle for a built/installed product**. For the source-only GitHub repository, the focused dependency files above are **NOT APPLICABLE TO SOURCE DISTRIBUTION** as redistributed artifacts. Remaining **BLOCKED / UNKNOWN** for any future artifact distribution: exact archive contents for the named Python/npm package versions, complete notices for all resolved dependencies, exact Google Fonts runtime response versions/terms, and exact Docker/browser binary inventories if those binaries are shipped. These are future-artifact gates, not automatic blockers for this source-only candidate. No unverified license text or attribution has been invented or copied into this file.
