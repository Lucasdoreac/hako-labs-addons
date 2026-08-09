#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import stat
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "hako-agent"
ALLOWED = ("manifest.json", "scripts/main.js")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: build_hako_agent.py OUTPUT.mcpack", file=sys.stderr)
        return 2
    output = Path(sys.argv[1]).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    if manifest["header"]["uuid"] != "7a3c3b9f-9d6b-4f91-a2d8-3c6f4e5a1001":
        raise ValueError("unexpected pack identity")
    temporary = output.with_suffix(output.suffix + ".new")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relative in ALLOWED:
            info = zipfile.ZipInfo(relative, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | 0o640) << 16
            archive.writestr(info, (SOURCE / relative).read_bytes())
    temporary.replace(output)
    print(json.dumps({"artifact": str(output), "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
