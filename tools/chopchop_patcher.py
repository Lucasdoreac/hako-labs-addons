#!/usr/bin/env python3
"""Standalone patcher for "[Why Not] Chop Chop" (CurseForge, by daniswastaken).

This tool does not contain, embed, or redistribute the original addon. Run it
against your own legitimately downloaded copy of the addon (.mcaddon/.mcpack
file or an already-extracted folder); it recognises two specific unsafe code
shapes in the original script and rewrites them in place, then repackages the
result. Anything that does not match those exact shapes is left untouched.

Fixes applied (see HAKO Labs catalog entry "why-not-chop-chop-hako" for the
full gameplay contract and verification report):

  script-durability-overflow
    The original wrote tool damage before checking whether it broke, so the
    "would this hit break the tool" calculation could read a value already
    past max durability. This computes the next damage once, breaks the tool
    cleanly before ever writing an invalid value, and evaluates Unbreaking
    exactly once.

  script-tree-structure-guard
    The original flood-filled every block tagged "wood" in all directions,
    including diagonals and below - which is why it also ate planks, beams,
    and built structures. This replaces it with a conservative automaton:
    only known trunk block IDs, a straight vertical column of 3-32 blocks,
    confirmed by leaves near the top. Anything that does not match that
    shape (a built wall, a lone placed log) is left alone and breaks
    normally.

  script-durability-itemstack-resolution
    Required companion to the fix above: the new tree guard calls
    increaseDurability() once for the whole felled trunk instead of once per
    block, so it no longer has a specific itemStack to pass in. The original
    increaseDurability() assumed itemStack was always given and would throw
    immediately otherwise. This makes it resolve the player's currently held
    item itself when none is passed, and bails out cleanly if there isn't
    one.

Usage:
    python3 chopchop_patcher.py "Why Not Chop Chop.mcaddon"
    python3 chopchop_patcher.py path/to/extracted_pack_folder

Output goes next to the input with a "-hako-patched" suffix; the original
file is never modified or overwritten.
"""

from __future__ import annotations

import hashlib
import re
import shutil
import stat
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

MAX_FILES = 32768
MAX_UNPACKED = 512 * 1024 * 1024
MAX_RATIO = 200

DURABILITY_OVERFLOW = re.compile(
    r"(?P<indent>^[ \t]*)if \(shouldTakeDurabilityDamage\(itemStack\)\) damageComp\.damage \+= amount;\r?\n"
    r"(?P=indent)if \(damageComp\.damage \+ 1 >= damageComp\.maxDurability\) \{\r?\n"
    r"(?P<body>(?:(?P=indent)[ \t]+[^\r\n]*\r?\n)+?)"
    r"(?P=indent)\}",
    re.MULTILINE,
)

TREE_GUARD_MARKERS = (
    "world.beforeEvents.playerBreakBlock.subscribe",
    'block.hasTag("wood")',
    "let toBreak = [block.location]",
    'currentBlock.hasTag("wood")',
    "increaseDurability(e.player, e.itemStack)",
)
TREE_SUBSCRIPTION = re.compile(
    r"world\.beforeEvents\.playerBreakBlock\.subscribe\(\(e\) => \{.*?\n\}\);(?=\n//#endregion)",
    re.DOTALL,
)
SAFE_TREE_SUBSCRIPTION = '''const TREE_LOG_TYPES = new Set([
\t"minecraft:oak_log", "minecraft:spruce_log", "minecraft:birch_log",
\t"minecraft:jungle_log", "minecraft:acacia_log", "minecraft:dark_oak_log",
\t"minecraft:mangrove_log", "minecraft:cherry_log", "minecraft:pale_oak_log"
]);
const MAX_TRUNK_HEIGHT = 32;
function isTreeLog(block) {
\treturn block && TREE_LOG_TYPES.has(block.typeId);
}
function isLeaf(block) {
\treturn block && block.typeId.endsWith("_leaves");
}
function collectNaturalTrunk(dimension, origin) {
\tconst logs = [];
\tfor (let offset = 0; offset < MAX_TRUNK_HEIGHT; offset++) {
\t\tconst location = { x: origin.x, y: origin.y + offset, z: origin.z };
\t\tconst candidate = dimension.getBlock(location);
\t\tif (!isTreeLog(candidate)) break;
\t\tlogs.push(location);
\t}
\tif (logs.length < 3) return [];
\tconst top = logs[logs.length - 1];
\tfor (let dx = -2; dx <= 2; dx++) {
\t\tfor (let dy = -1; dy <= 3; dy++) {
\t\t\tfor (let dz = -2; dz <= 2; dz++) {
\t\t\t\tif (isLeaf(dimension.getBlock({ x: top.x + dx, y: top.y + dy, z: top.z + dz }))) {
\t\t\t\t\treturn logs;
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\treturn [];
}
world.beforeEvents.playerBreakBlock.subscribe((e) => {
\tif (!e.player.isSneaking || !isTreeLog(e.block)) return;
\tconst dimension = e.block.dimension;
\tconst logs = collectNaturalTrunk(dimension, e.block.location);
\tif (logs.length === 0) return;
\te.cancel = true;
\tsystem.run(() => {
\t\tfor (const location of logs) {
\t\t\tdimension.runCommand(`setblock ${location.x} ${location.y} ${location.z} air destroy`);
\t\t}
\t\tincreaseDurability(e.player, void 0, logs.length);
\t});
});'''


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_extract(archive: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if len(entries) > MAX_FILES:
            raise ValueError(f"archive has more than {MAX_FILES} entries")
        total = sum(item.file_size for item in entries)
        if total > MAX_UNPACKED:
            raise ValueError("unpacked content exceeds 512 MiB")
        for item in entries:
            normalized = item.filename.replace("\\", "/")
            if normalized == "/" and item.is_dir() and item.file_size == 0:
                continue
            path = PurePosixPath(normalized)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError(f"unsafe path in ZIP: {item.filename}")
            mode = item.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise ValueError(f"symlink not allowed: {item.filename}")
            if item.flag_bits & 1:
                raise ValueError(f"encrypted entry not allowed: {item.filename}")
            if item.compress_size and item.file_size / item.compress_size > MAX_RATIO:
                raise ValueError(f"suspicious compression ratio: {item.filename}")
        destination.mkdir(parents=True, exist_ok=True)
        for item in entries:
            normalized = item.filename.replace("\\", "/")
            if normalized == "/" and item.is_dir() and item.file_size == 0:
                continue
            path = PurePosixPath(normalized)
            target = destination.joinpath(*path.parts)
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open(item) as compressed, target.open("wb") as extracted:
                shutil.copyfileobj(compressed, extracted)


def bump_patch_version(value: object) -> object:
    if isinstance(value, list) and len(value) == 3 and all(isinstance(part, int) for part in value):
        return [value[0], value[1], value[2] + 1]
    if isinstance(value, str):
        match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(.*)", value)
        if match:
            major, minor, patch, rest = match.groups()
            return f"{major}.{minor}.{int(patch) + 1}{rest}"
    raise ValueError(f"cannot bump manifest version: {value!r}")


def repair_durability_overflow(root: Path) -> list[dict]:
    repairs = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".js", ".ts"}:
            continue
        try:
            source = path.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            continue
        before_hash = sha256_file(path)

        def replacement(match: re.Match) -> str:
            indent = match.group("indent")
            body = match.group("body")
            return (
                f"{indent}const takeDurabilityDamage = shouldTakeDurabilityDamage(itemStack);\n"
                f"{indent}const nextDamage = damageComp.damage + amount;\n"
                f"{indent}if (takeDurabilityDamage && nextDamage >= damageComp.maxDurability) {{\n"
                f"{body}"
                f"{indent}}} else if (takeDurabilityDamage) {{\n"
                f"{indent}\tdamageComp.damage = nextDamage;\n"
                f"{indent}}}"
            )

        repaired, count = DURABILITY_OVERFLOW.subn(replacement, source)
        if count == 0:
            continue
        if count > 1:
            raise ValueError(f"more than one durability transition in {path.name}; needs human review")
        with open(path, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(repaired)
        repairs.append({
            "code": "script-durability-overflow",
            "file": str(path.relative_to(root)),
            "before_sha256": before_hash,
            "after_sha256": sha256_file(path),
        })
    return repairs


def repair_tree_structure_guard(root: Path) -> list[dict]:
    repairs = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".js", ".ts"}:
            continue
        source = path.read_text(encoding="utf-8-sig")
        if not all(marker in source for marker in TREE_GUARD_MARKERS):
            continue
        before_hash = sha256_file(path)
        repaired, count = TREE_SUBSCRIPTION.subn(SAFE_TREE_SUBSCRIPTION, source)
        if count != 1:
            raise ValueError(f"ambiguous chopping flow in {path.name}; needs human review")
        with open(path, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(repaired)
        repairs.append({
            "code": "script-tree-structure-guard",
            "file": str(path.relative_to(root)),
            "before_sha256": before_hash,
            "after_sha256": sha256_file(path),
        })
    return repairs


ITEMSTACK_GUARD_INSERT = re.compile(
    r"(function increaseDurability\(player, itemStack, amount = 1\) \{\r?\n)"
    r"(\tlet damageComp = itemStack\.getComponent\(\"minecraft:durability\"\);)"
)
ITEMSTACK_GUARD_SETITEM = re.compile(
    r'\tplayer\.getComponent\("inventory"\)\.container\.setItem\(player\.selectedSlotIndex, itemStack\);'
)


def repair_itemstack_resolution(root: Path) -> list[dict]:
    repairs = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".js", ".ts"}:
            continue
        try:
            source = path.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            continue
        insert_count = len(ITEMSTACK_GUARD_INSERT.findall(source))
        setitem_count = len(ITEMSTACK_GUARD_SETITEM.findall(source))
        if insert_count == 0 and setitem_count == 0:
            continue
        if insert_count != 1 or setitem_count != 1:
            raise ValueError(f"ambiguous increaseDurability shape in {path.name}; needs human review")
        before_hash = sha256_file(path)
        repaired = ITEMSTACK_GUARD_INSERT.sub(
            r"\1"
            "\tconst inventory = player.getComponent(\"inventory\")?.container;\n"
            "\tif (!inventory) return;\n"
            "\titemStack ??= inventory.getItem(player.selectedSlotIndex);\n"
            "\tif (!itemStack) return;\n"
            r"\2",
            source,
        )
        repaired = ITEMSTACK_GUARD_SETITEM.sub(
            "\tinventory.setItem(player.selectedSlotIndex, itemStack);", repaired
        )
        with open(path, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(repaired)
        repairs.append({
            "code": "script-durability-itemstack-resolution",
            "file": str(path.relative_to(root)),
            "before_sha256": before_hash,
            "after_sha256": sha256_file(path),
        })
    return repairs


def bump_all_manifests(root: Path) -> None:
    import json
    for manifest_path in root.rglob("manifest.json"):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        header = manifest.get("header")
        if isinstance(header, dict) and "version" in header:
            header["version"] = bump_patch_version(header["version"])
        for module in manifest.get("modules", []) or []:
            if isinstance(module, dict) and "version" in module:
                module["version"] = bump_patch_version(module["version"])
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=4) + "\n", encoding="utf-8"
        )


def rezip(root: Path, destination: Path) -> None:
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(root.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(root).as_posix())


def patch(input_path: Path) -> Path:
    is_archive = input_path.is_file() and input_path.suffix.lower() in {".mcaddon", ".mcpack", ".zip"}
    if not is_archive and not input_path.is_dir():
        raise ValueError("input must be a .mcaddon/.mcpack file or an extracted folder")

    with tempfile.TemporaryDirectory(prefix="chopchop-patch-") as workdir_name:
        workdir = Path(workdir_name)
        if is_archive:
            extracted = workdir / "extracted"
            safe_extract(input_path, extracted)
        else:
            extracted = workdir / "extracted"
            shutil.copytree(input_path, extracted)

        repairs = (
            repair_durability_overflow(extracted)
            + repair_tree_structure_guard(extracted)
            + repair_itemstack_resolution(extracted)
        )
        if not repairs:
            raise ValueError(
                "no known unsafe pattern found - either this copy is already patched, "
                "or this is not the original [Why Not] Chop Chop script"
            )
        bump_all_manifests(extracted)

        print("Applied fixes:")
        for repair in repairs:
            print(f"  - {repair['code']} in {repair['file']}")
            print(f"      before: {repair['before_sha256']}")
            print(f"      after:  {repair['after_sha256']}")

        suffix = ".mcaddon" if is_archive and input_path.suffix.lower() == ".mcaddon" else (
            ".mcpack" if is_archive else ""
        )
        if suffix:
            output = input_path.with_name(input_path.stem + "-hako-patched" + suffix)
            rezip(extracted, output)
        else:
            output = input_path.with_name(input_path.name + "-hako-patched")
            if output.exists():
                shutil.rmtree(output)
            shutil.copytree(extracted, output)
        return output


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    input_path = Path(sys.argv[1]).expanduser().resolve()
    if not input_path.exists():
        print(f"not found: {input_path}", file=sys.stderr)
        return 2
    try:
        output = patch(input_path)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"\nDone. Patched copy written to:\n  {output}")
    print("Your original file was not modified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
