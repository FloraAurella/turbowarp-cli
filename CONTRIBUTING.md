# Contributing

This is an experimental command-line project. Read [README](README.md), [the tutorial](docs/quickstart.md) and [current limitations](docs/current-limitations.md) before changing behavior. Contributions to CLI-specific code are offered under GPL-3.0-only; preserve the existing terms of copied third-party files. Submit changes through a pull request with the behavior change and relevant validation.

## Runtime development

Use Node.js 24 and the native build prerequisites in the README. Install with `npm ci`, then run:

```bash
./tw doctor --json
npm run resources:check
npm run tutorial:smoke
```

Production runtime checks do not require a sibling desktop directory. `examples/verified-*` directories are generated evidence and are ignored by Git. Run relevant test files for a change, using the Node 24 wrapper and native environment preload:

```bash
node scripts/node24.js --require ./src/native-environment.js --test test/agent-interface.test.js test/script-recipes.test.js
```

## Frozen upstream development oracle

Some tests intentionally compare behavior against the frozen desktop source. They need a sibling `../desktop-master` directory; do not point them at an unrelated latest checkout. `upstream/desktop-baseline-source.zip` contains the source snapshot and its frozen lockfile. Check its SHA-256 against `upstream/SOURCE-MANIFEST.json`. Only extract it into a location where `../desktop-master` does not already exist:

```bash
python3 - <<'PYCODE'
from pathlib import Path
import zipfile
archive = Path('upstream/desktop-baseline-source.zip')
target = Path('../desktop-master')
if target.exists():
    raise SystemExit('Refusing to overwrite existing ../desktop-master')
with zipfile.ZipFile(archive) as source:
    for member in source.infolist():
        parts = Path(member.filename).parts
        if not parts or parts[0] != 'desktop-master' or '..' in parts or Path(member.filename).is_absolute():
            raise SystemExit('Unsafe archive member')
    source.extractall('..')
PYCODE
cd ../desktop-master
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1 npm ci --registry=https://registry.npmjs.org
npm run fetch
cd ../turbowarp-cli
npm test
npm run baseline:check
```

If your checkout has a different directory name, adjust the return `cd`. Fetching upstream development resources requires network access; a missing resource is an environment failure to diagnose, not permission to lower the baseline hashes. Some original development fixtures refer to historical `examples/verified-*` outputs; the standalone check and tutorial are the supported entry points for new users.

## Documentation and release

Update [command reference](docs/command-reference.md) through `npm run docs:commands` when command schemas change. Keep tutorials consistent with real commands, and retain explicit limitations.

`npm run release:check` currently exits **2** because full GUI parity is not accepted. This repository may distribute experimental source while that gate is false. Do not claim full parity or publish a bundled executable as compliant based only on passing source/tutorial checks. See [open-source distribution notes](docs/open-source.md).
