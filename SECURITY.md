# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report them privately via [GitHub Security Advisories](https://github.com/loganmurphy/oura-mcp-server/security/advisories/new). You'll get a response within 7 days.

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce (or a proof-of-concept)
- Any suggested mitigations if you have them

## Scope

**In scope:**
- The Cloudflare Worker (`src/`)
- The D1 cache layer and how data is stored/retrieved
- The bootstrap wizard's handling of API tokens and secrets (`scripts/`)
- Cloudflare Access / Zero Trust configuration produced by the wizard

**Out of scope:**
- Oura's own API or app (report to Oura directly)
- Cloudflare's platform (report via [Cloudflare's bug bounty](https://hackerone.com/cloudflare))
- Issues requiring physical access to the Oura ring

## Supported versions

Only the latest commit on `main` is actively maintained.
