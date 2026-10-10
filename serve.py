#!/usr/bin/env python3
"""Serve the DisplayLink Previewer locally, optionally preloading a library folder.

    python3 serve.py                          # app only; open a folder in the page
    python3 serve.py ~/Downloads/Templates    # app with that folder preloaded

Binds to 127.0.0.1 only. The library is served read-only under /library/.
"""

import argparse
import http.server
import json
import os
import pathlib
import urllib.parse
import webbrowser

WEB = pathlib.Path(__file__).resolve().parent / "web"
EXTS = {".tpl", ".seq", ".png", ".jpg", ".jpeg", ".bmp", ".gif"}


def build_index(lib):
    """List the previewable files under `lib` as POSIX paths relative to it."""
    files = []
    for p in sorted(lib.rglob("*")):
        if p.is_file() and p.suffix.lower() in EXTS:
            files.append(p.relative_to(lib).as_posix())
    return files


def make_handler(lib):
    """Build a request handler serving web/ plus `lib` read-only under /library/."""

    class Handler(http.server.SimpleHTTPRequestHandler):
        """Static app files, plus the optional library folder."""

        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(WEB), **kw)

        def log_message(self, format, *args):  # pylint: disable=redefined-builtin
            """Keep the console quiet."""

        def do_GET(self):
            path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
            if not path.startswith("/library/"):
                super().do_GET()
                return
            if lib is None:
                self.send_error(404)
                return
            rel = path[len("/library/") :]
            if rel == "index.json":
                self._send(json.dumps(build_index(lib)).encode(), "application/json")
                return
            target = (lib / rel).resolve()
            # Refuse anything outside the library or of an unexpected type.
            if (
                lib not in target.parents
                or not target.is_file()
                or target.suffix.lower() not in EXTS
            ):
                self.send_error(404)
                return
            self._send(target.read_bytes(), "application/octet-stream")

        def _send(self, body, ctype):
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main():
    """Parse arguments, start the server and open the browser."""
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "library", nargs="?", help="DisplayLink Templates folder to preload"
    )
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    lib = (
        pathlib.Path(os.path.expanduser(args.library)).resolve()
        if args.library
        else None
    )
    if lib and not lib.is_dir():
        ap.error(f"not a folder: {lib}")

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", args.port), make_handler(lib)
    )
    url = f"http://127.0.0.1:{args.port}/"
    print(f"DisplayLink Previewer at {url}" + (f"  (library: {lib})" if lib else ""))
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
