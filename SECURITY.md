# Cirron CLI Security Policy

This document explains how to report security issues for `cirron-cli`.

## Reporting a vulnerability

Please report suspected security issues privately.

- **Preferred**: use GitHub's "Report a vulnerability" link in the repository sidebar (or open a [private security advisory](https://github.com/cirron/cirron-cli/security/advisories/new) directly).
- **Alternative**: email `security@cirron.com`.
- Do **not** open a public issue, pull request, or discussion post for suspected vulnerabilities.

When reporting, please include:

- A description of the issue and the affected version(s) of `cirron-cli`.
- Steps to reproduce — ideally the smallest `cirron ...` command sequence that triggers it, plus the relevant `cirron.yaml` if a project is involved.
- An assessment of potential impact (data exposure, code execution, denial of service, etc.).
- Your contact information.
- Any specific requests, such as anonymity for you and/or the organization you represent.

## Maintainer commitments

We aim to handle reports quickly and responsibly.

- We will acknowledge receipt within 2 business days.
- We will provide an initial assessment as capacity allows, generally within one to two weeks for non-trivial reports.
- We will share progress updates until resolution.
- Disclosure will be coordinated with the reporter, and credit given in the release notes unless anonymity is requested.

## Disclosure and embargoes

By default, `cirron-cli` does **not** accept long embargoes. Security reports usually become public once a fix is available and confirmed, alongside a GitHub Security Advisory and a patched release on npm.

A short embargo may be considered in exceptional cases (e.g. coordinated downstream patching for a known enterprise deployment), but is not guaranteed. Indefinite embargoes burn maintainer time tracking them and delay protection for users who are already exposed.

## Expectations for reporters

Reporters should understand that:

- Security reports are handled by the Cirron team. We are a small team. Response times reflect that.
- Reports with clear reproducers (a concrete command sequence) are triaged faster.
- Public exploitation while a fix is in progress shifts the calculus toward faster disclosure, not longer embargoes.

## Supported versions

We backport security fixes to:

- The current minor release of the latest major version.
- The previous major version, for 6 months after the next major ships.

Older versions receive fixes only at the maintainers' discretion. Pin your install (`npm install -g @cirron/cli@X`) and upgrade promptly to stay supported.

## Scope

In scope:

- Vulnerabilities in the `cirron` package source published on npm (and the standalone binaries built from it).
- Vulnerabilities in how the CLI handles its local state: the project `.cirron/` spool and snapshot directories, the project `cirron.yaml` / `.cirronignore`, and the global config at `~/.cirron/config.json`.
- Vulnerabilities in the CLI's network interactions with the Cirron platform when authenticated (the auth device flow and token refresh, registry push/pull/sync, deploy, remote runs, and log streaming).

Out of scope:

- Vulnerabilities in third-party dependencies where the CLI is not in the exploit path. Report those to the upstream project. **Exception**: if a dependency vulnerability is exploitable *through* `cirron-cli` (e.g. a path an attacker can reach via a CLI command or transport), still report it to us. We will coordinate with upstream and ship a mitigation in our own release if warranted.
- Vulnerabilities in the Cirron platform backend. Send these to `security@cirron.com` with the subject prefixed `[platform]` so we route them correctly.
- Issues that require a malicious local user with filesystem write access. The CLI trusts its own project directory and config files by design.

## Transparency

We document resolved security issues in the project release notes and as GitHub Security Advisories. This helps users understand our process and triage their own exposure.

## Recognition

We thank reporters in the release notes for the fix unless you prefer to remain anonymous. Cirron does not currently run a paid bug bounty program.
