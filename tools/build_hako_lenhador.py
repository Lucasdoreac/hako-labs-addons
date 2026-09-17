#!/usr/bin/env python3
"""Build the HAKO Lenhador addon deterministically."""
from __future__ import annotations

import hashlib
import json
import stat
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "hako-lenhador"


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: build_hako_lenhador.py OUTPUT.mcaddon", file=sys.stderr)
        return 2
    output = Path(sys.argv[1]).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    for pack, expected_uuid in (("bp", "0043351f-1cd1-4639-b2d8-9cbabf5cbfe7"), ("rp", "72858140-fa65-4bb5-a3bf-f6fb4b22d69e")):
        manifest = json.loads((SOURCE / pack / "manifest.json").read_text(encoding="utf-8"))
        if manifest["header"]["uuid"] != expected_uuid:
            raise ValueError(f"unexpected {pack} pack identity")
    temporary = output.with_suffix(output.suffix + ".new")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(item for item in SOURCE.rglob("*") if item.is_file()):
            relative = path.relative_to(SOURCE)
            info = zipfile.ZipInfo("HAKO_Lenhador_" + ("BP" if relative.parts[0] == "bp" else "RP") + "/" + "/".join(relative.parts[1:]), date_time=(2026, 9, 17, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | 0o640) << 16
            archive.writestr(info, path.read_bytes())
    temporary.replace(output)
    print(json.dumps({"artifact": str(output), "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
