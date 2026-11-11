#!/usr/bin/env python3
"""Local trivialRANKS server: serves index.html with a stand-in for claude.ai's
`db` and `user` capabilities, backed by a SQLite file.

    python3 local/server.py            # http://localhost:8000
    python3 local/server.py --lan      # also reachable from phones on your Wi-Fi
    python3 local/server.py --port 9000 --db /path/to/other.db

Standard library only (Python 3.8+).
"""
import argparse
import json
import re
import socket
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
INDEX = ROOT / "index.html"
SHIM = HERE / "claude-shim.js"
SEGMENT = re.compile(r"^[A-Za-z0-9_\-]{1,128}$")
MAX_BODY = 1_000_000

lock = threading.Lock()
conn = None
version = 0  # bumps on every write so pollers can skip unchanged reads


def open_db(path):
    global conn, version
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS docs ("
        " path TEXT PRIMARY KEY, collection TEXT NOT NULL, data TEXT NOT NULL,"
        " updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS docs_collection ON docs(collection)")
    conn.commit()
    version = conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0]


def split_path(path, want_doc):
    """Validate a slash path. Docs have an even number of segments, collections odd."""
    parts = (path or "").strip("/").split("/")
    if not parts or not all(SEGMENT.match(p) for p in parts):
        return None
    if (len(parts) % 2 == 0) != want_doc:
        return None
    return parts


def deep_merge(base, patch):
    """Nested objects merge recursively; anything else replaces the field."""
    out = dict(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "trivialRANKS-local"

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/collection"):  # skip the 2-second polls
            super().log_message(fmt, *args)

    def send(self, code, body=b"", ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return None
        try:
            data = json.loads(self.rfile.read(n))
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        if url.path in ("/", "/index.html"):
            html = INDEX.read_text(encoding="utf-8")
            tag = '<script src="/claude-shim.js"></script>\n'
            html = html.replace("<head>", "<head>\n" + tag, 1)
            return self.send(200, html, "text/html")
        if url.path == "/claude-shim.js":
            return self.send(200, SHIM.read_text(encoding="utf-8"), "text/javascript")
        if url.path == "/api/collection":
            parts = split_path(q.get("path", [""])[0], want_doc=False)
            if not parts:
                return self.send(400, {"error": "bad collection path"})
            coll = "/".join(parts)
            since = q.get("since", [""])[0]
            with lock:
                if since and since == str(version):
                    return self.send(200, {"version": version, "unchanged": True})
                rows = conn.execute(
                    "SELECT path, data FROM docs WHERE collection = ? ORDER BY path", (coll,)
                ).fetchall()
                v = version
            docs = [{"id": p.rsplit("/", 1)[1], "data": json.loads(d)} for p, d in rows]
            return self.send(200, {"version": v, "docs": docs})
        if url.path == "/api/doc":
            parts = split_path(q.get("path", [""])[0], want_doc=True)
            if not parts:
                return self.send(400, {"error": "bad document path"})
            with lock:
                row = conn.execute("SELECT data FROM docs WHERE path = ?", ("/".join(parts),)).fetchone()
            return self.send(200, {"exists": bool(row), "data": json.loads(row[0]) if row else None})
        self.send(404, {"error": "not found"})

    def do_POST(self):
        global version
        url = urlparse(self.path)
        if url.path != "/api/doc":
            return self.send(404, {"error": "not found"})
        body = self.read_json()
        if not body or body.get("op") not in ("set", "update", "delete"):
            return self.send(400, {"error": "expected {op, path, data}"})
        parts = split_path(body.get("path"), want_doc=True)
        data = body.get("data")
        if not parts or (body["op"] != "delete" and not isinstance(data, dict)):
            return self.send(400, {"error": "bad path or data", "code": "invalid_argument"})
        path, coll = "/".join(parts), "/".join(parts[:-1])
        with lock:
            row = conn.execute("SELECT data FROM docs WHERE path = ?", (path,)).fetchone()
            if body["op"] == "delete":
                conn.execute("DELETE FROM docs WHERE path = ?", (path,))
            else:
                if body["op"] == "update":
                    if not row:
                        return self.send(404, {"error": "document does not exist", "code": "invalid_argument"})
                    data = deep_merge(json.loads(row[0]), data)
                conn.execute(
                    "INSERT INTO docs(path, collection, data) VALUES(?,?,?) "
                    "ON CONFLICT(path) DO UPDATE SET data = excluded.data, "
                    "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                    (path, coll, json.dumps(data)),
                )
            conn.commit()
            version += 1
        self.send(200, {"ok": True})


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--lan", action="store_true", help="listen on all interfaces so phones on your network can join")
    ap.add_argument("--db", default=str(HERE / "trivia.db"), help="SQLite file (default: local/trivia.db)")
    a = ap.parse_args()
    open_db(a.db)
    host = "0.0.0.0" if a.lan else "127.0.0.1"
    httpd = ThreadingHTTPServer((host, a.port), Handler)
    print("trivialRANKS local server")
    print("  database: " + a.db)
    print("  open:     http://localhost:%d" % a.port)
    if a.lan and lan_ip():
        print("  phones:   http://%s:%d  (same Wi-Fi)" % (lan_ip(), a.port))
    print("  test as a second player: add ?as=<name> to the address, e.g. ?as=ana")
    print("Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
