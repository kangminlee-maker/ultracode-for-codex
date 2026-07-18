# Provenance Audit

Date: 2026-06-23
Update 2026-07-18: version references updated to the 0.6.1 release line (two
prompt-size fixes since the previous release — the journal now audit-bounds an
oversized agent prompt instead of aborting the run, and the workspace context's
git-status section is byte-bounded). The runtime change set is project-authored
source with no new third-party runtime code; the ESLint dev toolchain added after the
previous release is a devDependency only and is excluded from the published package
(contents unchanged), so the marker-scan evidence below is unchanged from the 2026-06-23 audit.

## Scope

This audit checked:

- tracked repository files;
- generated npm package contents for `ultracode-for-codex@0.6.1`;
- the locally installed companion Codex skill.

Generated build output and package tarballs were checked as projections of the
tracked source. Dependency source trees were treated as third-party dependency
inputs, not project-authored code.

## Result

Repository and package artifacts are clear for the Apache-2.0 license from an
artifact-provenance perspective.

License transition completed:

- Apache-2.0 `LICENSE` file is present;
- `package.json` and `package-lock.json` declare `Apache-2.0`;
- audited package metadata version is `0.6.1`;
- npm publish state is verified separately during release preparation.

## Evidence

- High-risk historical-source marker search: zero matches in tracked source,
  generated package contents, and local companion skill after cleanup.
- Legacy API-project marker search: zero matches in tracked source, generated
  package contents, and local companion skill after cleanup.
- Packaged runtime contents are limited to the CLI runtime, current docs,
  settings, and companion skill.
- Production dependencies: none.
- Development dependencies: TypeScript and Node type packages only.
- Bundled third-party code: none.

Expected platform-control markers remain:

- provider environment variable names used by child-process environment
  stripping and tests;
- Codex feature names used to disable unrelated child runtime features;
- npm registry and GitHub metadata URLs.

## Remediation Completed

The local companion skill had stale local-only reference files that were not in
the package skill. Those local references were removed, and the local skill agent
metadata was synchronized with the packaged skill.

## Residual Risk

This audit validates repository and package artifacts. It does not determine
external service contract compliance or replace legal review.
