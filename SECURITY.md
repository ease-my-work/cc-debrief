# Security

cc-debrief stores your Claude Code sessions on your own machine, so a bug that leaks data, skips redaction or lets
another process or website reach the dashboard matters. Please report those privately.

## Reporting a vulnerability

Use GitHub's private reporting: the repository's **Security** tab → **Report a vulnerability**. Do not open a public
issue for a security problem.

Include the cc-debrief version (`npx cc-debrief --version`), your OS and Node.js version, and the steps to reproduce.
Leave out real transcripts, prompts, tokens and keys; a made-up example that shows the problem is enough.

You will get a reply within a week. Fixes ship in a patch release on npm, with a note in the changelog.

## Supported versions

Only the latest release on npm gets fixes.

## Scope

In scope: anything that sends captured data off the machine, stores a secret the redaction patterns should have
caught, makes the dashboard reachable from another host or another site, writes outside `~/.cc-debrief/` without
being asked, or lets crafted transcript content run code.

Out of scope: what Claude Code itself stores in `~/.claude/`, and the `claude -p` calls the AI features make through
your own Claude Code login (see "Privacy" in the README).
