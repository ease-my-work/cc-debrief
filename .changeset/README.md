# Changesets

Each user-visible change adds a file here with `npx changeset` (patch, minor or major, plus one line for the
changelog). On `master`, the release workflow opens a "Version packages" pull request that bumps `package.json` and
writes `CHANGELOG.md`; after it merges, pushing a `v<version>` tag publishes to npm (see `.github/workflows/release.yml`).
