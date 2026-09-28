from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import zipfile
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any


SMART_MERGE_KINDS = {"font", "sounds", "lang", "atlas", "tag", "pack_mcmeta"}


@dataclass
class Change:
    path: str
    action: str
    strategy: str = ""
    detail: str = ""

    def to_dict(self):
        return asdict(self)


class PackError(Exception):
    pass


def sha1_file(path: Path) -> str:
    h = hashlib.sha1()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _safe_extract(zf: zipfile.ZipFile, destination: Path) -> None:
    base = destination.resolve()
    for member in zf.infolist():
        name = member.filename.replace("\\", "/")
        if not name or name.endswith("/"):
            continue
        target = (destination / name).resolve()
        if os.path.commonpath([str(base), str(target)]) != str(base):
            raise PackError(f"Unsafe ZIP path detected: {member.filename}")
        zf.extract(member, destination)


def extract_pack(zip_path: Path, destination: Path) -> Path:
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            bad = zf.testzip()
            if bad:
                raise PackError(f"Corrupt ZIP member: {bad}")
            _safe_extract(zf, destination)
    except zipfile.BadZipFile as exc:
        raise PackError("That file is not a valid ZIP archive.") from exc

    candidates = []
    for root, dirs, files in os.walk(destination):
        dirs[:] = [d for d in dirs if d not in {"__MACOSX", ".git"}]
        root_path = Path(root)
        if "pack.mcmeta" in files or (root_path / "assets").is_dir():
            candidates.append(root_path)
    if not candidates:
        raise PackError("No Minecraft resource-pack root was found (pack.mcmeta/assets missing).")
    candidates.sort(key=lambda p: len(p.relative_to(destination).parts))
    return candidates[0]


def _files(root: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for p in root.rglob("*"):
        if p.is_file() and p.name not in {".DS_Store"}:
            out[p.relative_to(root).as_posix()] = p
    return out


def _same_file(a: Path, b: Path) -> bool:
    if a.stat().st_size != b.stat().st_size:
        return False
    return sha1_file(a) == sha1_file(b)


def _json_load(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def _json_dump(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def _dedupe_list(values: list[Any]) -> list[Any]:
    seen = set()
    result = []
    for value in values:
        key = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        if key not in seen:
            seen.add(key)
            result.append(value)
    return result


def _recursive_dict_merge(old: Any, new: Any) -> Any:
    if isinstance(old, dict) and isinstance(new, dict):
        result = dict(old)
        for k, v in new.items():
            result[k] = _recursive_dict_merge(result[k], v) if k in result else v
        return result
    return new


def merge_kind(rel_path: str) -> str | None:
    p = rel_path.lower()
    if p == "pack.mcmeta":
        return "pack_mcmeta"
    if p.endswith("/sounds.json"):
        return "sounds"
    if "/font/" in p and p.endswith(".json"):
        return "font"
    if "/lang/" in p and p.endswith(".json"):
        return "lang"
    if "/atlases/" in p and p.endswith(".json"):
        return "atlas"
    if "/tags/" in p and p.endswith(".json"):
        return "tag"
    return None


def smart_merge_json(old_path: Path, new_path: Path, kind: str) -> Any:
    old = _json_load(old_path)
    new = _json_load(new_path)

    if kind == "font":
        if not isinstance(old, dict) or not isinstance(new, dict):
            return new
        result = _recursive_dict_merge(old, new)
        old_list = old.get("providers", []) if isinstance(old.get("providers", []), list) else []
        new_list = new.get("providers", []) if isinstance(new.get("providers", []), list) else []
        result["providers"] = _dedupe_list(old_list + new_list)
        return result

    if kind == "atlas":
        if not isinstance(old, dict) or not isinstance(new, dict):
            return new
        result = _recursive_dict_merge(old, new)
        old_list = old.get("sources", []) if isinstance(old.get("sources", []), list) else []
        new_list = new.get("sources", []) if isinstance(new.get("sources", []), list) else []
        result["sources"] = _dedupe_list(old_list + new_list)
        return result

    if kind == "tag":
        if not isinstance(old, dict) or not isinstance(new, dict):
            return new
        result = _recursive_dict_merge(old, new)
        old_vals = old.get("values", []) if isinstance(old.get("values", []), list) else []
        new_vals = new.get("values", []) if isinstance(new.get("values", []), list) else []
        if new.get("replace") is True:
            result["values"] = _dedupe_list(new_vals)
        else:
            result["values"] = _dedupe_list(old_vals + new_vals)
        return result

    if kind in {"sounds", "lang", "pack_mcmeta"}:
        return _recursive_dict_merge(old, new)

    return new


def analyze(old_root: Path, new_root: Path) -> dict:
    old_files = _files(old_root)
    new_files = _files(new_root)
    changes: list[Change] = []
    counts = {"added": 0, "updated": 0, "unchanged": 0, "smart_merged": 0, "conflicts": 0}

    all_paths = sorted(set(old_files) | set(new_files))
    for rel in all_paths:
        op = old_files.get(rel)
        np = new_files.get(rel)
        if op is None:
            counts["added"] += 1
            changes.append(Change(rel, "added", "new"))
            continue
        if np is None:
            continue
        if _same_file(op, np):
            counts["unchanged"] += 1
            changes.append(Change(rel, "unchanged", "same"))
            continue
        kind = merge_kind(rel)
        if kind:
            try:
                smart_merge_json(op, np, kind)
                counts["smart_merged"] += 1
                changes.append(Change(rel, "smart_merge", kind))
                continue
            except Exception as exc:
                changes.append(Change(rel, "conflict", "new", f"Smart merge unavailable: {exc}"))
                counts["conflicts"] += 1
                counts["updated"] += 1
                continue
        counts["conflicts"] += 1
        counts["updated"] += 1
        changes.append(Change(rel, "conflict", "new"))

    return {"counts": counts, "changes": [c.to_dict() for c in changes]}


def build_pack(old_root: Path, new_root: Path, output_dir: Path, resolutions: dict[str, str] | None = None) -> dict:
    resolutions = resolutions or {}
    output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copytree(old_root, output_dir, dirs_exist_ok=True)

    old_files = _files(old_root)
    new_files = _files(new_root)
    changes = []

    for rel, np in sorted(new_files.items()):
        target = output_dir / rel
        op = old_files.get(rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        if op is None:
            shutil.copy2(np, target)
            changes.append(Change(rel, "added", "new").to_dict())
            continue
        if _same_file(op, np):
            changes.append(Change(rel, "unchanged", "same").to_dict())
            continue

        kind = merge_kind(rel)
        if kind:
            try:
                merged = smart_merge_json(op, np, kind)
                _json_dump(target, merged)
                changes.append(Change(rel, "smart_merge", kind).to_dict())
                continue
            except Exception:
                pass

        choice = resolutions.get(rel, "new")
        if choice == "old":
            changes.append(Change(rel, "kept_old", "old").to_dict())
        else:
            shutil.copy2(np, target)
            changes.append(Change(rel, "updated", "new").to_dict())

    validation = validate_pack(output_dir)
    if not validation["valid"]:
        raise PackError("Pack validation failed: " + "; ".join(validation["errors"]))
    return {"changes": changes, "validation": validation}


def validate_pack(root: Path) -> dict:
    errors = []
    warnings = []
    if not (root / "pack.mcmeta").is_file():
        errors.append("pack.mcmeta is missing at ZIP root")
    else:
        try:
            mcmeta = _json_load(root / "pack.mcmeta")
            if not isinstance(mcmeta, dict) or "pack" not in mcmeta:
                errors.append("pack.mcmeta does not contain a top-level 'pack' object")
        except Exception as exc:
            errors.append(f"pack.mcmeta is invalid JSON: {exc}")
    if not (root / "assets").is_dir():
        warnings.append("assets/ directory is missing")

    json_errors = []
    for p in root.rglob("*.json"):
        try:
            _json_load(p)
        except Exception as exc:
            json_errors.append(f"{p.relative_to(root).as_posix()}: {exc}")
            if len(json_errors) >= 20:
                break
    if json_errors:
        errors.append(f"Invalid JSON files ({len(json_errors)} shown/max 20): " + " | ".join(json_errors))

    return {"valid": not errors, "errors": errors, "warnings": warnings}


def zip_pack(root: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for p in sorted(root.rglob("*")):
            if p.is_file():
                rel = p.relative_to(root).as_posix()
                zf.write(p, rel)


def unique_workdir(prefix="wfpack-") -> Path:
    return Path(tempfile.mkdtemp(prefix=prefix))
