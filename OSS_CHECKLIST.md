# OSS Readiness Checklist

What to add when transitioning from self-hosted personal tool → public project accepting contributors. Until then, intentional gaps.

## Before accepting first PR

- [ ] `CONTRIBUTING.md` — how to run tests, code style, PR checklist (lift from `CLAUDE.md` commands section)
- [ ] `CODE_OF_CONDUCT.md` — Contributor Covenant template, paste-and-go
- [ ] `.github/ISSUE_TEMPLATE/bug_report.md` + `feature_request.md`
- [ ] `.github/CODEOWNERS` — `* @loganmurphy`
- [ ] Tag `v1.0.0` retroactively on current main (`git tag -a v1.0.0 <sha> -m "..." && git push --tags`)
- [ ] Enable GitHub Discussions for "how do I" questions

## When cutting releases

- [ ] Bump `package.json` version
- [ ] Use GitHub's auto-generated release notes from merged PRs (no hand-written CHANGELOG)
- [ ] Tag each release (`v1.0.1`, `v1.1.0`, ...)

## Optional / when relevant

- [ ] `.github/FUNDING.yml` — surfaces the BMC button on the repo page
- [ ] `CHANGELOG.md` — only if auto-generated release notes stop being enough
- [ ] CodeQL workflow — if drive-by security reports become enough volume to justify
