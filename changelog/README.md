# Changelog directory

> **Do not hand-edit the `CHANGELOG-*.md` files in this directory.**

The changelog is generated and maintained automatically by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/) landed on `main`.

## Layout

The changelog is split by major version so each file stays readable as the
project grows:

- `CHANGELOG-v0.x.md` — the active file for the `0.x` release line.
- Future majors get their own `CHANGELOG-v1.x.md`, `CHANGELOG-v2.x.md`, … files
  as they arrive (see `changelog-path` in `release-please-config.json`).

release-please writes the entry for each release into the **active** file when
the release pull request is merged. Contributors never edit these files by
hand — write good Conventional Commit messages instead, and the changelog
follows.

## Note on GitHub Release notes

The generated GitHub **Release** (created when the release-please PR is merged)
carries its own auto-generated release notes. Those are **separate** from the
Markdown files here: the files in this directory are the cumulative,
in-repo changelog, while the Release notes are the per-tag summary shown on the
GitHub Releases page.
