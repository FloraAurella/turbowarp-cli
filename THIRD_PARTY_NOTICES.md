# Third-party notices

The CLI as a combined software work is distributed under GPL-3.0-only. Separately licensed components and artwork retain their original terms. This file supplements their notices; it does not replace them or grant trademark rights.

## Frozen TurboWarp and Scratch components

| Component | Frozen source | License / notices |
| --- | --- | --- |
| GUI audio effects copied into `vendor/scratch-gui-audio/` | TurboWarp/scratch-gui `b37cb1df4a9e3a3011de04f5d04063a63bdf0c0c` | GPLv3; original MIT copyright and BSD conditions retained in `UPSTREAM-README.md` and `LICENSES/scratch-gui/` |
| Scratch library catalog JSON | The same scratch-gui commit | GUI notices retained; the referenced artwork has separate terms below |
| TurboWarp VM | `43f13efd1883eeef8f82616faf69380ff75ab068` | MPL-2.0, plus original Scratch BSD notices |
| TurboWarp Blocks | `d3d1c2c89c0c63d3c16434ba063accd881d487c2` | GPLv3 |
| Render, parser, SVG renderer and Packager | Exact resolutions in `package-lock.json` | MPL-2.0; preserve component notices |
| Audio, storage and SB1 converter | Exact resolutions in `package-lock.json` | BSD-3-Clause |
| JSZip | `@turbowarp/jszip` 3.12.0 | MIT option of the upstream dual license |
| Native rendering/audio dependencies and utilities | Exact resolutions in `package-lock.json` | Individual MIT, Apache, BSD, ISC or MPL terms |
| Scratch render fonts | `7b6768fc6dfef6b343a06f992587b74807043961` | Package Apache license and supplied font OFL notice both retained; do not assume the package license replaces font-specific rights |

All 20 direct dependencies are listed with installed versions, locked resolutions, source links and notice paths in [LICENSES/DEPENDENCIES.json](LICENSES/DEPENDENCIES.json). Original license files are copied in `LICENSES/dependencies/`. This source release excludes `node_modules` and native binaries; a future bundled executable must separately audit its full transitive dependency tree and bundled native libraries.

## Scratch library artwork and sounds

`resources/library/` contains 1304 unmodified Scratch support assets, stored with lossless Brotli compression. Original URLs, MD5 and SHA-256 values are preserved in [resources/library-manifest.json](resources/library-manifest.json); human-readable asset names are in `resources/libraries/`. The original metadata within each asset is retained.

Scratch support materials are offered under **CC BY-SA 2.0**, subject to trademark exceptions. The Scratch Foundation website source, section 5.2, requires this attribution:

> Scratch is developed by the Lifelong Kindergarten Group at the MIT Media Lab. See http://scratch.mit.edu.

The original authors and other rightsholders retain their rights. Keep available attribution information and source URLs, supply the license, and license adaptations of the assets under the applicable share-alike terms. Including these assets does not change the license of unrelated CLI code. Using an asset as a product logo or endorsement may require separate trademark permission.

See [license text](LICENSES/CC-BY-SA-2.0.txt) and [quoted Scratch asset terms](LICENSES/SCRATCH-ASSET-TERMS.md). The website terms endpoint was unavailable during verification; the quotations were checked against the Foundation’s published website source on 2026-10-03.

## Frozen extension gallery

The shipped extension resources come from [TurboWarp/extensions at 90192c38ce9128c5eb828ad0957e0a968de9babd](https://github.com/TurboWarp/extensions/tree/90192c38ce9128c5eb828ad0957e0a968de9babd). They are preserved byte-for-byte as recorded in `baseline.json` and `resources/RESOURCE-MANIFEST.json`.

Each extension keeps its own license and author comments. Upstream states that MIT was the historical default; current headers may specify MPL, LGPL, BSD or combinations. An empty header in [LICENSES/EXTENSIONS.json](LICENSES/EXTENSIONS.json) is recorded as empty rather than assigning it a new license. Consult the exact upstream source, its default-license statement and any embedded notices. Gallery website code has GPLv3 terms, sample projects have CC BY 4.0 terms, and fonts/images have their own notices.

All upstream gallery license texts and image attributions are copied into `LICENSES/extensions/`. The complete, unmodified pinned source archive is included in [upstream/extensions-source.zip](upstream/extensions-source.zip), with hashes in [upstream/SOURCE-MANIFEST.json](upstream/SOURCE-MANIFEST.json). It includes the original build scripts, translations, dependency manifest, sources, attribution and license files. The desktop source archive includes the script that exports the gallery in desktop mode and Brotli-compresses it.

## Distribution rules

Preserve `LICENSE`, `NOTICE`, this file, `LICENSES/`, `vendor/`, `baseline.json`, the lockfile and source archive references when redistributing this source tree. Keep upstream source comments intact. For bundled executables, provide the corresponding source, local modifications and build/install scripts for the exact distributed version, with clear access next to the download. A lockfile or a link to the latest upstream branch alone is not a replacement for corresponding source.

The GPL applies to output only when that output itself contains covered software. Ordinary projects, images and sounds are not automatically GPL because they were made with the CLI; packaged HTML/executables can contain runtime code, and included assets/extensions carry their own obligations.
