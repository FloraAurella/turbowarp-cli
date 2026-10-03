# Security status

This experimental source release is not a security-certified or production-hardened distribution. Only macOS arm64 installation and the documented local workflows have been verified.

## Known dependency advisories

On 2026-10-03, `npm audit --json --registry=https://registry.npmjs.org` against the freshly installed locked tree reported **23 findings: 5 low, 10 moderate, 8 high, 0 critical**. The full machine-readable report is in [docs/verification/dependency-audit.json](docs/verification/dependency-audit.json).

The high-severity package entries are `braces`, `chokidar`, `micromatch`, `serialize-javascript`, `terser-webpack-plugin`, `watchpack`, `watchpack-chokidar2` and `webpack`. The audit includes transitive build-tool dependencies, as well as affected direct dependency entries for Scratch storage/parser/VM. This is the npm advisory classification, not a completed analysis of exploitability through every CLI command.

The frozen versions are preserved for reproducible behavior in this first source release. An automatic `npm audit fix` can change upstream behavior and has not been applied. Dependency upgrades require separate compatibility and security validation. Do not interpret passing tests or the CLI’s file/network restrictions as resolving these advisories.

## Reporting

Use GitHub private vulnerability reporting if enabled for this repository. Avoid putting credentials, private projects or exploit payloads in public issues. Ordinary reproducible bugs can be filed at https://github.com/FloraAurella/turbowarp-cli/issues with the CLI version, platform, sanitized command and relevant stderr.
