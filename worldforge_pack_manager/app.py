from __future__ import annotations

import io
import os
import json
import mimetypes
import shutil
import tempfile
import threading
import uuid
import webbrowser
from email.parser import BytesParser
from email.policy import default
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from .merge_engine import PackError, analyze, build_pack, extract_pack, sha1_file, zip_pack
from .publisher import maybe_publish
from .storage import BuildStore

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"


def load_config() -> dict:
    config_path = BASE_DIR / "config.json"
    example_path = BASE_DIR / "config.example.json"
    if not config_path.exists() and example_path.exists() and not os.getenv("PORT"):
        shutil.copy2(example_path, config_path)

    hosted = bool(os.getenv("PORT"))
    default_cfg = {
        "app": {
            "host": "0.0.0.0" if hosted else "127.0.0.1",
            "port": int(os.getenv("PORT", "8765")),
            "open_browser": not hosted,
            "max_upload_mb": int(os.getenv("MAX_UPLOAD_MB", "512")),
        },
        "publishing": {"enabled": False, "provider": "r2"},
    }

    try:
        loaded = json.loads(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
    except Exception:
        loaded = {}

    for section, values in default_cfg.items():
        merged = values.copy()
        if isinstance(loaded.get(section), dict):
            merged.update(loaded[section])
        loaded[section] = merged

    loaded["app"]["host"] = os.getenv("HOST", loaded["app"].get("host", "0.0.0.0" if hosted else "127.0.0.1"))
    loaded["app"]["port"] = int(os.getenv("PORT", str(loaded["app"].get("port", 8765))))
    loaded["app"]["open_browser"] = False if hosted else loaded["app"].get("open_browser", True)
    loaded["app"]["max_upload_mb"] = int(os.getenv("MAX_UPLOAD_MB", str(loaded["app"].get("max_upload_mb", 512))))

    pub = loaded["publishing"]
    env_r2 = {
        "endpoint_url": os.getenv("R2_ENDPOINT_URL", "").strip(),
        "access_key_id": os.getenv("R2_ACCESS_KEY_ID", "").strip(),
        "secret_access_key": os.getenv("R2_SECRET_ACCESS_KEY", "").strip(),
        "bucket": os.getenv("R2_BUCKET", "").strip(),
        "public_base_url": os.getenv("R2_PUBLIC_BASE_URL", "").strip(),
    }
    for key, value in env_r2.items():
        if value:
            pub[key] = value
    env_ready = all(pub.get(k) for k in ("endpoint_url", "access_key_id", "secret_access_key", "bucket", "public_base_url"))
    if os.getenv("R2_ENABLED") is not None:
        pub["enabled"] = os.getenv("R2_ENABLED", "").lower() in {"1", "true", "yes", "on"}
    elif hosted and env_ready:
        pub["enabled"] = True
    return loaded


def _multipart_files(handler: BaseHTTPRequestHandler) -> dict[str, tuple[str, bytes]]:
    ctype = handler.headers.get("Content-Type", "")
    if "multipart/form-data" not in ctype:
        return {}
    length = int(handler.headers.get("Content-Length", "0") or "0")
    max_bytes = int(getattr(handler, "max_upload_bytes", 512 * 1024 * 1024))
    if length > max_bytes:
        raise PackError(f"Upload is too large. Maximum combined upload size is {max_bytes // (1024 * 1024)} MB.")
    body = handler.rfile.read(length)
    raw = (f"Content-Type: {ctype}\r\nMIME-Version: 1.0\r\n\r\n").encode() + body
    msg = BytesParser(policy=default).parsebytes(raw)
    out = {}
    if not msg.is_multipart():
        return out
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        filename = part.get_filename()
        if name and filename:
            out[name] = (filename, part.get_payload(decode=True) or b"")
    return out


def _json_body(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if not length:
        return {}
    try:
        return json.loads(handler.rfile.read(length).decode("utf-8"))
    except Exception:
        return {}


def _prepare_pair(old_data: bytes, new_data: bytes):
    (DATA_DIR / "tmp").mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="wfpack-", dir=str(DATA_DIR / "tmp")))
    old_zip, new_zip = work / "old.zip", work / "new.zip"
    old_zip.write_bytes(old_data)
    new_zip.write_bytes(new_data)
    old_extract, new_extract = work / "old", work / "new"
    old_extract.mkdir(); new_extract.mkdir()
    old_root = extract_pack(old_zip, old_extract)
    new_root = extract_pack(new_zip, new_extract)
    return work, old_root, new_root


def _request_base_url(handler: BaseHTTPRequestHandler) -> str:
    host = handler.headers.get("X-Forwarded-Host") or handler.headers.get("Host", "127.0.0.1:8765")
    proto = handler.headers.get("X-Forwarded-Proto") or ("https" if os.getenv("RAILWAY_ENVIRONMENT") else "http")
    return f"{proto}://{host}"


def make_handler(config: dict, store: BuildStore, sessions: dict):
    class Handler(BaseHTTPRequestHandler):
        server_version = "WorldForgePackManager/1.1"
        max_upload_bytes = int(config.get("app", {}).get("max_upload_mb", 512)) * 1024 * 1024

        def log_message(self, fmt, *args):
            print("[WorldForge]", fmt % args)

        def send_json(self, obj, status=200):
            data = json.dumps(obj).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def send_bytes(self, data: bytes, content_type: str, status=200, headers=None):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = unquote(urlparse(self.path).path)
            if path == "/":
                html = (BASE_DIR / "templates" / "index.html").read_text(encoding="utf-8")
                html = html.replace("{{ url_for('static', filename='app.css') }}", "/static/app.css")
                html = html.replace("{{ url_for('static', filename='app.js') }}", "/static/app.js")
                html = html.replace("{{ 'true' if publishing_enabled else 'false' }}", "true" if config.get("publishing", {}).get("enabled") else "false")
                self.send_bytes(html.encode("utf-8"), "text/html; charset=utf-8")
                return
            if path.startswith("/static/"):
                rel = path.removeprefix("/static/")
                file_path = (BASE_DIR / "static" / rel).resolve()
                static_root = (BASE_DIR / "static").resolve()
                if static_root not in file_path.parents or not file_path.is_file():
                    self.send_error(404); return
                ctype = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
                self.send_bytes(file_path.read_bytes(), ctype); return
            if path == "/api/history":
                self.send_json({"ok": True, "builds": store.list()}); return
            if path == "/health":
                self.send_json({"ok": True}); return
            if path.startswith("/download/"):
                build_id = path.split("/")[-1]
                row = store.get(build_id)
                if not row:
                    self.send_error(404, "Build not found"); return
                file_path = store.path_for(row)
                if not file_path.exists():
                    self.send_error(404, "Build file missing"); return
                self.send_bytes(file_path.read_bytes(), "application/zip", headers={"Content-Disposition": f'attachment; filename="{row["filename"]}"'})
                return
            self.send_error(404)

        def do_POST(self):
            path = unquote(urlparse(self.path).path)
            if path == "/api/analyze":
                try:
                    files = _multipart_files(self)
                    if "old_pack" not in files or "new_pack" not in files:
                        self.send_json({"ok": False, "error": "Upload both complete packs."}, 400); return
                    work, old_root, new_root = _prepare_pair(files["old_pack"][1], files["new_pack"][1])
                    report = analyze(old_root, new_root)
                    token = uuid.uuid4().hex
                    sessions[token] = {"work": work, "old_root": old_root, "new_root": new_root, "report": report}
                    conflicts = [c for c in report["changes"] if c["action"] == "conflict"]
                    self.send_json({"ok": True, "token": token, "report": report, "conflicts": conflicts})
                except PackError as exc:
                    self.send_json({"ok": False, "error": str(exc)}, 400)
                except Exception as exc:
                    self.send_json({"ok": False, "error": f"Analysis failed: {exc}"}, 500)
                return

            if path == "/api/build":
                payload = _json_body(self)
                token = payload.get("token", "")
                session = sessions.get(token)
                if not session:
                    self.send_json({"ok": False, "error": "That merge session expired. Analyze the packs again."}, 400); return
                try:
                    output_root = session["work"] / "output"
                    if output_root.exists(): shutil.rmtree(output_root)
                    result = build_pack(session["old_root"], session["new_root"], output_root, payload.get("resolutions") or {})
                    version = store.next_version()
                    temp_zip = session["work"] / f"WorldForge-Pack-v{version}.zip"
                    zip_pack(output_root, temp_zip)
                    sha1, size = sha1_file(temp_zip), temp_zip.stat().st_size
                    public_url, publish_error = None, None
                    try: public_url = maybe_publish(temp_zip, temp_zip.name, config)
                    except Exception as exc: publish_error = str(exc)
                    row = store.add(temp_zip, sha1, size, result, public_url=public_url)
                    host_url = _request_base_url(self)
                    local_url = f"{host_url}/download/{row['id']}"
                    pack_url = public_url or local_url
                    props = f"resource-pack={pack_url}\nresource-pack-sha1={sha1}\nresource-pack-required=true"
                    sessions.pop(token, None)
                    shutil.rmtree(session["work"], ignore_errors=True)
                    self.send_json({"ok": True, "build": row, "download_url": local_url, "pack_url": pack_url, "public": bool(public_url), "server_properties": props, "publish_error": publish_error})
                except PackError as exc:
                    self.send_json({"ok": False, "error": str(exc)}, 400)
                except Exception as exc:
                    self.send_json({"ok": False, "error": f"Build failed: {exc}"}, 500)
                return

            if path.startswith("/api/restore/"):
                build_id = path.split("/")[-1]
                row = store.restore(build_id)
                if not row:
                    self.send_json({"ok": False, "error": "Build not found."}, 404); return
                host_url = _request_base_url(self)
                self.send_json({"ok": True, "build": row, "download_url": f"{host_url}/download/{row['id']}"})
                return
            self.send_error(404)
    return Handler


def run_server(config: dict | None = None):
    config = config or load_config()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "tmp").mkdir(parents=True, exist_ok=True)
    store = BuildStore(DATA_DIR)
    sessions = {}
    host = config["app"].get("host", "127.0.0.1")
    port = int(config["app"].get("port", 8765))
    server = ThreadingHTTPServer((host, port), make_handler(config, store, sessions))
    print(f"WorldForge Pack Manager running at http://{host}:{port}")
    if config["app"].get("open_browser", True):
        threading.Timer(0.8, lambda: webbrowser.open(f"http://{host}:{port}")).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
