"""Failure-safe browser evidence. Counts are unknown until each listener exists."""
import json
from .ui_local_e2e import multipart_evidence


class Observer:
    def __init__(self, out):
        self.out = out
        self.installed = {k: False for k in ("pageerror", "route", "request", "response")}
        self.errors, self.external, self.requests, self.responses = [], [], [], []
        self.phase, self.cleanup, self.failure = "startup", {}, None
        self.flush()

    def flush(self):
        value = {"listener_installed": self.installed, "phase": self.phase, "cleanup": self.cleanup,
                 "failure": self.failure, "page_errors": self.errors if self.installed["pageerror"] else None,
                 "external_requests": self.external if self.installed["route"] else None,
                 "photo_uploads": self.requests if self.installed["request"] else None,
                 "api_responses": self.responses if self.installed["response"] else None}
        temp = self.out / "observer.pending.json"
        temp.write_text(json.dumps(value, indent=2), encoding="utf-8")
        temp.replace(self.out / "observer.json")

    def stage(self, name):
        self.phase = name
        self.flush()

    def attach(self, page, base):
        def error(exc):
            self.errors.append(str(exc)); self.flush()
        def route(item):
            if item.request.url.startswith(base + "/"):
                item.continue_()
            else:
                self.external.append(item.request.url); self.flush(); item.abort()
        def request(req):
            if req.url == base + "/api/gift/photo":
                self.requests.append(multipart_evidence(req.headers["content-type"], req.post_data_buffer)); self.flush()
        def response(res):
            if res.url.startswith(base + "/api/"):
                self.responses.append({"url": res.url[len(base):], "status": res.status}); self.flush()
        for name, callback in (("pageerror", error), ("route", route), ("request", request), ("response", response)):
            if name == "route":
                page.route("**/*", callback)
            else:
                page.on(name, callback)
            self.installed[name] = True
            self.flush()
