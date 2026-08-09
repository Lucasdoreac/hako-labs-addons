#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
required = {"schema_version", "slug", "name", "authors", "ownership", "license", "status", "distribution"}
valid_status = {"labs", "verified", "blocked"}

for path in sorted((ROOT / "catalog").glob("*.json")):
    data = json.loads(path.read_text(encoding="utf-8"))
    missing = required - data.keys()
    if missing:
        raise SystemExit(f"{path}: missing {sorted(missing)}")
    if data["status"] not in valid_status:
        raise SystemExit(f"{path}: invalid status")
    if data["ownership"] == "third-party" and data["license"] == "permission-required":
        if data["distribution"].get("full_artifact_allowed") is not False:
            raise SystemExit(f"{path}: unlicensed third-party artifact cannot be published")
print("catalog OK")
