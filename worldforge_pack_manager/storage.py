from __future__ import annotations

import json
import shutil
import time
import uuid
from pathlib import Path


class BuildStore:
    def __init__(self, root: Path):
        self.root = root
        self.builds_dir = root / "builds"
        self.meta_file = root / "history.json"
        self.builds_dir.mkdir(parents=True, exist_ok=True)
        if not self.meta_file.exists():
            self.meta_file.write_text("[]\n", encoding="utf-8")

    def _load(self):
        try:
            data = json.loads(self.meta_file.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except Exception:
            return []

    def _save(self, rows):
        self.meta_file.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")

    def list(self):
        rows = self._load()
        return sorted(rows, key=lambda x: x.get("created_at", 0), reverse=True)

    def next_version(self):
        rows = self._load()
        nums = [int(r.get("version", 0)) for r in rows if str(r.get("version", "")).isdigit()]
        return max(nums, default=0) + 1

    def add(self, source_zip: Path, sha1: str, size: int, report: dict, public_url: str | None = None, note: str = ""):
        rows = self._load()
        version = self.next_version()
        build_id = uuid.uuid4().hex[:12]
        filename = f"WorldForge-Pack-v{version}.zip"
        target = self.builds_dir / filename
        shutil.copy2(source_zip, target)
        row = {
            "id": build_id,
            "version": version,
            "filename": filename,
            "sha1": sha1,
            "size": size,
            "created_at": int(time.time()),
            "public_url": public_url,
            "note": note,
            "report": report,
        }
        rows.append(row)
        self._save(rows)
        return row

    def get(self, build_id: str):
        return next((r for r in self._load() if r.get("id") == build_id), None)

    def path_for(self, row):
        return self.builds_dir / row["filename"]

    def restore(self, build_id: str):
        row = self.get(build_id)
        if not row:
            return None
        source = self.path_for(row)
        if not source.exists():
            return None
        return self.add(source, row["sha1"], row["size"], row.get("report", {}), row.get("public_url"), note=f"Restored from v{row['version']}")
