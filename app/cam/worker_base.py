"""Worker origin validation; optional loopback HTTP for local e2e only."""
import os
import re
from urllib.parse import urlsplit

_LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "[::1]"})


def allow_local_http():
    return os.environ.get("NORI_CAM_ALLOW_LOCAL_HTTP", "").strip().lower() in ("1", "true", "yes")


def normalize_worker_base(worker_base):
    base = urlsplit(worker_base)
    if base.username or base.password or base.query or base.fragment or base.path not in ("", "/"):
        raise ValueError("Worker base must be an origin without path, query or credentials")
    if base.scheme == "https" and base.netloc:
        return worker_base.rstrip("/")
    if allow_local_http() and base.scheme == "http" and base.hostname in _LOCAL_HOSTS and base.port:
        return worker_base.rstrip("/")
    raise ValueError("Worker base must be an HTTPS origin")
