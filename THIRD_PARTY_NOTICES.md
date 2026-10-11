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

The original direct-dependency inventory is listed with installed versions, locked resolutions, source links and notice paths in [LICENSES/DEPENDENCIES.json](LICENSES/DEPENDENCIES.json). Original license files are copied in `LICENSES/dependencies/`. The source archive excludes `node_modules` and native binaries. Version 0.1.2 also ships a macOS arm64 portable archive with installed dependencies and bundled native libraries; its complete version-specific dependency inventory and corresponding sources accompany that archive and supplement this early direct-dependency list.

## Version 0.1.2 portable runtime and native components

The portable distribution bundles Node.js **24.18.0** and the installed dependency tree needed for native project execution, rendering and audio. Preserve its dependency source archive, build scripts, file/source hash manifests and original license files next to the binary download. The compiled CLI payload does not replace the modifiable GPL corresponding source. Version-specific artifacts are `tw-cli-v0.1.2-source.zip`, `tw-cli-v0.1.2-dependencies-source.zip` and `tw-cli-resvg-js-v2.6.2-source.zip` in the same Release; exact package versions and native source references are recorded in `DEPENDENCY-MANIFEST.json`.

| Component | Source and retained notices |
| --- | --- |
| Node.js 24.18.0 | [Exact Node source](https://nodejs.org/dist/v24.18.0/node-v24.18.0.tar.xz) and portable `runtime/NODE-LICENSE`, including notices for its embedded third-party components; do not reduce the combined notices to the top-level MIT permission |
| ANGLE / native WebGL | `node-gles-webgl2` and its darwin-arm64 dependency are version 0.5.0; wrapper Apache-2.0 and ANGLE BSD-style notices are retained. Build metadata pins ANGLE `angle-main-28385` at [aa5f0107c9db735e9bcdc2f2c5abebfbfa939e17](https://chromium.googlesource.com/angle/angle/+/aa5f0107c9db735e9bcdc2f2c5abebfbfa939e17); preserve its license and embedded notices. Platform library-path relocation is part of the portable build |
| resvg / resvg-js | `@resvg/resvg-js` 2.6.2 source artifact includes the binding and its declared patched `zimond/resvg` source revision `fixed3495d870`, with source hashes and build metadata. MPL terms and separately licensed dependencies remain applicable |
| Other JavaScript and native dependencies | Exact lockfile resolutions and installed-package source/license files; native prebuilt packages require the corresponding component sources as well as the npm wrapper |

The portable `PORTABLE-MANIFEST.json` records the distributed payload. `DEPENDENCY-MANIFEST.json` records the installed packages, compiler and corresponding source references; dependency source files and native source archives accompany the release. Preserve the license files in `dist/LICENSES/` and individual packages in `dist/node_modules/`, as well as `runtime/NODE-LICENSE`. Keep these records together with the same-version CLI source and construction scripts. Hash checking and read-only files are integrity measures; they do not change GPL rights or constitute a security sandbox.

ffmpeg is **not bundled** in version 0.1.2. Recording features that use ffmpeg require a separately supplied and authorized executable with its own distribution and license obligations. Basic project read/edit/run/render does not require ffmpeg or Homebrew.

## Scratch library artwork and sounds

`resources/library/` contains 1304 unmodified Scratch support assets, stored with lossless Brotli compression. Original URLs, MD5 and SHA-256 values are preserved in [resources/library-manifest.json](resources/library-manifest.json); human-readable asset names are in `resources/libraries/`. The original metadata within each asset is retained.

Scratch support materials are offered under **CC BY-SA 2.0**, subject to trademark exceptions. The Scratch Foundation website source, section 5.2, requires this attribution:

> Scratch is developed by the Lifelong Kindergarten Group at the MIT Media Lab. See http://scratch.mit.edu.

The original authors and other rightsholders retain their rights. Keep available attribution information and source URLs, supply the license, and license adaptations of the assets under the applicable share-alike terms. Including these assets does not change the license of unrelated CLI code. Using an asset as a product logo or endorsement may require separate trademark permission.

See [license text](LICENSES/CC-BY-SA-2.0.txt) and [quoted Scratch asset terms](LICENSES/SCRATCH-ASSET-TERMS.md). The website terms endpoint was unavailable during verification; the quotations were checked against the Foundation’s published website source on 2026-10-03.

## Frozen extension gallery

The shipped extension resources come from [TurboWarp/extensions at 90192c38ce9128c5eb828ad0957e0a968de9babd](https://github.com/TurboWarp/extensions/tree/90192c38ce9128c5eb828ad0957e0a968de9babd). They are preserved byte-for-byte as recorded in `baseline.json` and `resources/RESOURCE-MANIFEST.json`.

Each extension keeps its own license and author comments. Upstream states that MIT was the historical default; current headers may specify MPL, LGPL, BSD or combinations. An empty header in [LICENSES/EXTENSIONS.json](LICENSES/EXTENSIONS.json) is recorded as empty rather than assigning it a new license. Consult the exact upstream source, its default-license statement and any embedded notices. Gallery website code has GPLv3 terms, sample projects have CC BY 4.0 terms, and fonts/images have their own notices.

All upstream gallery license texts and image attributions are copied into `LICENSES/extensions/`. The pinned archive distributed as [upstream/extensions-source.zip](upstream/extensions-source.zip) preserves the extension code, build scripts, translations, dependency manifest, attribution and license files; the 16 upstream `samples/*.sb3` project entries are excluded to keep project files out of this release. [upstream/SOURCE-MANIFEST.json](upstream/SOURCE-MANIFEST.json) records the original and filtered archive hashes and removed entries. The original upstream archive remains preserved in the local workspace and is not uploaded. The desktop source archive includes the script that exports the gallery in desktop mode and Brotli-compresses it.

## Distribution rules

Preserve `LICENSE`, `NOTICE`, this file, `LICENSES/`, `vendor/`, `baseline.json`, the lockfile and source archive references when redistributing this source tree. Keep upstream source comments intact. For bundled executables, provide the corresponding source, local modifications and build/install scripts for the exact distributed version, with clear access next to the download. Keep the portable runtime/native dependency sources and their complete notices as well. A lockfile or a link to the latest upstream branch alone is not a replacement for corresponding source.

The GPL applies to output only when that output itself contains covered software. Ordinary projects, images and sounds are not automatically GPL because they were made with the CLI; packaged HTML/executables can contain runtime code, and included assets/extensions carry their own obligations.
