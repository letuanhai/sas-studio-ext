#!/bin/sh
# Deterministic halves of the release flow. Run from the repo root.
#
#   release.sh prepare [version]   validate + print the version to release
#   release.sh finish  <version>   bump manifest, commit, tag, package
#
# The changelog is written by hand between the two.
set -e

fail() { echo "release: $1" >&2; exit 1; }

last_tag=$(git tag --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+$' | head -1)

case "$1" in
prepare)
  version="$2"
  if [ -z "$version" ]; then
    [ -n "$last_tag" ] || fail "no v<major>.<minor> tag found - pass a version explicitly"
    version=$(echo "${last_tag#v}" | awk -F. '{print $1 "." $2 + 1}')
  fi
  echo "$version" | grep -qE '^[0-9]+\.[0-9]+$' || fail "bad version '$version' (want <major>.<minor>, e.g. 0.10)"
  git rev-parse -q --verify "refs/tags/v$version" >/dev/null && fail "tag v$version already exists"
  [ -z "$(git status --porcelain)" ] || fail "working tree is dirty - commit or stash first"
  echo "version=$version"
  echo "last_tag=$last_tag"
  ;;
finish)
  version="$2"
  echo "$version" | grep -qE '^[0-9]+\.[0-9]+$' || fail "bad version '$version'"
  git rev-parse -q --verify "refs/tags/v$version" >/dev/null && fail "tag v$version already exists"
  grep -q '"version": "' manifest.json || fail "no version field in manifest.json"
  sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$version\"/" manifest.json
  git add manifest.json CHANGELOG.md
  git diff --cached --quiet && fail "nothing staged - did the changelog get updated?"
  git commit -qm "chore: release $version"
  git tag "v$version"
  rm -rf dist
  ./package.sh
  ;;
*)
  fail "usage: release.sh prepare [version] | release.sh finish <version>"
  ;;
esac
