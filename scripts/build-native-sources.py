#!/usr/bin/env python3
"""Package exact downloaded resvg source trees with provenance; never include projects or native binaries."""
import hashlib
import json
import pathlib
import re
import sys
import tarfile
import zipfile


def main():
    if len(sys.argv) != 4:
        raise SystemExit('Usage: build-native-sources.py resvg-js-v2.6.2.tar.gz resvg-3495d870.tar.gz output.zip')
    records = [
        (pathlib.Path(sys.argv[1]), 'resvg-js-v2.6.2', 'https://codeload.github.com/yisibl/resvg-js/tar.gz/refs/tags/v2.6.2'),
        (pathlib.Path(sys.argv[2]), 'resvg-3495d870', 'https://codeload.github.com/zimond/resvg/tar.gz/3495d870'),
    ]
    output = pathlib.Path(sys.argv[3])
    manifest = {'version': 1, 'component': '@resvg/resvg-js', 'versionInstalled': '2.6.2', 'license': 'MPL-2.0',
                'notes': 'Unmodified source files from the matching release tag and its Cargo.toml pinned resvg fork. Project files, image/font/sample binaries and compressed archives omitted. Upstream tag does not ship Cargo.lock; byte-identical native rebuild is not claimed.',
                'archives': [], 'files': {}}
    excluded = re.compile(r'\.(?:sb|sb2|sb3|sprite2|sprite3|blend|node|dylib|dll|so|exe|a|o|wasm|png|jpg|jpeg|gif|webp|bmp|wav|mp3|ogg|ttf|otf|woff2?|zip|gz|xz|br|pdf)$', re.I)
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for filename, prefix, url in records:
            data = filename.read_bytes()
            manifest['archives'].append({'source': url, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
            with tarfile.open(filename, 'r:gz') as upstream:
                for member in upstream.getmembers():
                    if not member.isfile():
                        continue
                    parts = pathlib.PurePosixPath(member.name).parts
                    if len(parts) < 2 or '..' in parts or member.name.startswith('/'):
                        raise ValueError('Unsafe source archive path')
                    relative = '/'.join(parts[1:])
                    if excluded.search(relative) or any(part in ['.git', 'node_modules', 'target'] for part in parts):
                        continue
                    content = upstream.extractfile(member).read()
                    name = prefix + '/' + relative
                    archive.writestr(name, content)
                    manifest['files'][name] = {'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
        archive.writestr('SOURCE-MANIFEST.json', json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    data = output.read_bytes()
    print(json.dumps({'path': str(output.resolve()), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'files': len(manifest['files'])}, indent=2))


if __name__ == '__main__':
    main()
