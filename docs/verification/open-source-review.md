## Review report: experimental source publication

**Overall score: 100/100 — Ship**
*Correctness of assessment: Medium (publication scope only; security status and platform limits are disclosed)*

### Blockers (must fix)
None for the reviewed source-publication operation.

### Warnings (should fix)
None left unresolved within the publication operation; dependency findings are tracked explicitly in SECURITY.md and do not constitute a production-readiness approval.

### Suggestions (optional)
None.

### Verdict
Ship the experimental source tree with its documented license, platform and dependency-audit limitations.

Intent: publish a new independent source repository on FloraAurella/turbowarp-cli. Effects: a public repository and source-only prerelease; no existing repository is overwritten, no history is rewritten, and the original working tree is preserved.

Command review: gh authentication and target identity checked; target repository absent; source tree was previewed through git add --dry-run. Credentials/personal-path patterns, archive traversal, symlinks and files over 100 MiB were checked. Source hashes and root package-lock metadata match. No elevated privileges or force pushes are needed. npm ci runs only in the isolated publish directory; install and runtime checks passed.

Validation: fresh locked install, doctor, resource check, 102 tutorial/Agent requests and 30 targeted tests passed. Full tests were not rerun because this publication changes notices, metadata and one fixture path; its relevant test passed. No claim is made that the entire existing codebase or all dependency vulnerabilities have passed a new security audit.
