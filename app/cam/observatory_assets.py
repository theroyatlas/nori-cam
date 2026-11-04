"""Build the R40 observatory front-end asset folder for the local owner Live server.

site/public already carries the R40 room as static files (cam-observatory.js and observatory/, built by
`npm run build:observatory` in site/), and cam.js loads it by default (`/?scene=miniature` is the same renderer),
so this only copies site/public into OUT. site/public itself is never modified.

    python -X utf8 -m app.cam.observatory_assets <out_dir>
"""
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / 'site'


def build(out):
    out = Path(out).resolve()
    if out.is_relative_to(ROOT):
        raise SystemExit('build outside the repo')
    for need in ('cam-observatory.js', 'observatory/room.glb', 'observatory/room-contract.json'):
        if not (SITE / 'public' / need).exists():
            raise SystemExit(f'site/public/{need} missing; run npm run build:observatory in site')
    shutil.copytree(SITE / 'public', out, dirs_exist_ok=True)
    return out


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    print(build(sys.argv[1]))
