---
name: release
description: Cut a new release of the sas-studio-ext extension - bump the version, write and verify the changelog, commit, tag, and build the dist zip. Use when the user asks to "release", "cut a release", "make a new version", "bump the version", or runs /release (optionally with a version number like 1.0).
---

# Release

Optional argument: the new version (e.g. `0.10`). If absent, bump the minor of
the highest `v*` git tag (`v0.9` -> `0.10`).

## Steps

1. **Prepare** — `scripts/release.sh prepare [version]` from the repo root. It
   validates the version (`<major>.<minor>`), refuses an existing tag or a dirty
   working tree, and prints `version=` / `last_tag=`. On a non-zero exit, report
   the message and stop — don't work around it.
2. **Changelog** — read `git log v<last>..HEAD --oneline` AND the actual diff
   (`git diff v<last>..HEAD --stat`, then read the interesting hunks). Add a
   `## <version>` section at the top of `CHANGELOG.md`, matching the existing
   style: prose bullets explaining *what changed and why*, wrapped at ~80 cols,
   not commit subjects.
3. **Verify** — re-walk the commit list and confirm every user-visible change
   landed in the new section, and that nothing already-released got duplicated.
   Purely internal churn (docs, test tweaks, refactors with no behaviour change)
   is deliberately omitted. Report what you left out.
4. **Finish** — `scripts/release.sh finish <version>`: bumps `manifest.json`,
   commits `chore: release <version>` (manifest + changelog only), tags
   `v<version>`, wipes `dist/` and runs `./package.sh`. Report the zip path and
   size from its output. Does not push.

## Notes

- Versions are two-part (`0.9`), tags are `v`-prefixed. Keep both.
- `package.sh` rebuilds the gitignored `lib/` if incomplete — that can take a
  while (it clones and webpacks the SAS LSP); let it run.
- Pushing is never part of this skill; the user pushes when they want to.
