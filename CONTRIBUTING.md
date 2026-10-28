# Contributing

cc-debrief is maintained by one person. **Issues are welcome; pull requests are not accepted.** If you found a bug or
want a feature, open an issue and it will be fixed or answered there. A pull request will be closed, though the idea
in it may still be picked up through an issue.

## Filing a good issue

- **Bug:** the cc-debrief version, OS, Node.js and Claude Code versions, which client (CLI, VS Code or desktop app),
  what you did, what you expected and what happened. The output of `npx cc-debrief doctor` helps most.
- **Feature:** the problem you want solved, before the solution you have in mind.
- **Never paste** transcripts, prompts, file contents, tokens or keys. Replace your user name and repo names in paths
  and logs. Security problems go through private reporting instead, see [SECURITY.md](SECURITY.md).

## Building it yourself

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run build
npm test
npm run lint
npm run typecheck
```

`npm run test:e2e` runs the Playwright dashboard tests, `npm run test:tz` runs the tests under several time zones.
How the package is put together is in [docs/architecture.md](docs/architecture.md) and [docs/features/](docs/features/).
