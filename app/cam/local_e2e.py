"""End-to-end local photo gift chain against wrangler dev --local (fake models by default)."""
import argparse
import hashlib
import io
import json
import math
import os
import re
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler

from PIL import Image, ImageDraw

from .fake_clients import FakeImage, FakeSpark, fake_clients
from .pipeline import run as run_pipeline
from .wake import run_reflect
from .worker_base import allow_local_http

ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "site"
# Fresh chain fixtures always start at noon UTC, 3 November 2026.
CHAIN_START_MS = 1793707200000

DEFAULT_STAGE_FRACTIONS = {
    "plan": 0.35,
    "act": 0.15,
    "settle": 0.30,
    "reflect_wait": 0.12,
    "reflect_run": 0.05,
    "after": 0.03,
}

LIVE_WORKER_VARS = """
# Review docs/research/spikes/r30-engineering/LIVE-CANDIDATE.md first.
# Use its explicit isolated config/persist directory and a dedicated loopback port.
# No cron; Spark reactions/browse OFF; local reflection ON; no real key in config.
""".strip()

LIVE_RUNNER_CMD = (
    "python -X utf8 -m app.cam.live_candidate"  # Prints the approval plan only.
)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _http(method, url, headers=None, body=None, timeout=120):
    request = Request(url, data=body, headers=headers or {}, method=method)
    try:
        with build_opener(NoRedirect).open(request, timeout=timeout) as response:
            data = response.read(8 * 1024 * 1024 + 1)
            if len(data) > 8 * 1024 * 1024:
                raise ValueError("response too large")
            return response.status, data, dict(response.headers)
    except HTTPError as error:
        body = error.read() if error.fp else b""
        return error.code, body, dict(error.headers)


def _iso():
    return datetime.now(timezone.utc).astimezone().isoformat()


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _inside_repo(path: Path) -> bool:
    try:
        path.resolve().relative_to(ROOT.resolve())
        return True
    except ValueError:
        return False


def _require_env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"missing environment variable {name}")
    return value


def _multipart_photo(photo: bytes, mime: str, idem: str, owner_code: str):
    boundary = f"----nori-cam-{uuid.uuid4().hex}"
    filename = "gift.png" if mime == "image/png" else "gift.jpg"
    parts = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"idem\"\r\n\r\n{idem}\r\n",
        (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
         f"Content-Type: {mime}\r\n\r\n").encode() + photo + b"\r\n",
        f"--{boundary}--\r\n",
    ]
    body = b"".join(p if isinstance(p, bytes) else p.encode() for p in parts)
    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "X-Nori-Code": owner_code,
    }
    return body, headers


def _json_request(base, path, token=None, query=None, method="GET", payload=None, owner_code=None):
    url = base + path
    if query:
        url += "?" + urlencode(query)
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if owner_code:
        headers["X-Nori-Code"] = owner_code
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload, allow_nan=False).encode()
    else:
        body = None
    return _http(method, url, headers, body)


def _run_site(args):
    persist = os.environ.get("NORI_CAM_LOCAL_PERSIST")
    if args[:3] == ["npm", "run", "db:local"]:
        args = ["npx", "wrangler", "d1", "migrations", "apply", "DB", "--local"]
    if persist and args[:3] == ["npx", "wrangler", "d1"]:
        args = [*args, "--persist-to", persist]
    config = os.environ.get("NORI_CAM_LOCAL_CONFIG")
    if config and args[:2] == ["npx", "wrangler"]:
        args = [*args, "--config", config]
    if args[:2] == ["npx", "wrangler"]:
        args = [str(SITE / "node_modules" / ".bin" / ("wrangler.cmd" if sys.platform == "win32" else "wrangler")), *args[2:]]
    kwargs = {"cwd": SITE, "check": True}
    if sys.platform == "win32":
        kwargs["shell"] = True
    subprocess.run(args, **kwargs)


def _d1_rows(sql: str):
    persist = os.environ.get("NORI_CAM_LOCAL_PERSIST")
    args = [str(SITE / "node_modules" / ".bin" / ("wrangler.cmd" if sys.platform == "win32" else "wrangler")),
            "d1", "execute", "DB", "--local", "--command", sql, "--json"]
    if persist:
        args += ["--persist-to", persist]
    config = os.environ.get("NORI_CAM_LOCAL_CONFIG")
    if config:
        args += ["--config", config]
    proc = subprocess.run(
        args,
        cwd=SITE,
        capture_output=True,
        text=True,
        shell=sys.platform == "win32",
    )
    if proc.returncode != 0:
        raise RuntimeError(f"d1 query failed: {proc.stderr[:500]}")
    payload = json.loads(proc.stdout)
    if not payload:
        return []
    block = payload[0]
    results = block.get("results") or []
    if results and isinstance(results[0], dict) and "rows" in results[0]:
        return results[0]["rows"]
    return results


def _d1_scalar(sql: str, key="v"):
    rows = _d1_rows(sql)
    if not rows:
        return None
    row = rows[0]
    if isinstance(row, dict):
        return row.get(key) if key in row else next(iter(row.values()))
    return row[0]


def _seed_local_db(fixed_start=False):
    _run_site(["npm", "run", "db:local"])
    reset = SITE / "scripts" / "cam-local-reset.sql"
    _run_site(["npx", "wrangler", "d1", "execute", "DB", "--local", "--file", str(reset)])
    seed = SITE / "migrations" / "0003_cam_seed.sql"
    _run_site(["npx", "wrangler", "d1", "execute", "DB", "--local", "--file", str(seed)])
    if not fixed_start:
        return
    state = {"nori": {"energy": 0.7, "curiosity": 0.6, "security": 0.7, "asleep": False,
                      "sleep_started_at": None, "variant": "default"},
             "prefs": dict.fromkeys(("soft", "shelter", "height", "view_far", "sound", "motion", "light", "warm"), 0.5),
             "wariness": dict.fromkeys(("soft", "shelter", "height", "view_far", "sound", "motion", "light", "warm"), 0),
             "familiarity": {}, "novelty": {}, "habits": {}, "missing": [], "settled_through": CHAIN_START_MS}
    state_json = json.dumps(state, separators=(",", ":"))
    _run_site(["npx", "wrangler", "d1", "execute", "DB", "--local", "--command",
               f"UPDATE world SET version=0,writer='seed',timeline_until={CHAIN_START_MS},"
               f"state_json='{state_json}',updated_at={CHAIN_START_MS} WHERE id=1"])


def _wait_worker(base, seconds=60):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            status, _, _ = _http("GET", base + "/api/cam")
            if status in (200, 503):
                return
        except (URLError, TimeoutError, ValueError):
            pass
        time.sleep(0.5)
    raise SystemExit("worker not reachable; start wrangler dev --local first")


def _local_scheduled_url(base: str) -> str:
    return base.rstrip("/") + "/cdn-cgi/local/scheduled"


def _trigger_scheduled(base):
    try:
        _http("POST", _local_scheduled_url(base), timeout=30)
    except (URLError, TimeoutError, ValueError, OSError):
        pass


class CronDriver:
    def __init__(self, base: str, every_s: float):
        self.base = base
        self.every = every_s
        self._last = 0.0

    def tick(self):
        now = time.monotonic()
        if now - self._last >= self.every:
            _trigger_scheduled(self.base)
            self._last = now


class VirtualClock:
    """LOCAL-ONLY virtual clock (Worker env CAM_LOCAL_PIPELINE=1).

    Advances Worker time in steps to the next segment boundary so the full
    plan -> act -> settle -> reflect -> after chain is observable in minutes
    of wall time. Every advance is recorded in trail.json as
    {"step": "test_setup_clock_advance", ...}. Stages are never skipped;
    only waiting is skipped.
    """

    def __init__(self, base: str):
        self.base = base

    def get(self):
        status, body, _ = _http("GET", self.base + "/api/cam/test/clock", timeout=30)
        if status != 200:
            raise SystemExit(
                "virtual clock unavailable; rebuild the Worker from this worktree "
                f"(GET /api/cam/test/clock -> {status})"
            )
        return int(json.loads(body.decode())["now"])

    def set(self, to_ms):
        payload = json.dumps({"now": int(to_ms)}).encode()
        status, body, _ = _http(
            "POST", self.base + "/api/cam/test/clock",
            {"Content-Type": "application/json"}, payload, timeout=30)
        if status != 200:
            raise SystemExit(f"virtual clock advance refused: {status} {body[:200]!r}")
        return int(json.loads(body.decode())["now"])


def _next_boundary(cam):
    """Visit starts too: a reflection dispatch is eligible only after sleep starts."""
    now = cam.get("server_now", 0)
    ends = sorted(s.get(key, 0) for s in cam.get("segments") or [] for key in ("start_at", "end_at"))
    ends = [e for e in ends if e > now]
    if ends:
        return ends[0]
    return max(int(cam.get("timeline_until", now)), now)


def _fetch_cam(base):
    status, body, _ = _json_request(base, "/api/cam")
    if status != 200:
        return None
    return json.loads(body.decode())


def _placement_evidence(cam, object_id):
    """Unwrapped gift placement from the Worker /api/cam snapshot (no D1)."""
    for obj in (cam or {}).get("objects") or []:
        if obj.get("id") == object_id:
            return {"status": obj.get("status"), "x": obj.get("x"),
                    "y": obj.get("y"), "placement": obj.get("placement")}
    return None


def _placement_check(object_id, cam):
    """Stage_placement decision from a Worker /api/cam snapshot. Pure; no network."""
    placement = _placement_evidence(cam, object_id)
    if placement is None:
        placement = {"status": "missing", "x": None, "y": None, "placement": None}
    ok = placement.get("status") == "placed"
    reasons = [] if ok else [f"gift not placed: {placement.get('status')}"]
    return placement, ok, reasons


def _fetch_record(base, owner_code, limit=300):
    status, body, _ = _http(
        "GET",
        base + f"/api/record?debug=1&limit={limit}",
        {"X-Nori-Code": owner_code},
    )
    if status != 200:
        return []
    record = json.loads(body.decode())
    return record.get("events") or []


def _trail_entry(step, *, model, started, ended, input_summary, output_summary, ok, reasons, cost_usd,
                  cost_basis, ids, extra=None):
    entry = {
        "step": step,
        "model": model,
        "started": started,
        "ended": ended,
        "input_summary": input_summary,
        "output_summary": output_summary,
        "validation": {"ok": ok, "reasons": reasons},
        "cost_usd": cost_usd,
        "cost_basis": cost_basis,
        "ids": ids,
    }
    if extra:
        entry.update(extra)
    return entry


def _poll_stage(name, check_fn, deadline, trail, clock: VirtualClock, base, owner_code, token, *,
                model="none", input_summary=None):
    started = _iso()
    input_summary = input_summary or {}
    last_progress = None
    while time.monotonic() < deadline:
        result = check_fn()
        if result:
            trail.append(_trail_entry(
                name,
                model=model,
                started=started,
                ended=_iso(),
                input_summary=input_summary,
                output_summary=result,
                ok=True,
                reasons=[f"{name} observed"],
                cost_usd=0.0,
                cost_basis="local",
                ids={k: result[k] for k in result if k.endswith("_id") or k in ("segment_id", "object_id")},
            ))
            return result
        if result is False:
            last_progress = "waiting"
        # Skip waiting only: jump the virtual clock to the next segment
        # boundary, run cron at that time, then re-check. Every advance is
        # recorded; no stage is ever skipped.
        cam = _fetch_cam(base)
        if cam is None:
            last_progress = "cam_unreachable"
            time.sleep(2)
            continue
        target = _next_boundary(cam)
        if target <= cam.get("server_now", 0):
            target = cam.get("server_now", 0) + 1
        advanced_to = clock.set(target)
        # GET advances the normal timeline and its cloud work. Do not invoke the
        # shared cron: it also refreshes weather and calls the legacy wake path.
        _json_request(base, "/api/cam")
        trail.append(_trail_entry(
            "test_setup_clock_advance",
            model="none",
            started=_iso(),
            ended=_iso(),
            input_summary={"stage": name, "from": cam.get("server_now"), "to": target},
            output_summary={"advanced_to": advanced_to},
            ok=True,
            reasons=["skip waiting only"],
            cost_usd=0.0,
            cost_basis="local",
            ids={},
        ))
    trail.append(_trail_entry(
        name,
        model=model,
        started=started,
        ended=_iso(),
        input_summary=input_summary,
        output_summary={"last_progress": last_progress},
        ok=False,
        reasons=[f"{name} timeout"],
        cost_usd=0.0,
        cost_basis="local",
        ids={},
    ))
    return None


def _world_version():
    return _d1_scalar("SELECT version AS v FROM world WHERE id=1")


def _segment_plan_match(cam, object_id):
    if not cam:
        return None
    server_now = cam.get("server_now")
    for seg in cam.get("segments") or []:
        if seg.get("target") != object_id:
            continue
        if not seg.get("interaction"):
            continue
        return {
            "segment_id": seg.get("id"),
            "interaction_id": seg.get("interaction"),
            "start_at": seg.get("start_at"),
            "end_at": seg.get("end_at"),
            "world_version": cam.get("world_version"),
            "server_now": server_now,
        }
    return None


def _act_evidence(base, owner_code, object_id, segment_id):
    # Public /api/cam retains only a short rolling window. Settlement can occur
    # after that window, so a completed segment may already be absent there.
    # Require the exact planned segment in a persisted experience, plus its
    # completion event, instead of accepting any event mentioning this object.
    if not isinstance(segment_id, int):
        return None
    target = object_id.replace("'", "''")
    rows = _d1_rows(
        "SELECT x.id AS experience_id,s.id AS segment_id,e.id AS event_id "
        "FROM segments s JOIN experiences x ON x.object_id=s.target "
        "AND x.interaction_id=s.interaction "
        "AND EXISTS(SELECT 1 FROM json_each(x.segment_ids) j WHERE j.value=s.id) "
        "JOIN events e ON e.type='interaction_done' AND "
        "e.id LIKE 'interaction_done:' || json_extract(x.segment_ids,'$[#-1]') || ':%' "
        f"WHERE s.id={segment_id} AND s.target='{target}' AND s.settled_at IS NOT NULL "
        "AND s.superseded_at IS NULL AND s.cut_at IS NULL LIMIT 1"
    )
    if not rows:
        return None
    row = rows[0]
    return {"segment_id": row["segment_id"], "experience_id": row["experience_id"],
            "event_ids": [row["event_id"]]}


def _settle_evidence(base, owner_code, object_id, experience_id=None):
    # D1 directly: /api/record's limit window fills with per-advance system
    # events on long virtual runs and would hide the experience event.
    # Oldest experience first: the first completed gift interaction.
    match = " AND id='" + experience_id.replace("'", "''") + "'" if experience_id else ""
    rows = _d1_rows(
        "SELECT id,at,appraisal,pref_deltas,wariness_deltas,familiarity_delta "
        f"FROM experiences WHERE object_id='{object_id}'{match} ORDER BY at ASC LIMIT 1"
    )
    if not rows:
        return None
    row = rows[0]
    if not isinstance(row, dict):
        return None
    detail = {
        "appraisal": row.get("appraisal"),
        "pref_deltas": json.loads(row["pref_deltas"]) if row.get("pref_deltas") else None,
        "wariness_deltas": json.loads(row["wariness_deltas"]) if row.get("wariness_deltas") else None,
        "familiarity_delta": row.get("familiarity_delta"),
    }
    return {"experience_id": row.get("id"), "target": object_id, "at": row.get("at"), **detail}


def _reflect_dispatched():
    rows = _d1_rows(
        "SELECT id FROM segments WHERE trigger_status='dispatched' "
        "AND json_extract(trigger,'$.kind')='reflect' ORDER BY trigger_claimed_at DESC LIMIT 1"
    )
    if not rows:
        return None
    seg_id = rows[0]["id"] if isinstance(rows[0], dict) else rows[0][0]
    return {"segment_id": seg_id, "intent_id": f"seg:{seg_id}"}


def _reflection_evidence(intent_id, experience_id):
    """Accept only this dispatch's persisted reflection, citation, intent and cost.

    Wonder cites event IDs, not experience IDs. Resolve the exact experience via
    the experience_settled event; substring matching would accept another run.
    """
    if not re.fullmatch(r"seg:\d+", intent_id):
        return {}, ["invalid reflection intent"]
    key = f"ingest:{intent_id}:wonder_result"
    rows = _d1_rows(
        "SELECT e.id,e.payload,m.ok,"
        "EXISTS(SELECT 1 FROM budget_ledger b WHERE b.id IN "
        f"('res:wonder:{intent_id}','res:wonder:{intent_id}:retry') "
        "AND b.status='settled' AND b.actual_usd=m.cost_usd) AS budget_settled,"
        "EXISTS(SELECT 1 FROM intents i WHERE i.trigger_event=e.id AND i.source='wonder') AS intent_persisted "
        f"FROM events e LEFT JOIN model_calls m ON m.id=e.id AND m.ref='{intent_id}' "
        f"WHERE e.id='{key}' AND e.type='reflection'"
    )
    if not rows:
        return {}, ["matching reflection not persisted"]
    row = rows[0]
    try:
        cited = json.loads(row["payload"])["reflection"]["event_ids"]
    except (KeyError, TypeError, json.JSONDecodeError):
        cited = []
    events = _d1_rows("SELECT id,payload FROM events WHERE type='experience_settled'")
    experience_events = []
    for event in events:
        try:
            if json.loads(event["payload"]).get("experience") == experience_id:
                experience_events.append(event["id"])
        except (TypeError, json.JSONDecodeError):
            continue
    evidence = {"reflection_event_id": row["id"],
                "cites_experience": isinstance(cited, list) and any(e in cited for e in experience_events),
                "budget_settled": bool(row.get("budget_settled")),
                "intent_persisted": bool(row.get("intent_persisted")),
                "model_call_ok": row.get("ok") == 1}
    return evidence, [name for name in ("cites_experience", "budget_settled", "intent_persisted", "model_call_ok")
                      if not evidence[name]]


def _after_snapshot(base, object_id):
    cam = _fetch_cam(base)
    rows = _d1_rows("SELECT state_json FROM world WHERE id=1")
    state = json.loads(rows[0]["state_json"] if isinstance(rows[0], dict) else rows[0][0]) if rows else {}
    fam = (state.get("familiarity") or {}).get(object_id)
    habits = state.get("habits") or {}
    novelty = (state.get("novelty") or {}).get(object_id)
    wariness = (state.get("wariness") or {}).get(object_id)
    exploration = state.get("exploration")
    segments = []
    if cam:
        future = sorted(
            [s for s in cam.get("segments") or [] if s.get("end_at", 0) > cam.get("server_now", 0)],
            key=lambda s: s.get("start_at", 0),
        )
        for seg in future[:3]:
            segments.append({
                "id": seg.get("id"),
                "start_at": seg.get("start_at"),
                "end_at": seg.get("end_at"),
                "action": seg.get("action"),
                "target": seg.get("target"),
                "interaction": seg.get("interaction"),
            })
    return {
        "familiarity": fam,
        "habits": habits,
        "novelty": novelty,
        "wariness": wariness,
        "exploration_nudge": exploration,
        "next_segments": segments,
    }


def _budget_spend_usd():
    settled = float(_d1_scalar(
        "SELECT COALESCE(SUM(actual_usd),0) AS v FROM budget_ledger WHERE status='settled'"
    ) or 0)
    calls = float(_d1_scalar(
        "SELECT COALESCE(SUM(cost_usd),0) AS v FROM model_calls WHERE ok=1"
    ) or 0)
    return max(settled, calls)


def _check_spend_cap(max_usd, pipeline_cost, live):
    if not live:
        return True
    total = _budget_spend_usd() + float(pipeline_cost or 0)
    return total <= max_usd


LIVE_APPROVAL_ENV = "NORI_CAM_LIVE_APPROVED"
LIVE_REFLECT_EST_USD = 0.01


def _live_approved():
    return os.environ.get(LIVE_APPROVAL_ENV) == "1"


def _require_live_approval():
    if not _live_approved():
        raise SystemExit(
            "refusing --live without manager approval "
            f"({LIVE_APPROVAL_ENV}=1 must be set for one approved run)"
        )


def _client_cost_usd(client, default=0.0):
    try:
        cost = float(getattr(client, "cost_usd", default))
    except (TypeError, ValueError):
        return default
    if not math.isfinite(cost) or cost < 0:
        return default
    return cost


def _client_cost_basis(client, default="local"):
    basis = getattr(client, "cost_basis", default)
    return basis if isinstance(basis, str) and basis else default


def _pipeline_cost_basis(result, live):
    if not live:
        return "local"
    steps = (result or {}).get("pipeline") or []
    bases = [s.get("cost_basis") for s in steps
             if isinstance(s, dict) and s.get("cost_basis")]
    return ",".join(dict.fromkeys(bases)) or "estimate"


class _SpendGuardStop(RuntimeError):
    pass



class _EvidenceRecorder:
    """Live runs only: save what a real model client returns into the run's
    out dir (outside the repo) and delegate everything else, so model, cost_usd
    and cost_basis stay the inner client's live values. Inputs (the photo) are
    never saved here."""

    NAMES = {"understand": "spark-raw.json", "redraw": "muse-image-raw.png",
             "wonder": "wonder-raw.json"}
    RAW_SUFFIX = {"webp": "webp", "jpeg": "jpg"}

    def __init__(self, inner, out_dir):
        self._inner = inner
        self._out = Path(out_dir)
        self._states = 0

    def __getattr__(self, name):
        attr = getattr(self._inner, name)
        if not callable(attr):
            return attr

        def call(*a, **k):
            result = attr(*a, **k)
            self._save(name, result)
            return result
        return call

    def _save(self, method, result):
        if method == "redraw_state":
            self._states += 1
            target = self._out / f"muse-image-state-{self._states}.png"
        elif method in self.NAMES:
            target = self._out / self.NAMES[method]
        else:
            return
        if isinstance(result, (bytes, bytearray)):
            target.write_bytes(bytes(result))
        else:
            target.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        if method in ("redraw", "redraw_state") and isinstance(result, (bytes, bytearray)):
            source_format = getattr(self._inner, "last_source_format", None)
            raw = getattr(self._inner, "last_source_bytes", None)
            suffix = self.RAW_SUFFIX.get(source_format)
            if suffix and isinstance(raw, (bytes, bytearray)) and bytes(raw) != bytes(result):
                if method == "redraw_state":
                    raw_target = self._out / f"muse-image-state-{self._states}.{suffix}"
                else:
                    raw_target = self._out / f"muse-image-raw.{suffix}"
                raw_target.write_bytes(bytes(raw))


def _run_reflect_step(intent_id, worker_base, token, wonder, *, live, max_usd,
                      http_fn=None, sleep_fn=None, record_dir=None):
    """Run one reflect step with the right client; return (client, payload).

    Live runs use MetaWonder; fake runs use the given wonder client. The live
    spend guard is checked before the model call and raises _SpendGuardStop
    without calling any model when the cap would be passed. http_fn/sleep_fn
    override the transport (tests pass fakes); when omitted, the run_reflect
    defaults are used.
    """
    if live:
        from .wake import MetaWonder
        wonder_client = MetaWonder()
        if record_dir is not None:
            wonder_client = _EvidenceRecorder(wonder_client, record_dir)
        estimate = _client_cost_usd(wonder_client, LIVE_REFLECT_EST_USD)
        if not _check_spend_cap(max_usd, estimate, True):
            raise _SpendGuardStop("max_usd would be passed by reflect")
    else:
        wonder_client = wonder
    kwargs = {}
    if http_fn is not None:
        kwargs["http_fn"] = http_fn
    if sleep_fn is not None:
        kwargs["sleep_fn"] = sleep_fn
    payload = run_reflect(intent_id, worker_base, token, wonder_client, **kwargs)
    return wonder_client, payload


def _objects_snapshot():
    rows = _d1_rows("SELECT id,kind,status,x,y FROM objects ORDER BY id")
    out = []
    for row in rows:
        if isinstance(row, dict):
            out.append((row["id"], row["kind"], row["status"], row["x"], row["y"]))
        else:
            out.append(tuple(row))
    return out


def _segments_snapshot():
    rows = _d1_rows(
        "SELECT id,start_at,end_at,action,trigger_status FROM segments ORDER BY id"
    )
    out = []
    for row in rows:
        if isinstance(row, dict):
            out.append(tuple(row[k] for k in ("id", "start_at", "end_at", "action", "trigger_status")))
        else:
            out.append(tuple(row))
    return out


def _gift_row(gift_id):
    rows = _d1_rows(f"SELECT id,status FROM gifts WHERE id='{gift_id}'")
    if not rows:
        return None
    row = rows[0]
    if isinstance(row, dict):
        return (row["id"], row["status"])
    return row


def _world_stable_after_fail(before_objects, after_objects, before_segments, after_segments, gift_object_id):
    def without_gift(rows):
        return [row for row in rows if row[0] != gift_object_id]

    objects_ok = without_gift(before_objects) == without_gift(after_objects)
    gift_after = next((row for row in after_objects if row[0] == gift_object_id), None)
    gift_not_placed_toy = gift_after is None or gift_after[1] != "toy" or gift_after[2] != "placed"
    before_ids = {row[0] for row in before_segments}
    before_map = {row[0]: row for row in before_segments}
    after_map = {row[0]: row for row in after_segments}

    def core(row):
        return (row[0], row[3], row[4])

    segments_ok = all(
        sid in after_map and core(after_map[sid]) == core(before_map[sid])
        for sid in before_ids
    )
    return objects_ok, segments_ok, gift_not_placed_toy


def _budget_for_gift(gift_id):
    rows = _d1_rows(
        f"SELECT id,status,actual_usd FROM budget_ledger WHERE id LIKE '%{gift_id}%'"
    )
    out = []
    for row in rows:
        if isinstance(row, dict):
            out.append((row["id"], row["status"], row["actual_usd"]))
        else:
            out.append(tuple(row))
    return out


def _clients_with_fake_fail(out_dir, mode):
    spark, image, box, wonder = fake_clients(out_dir)
    if mode == "spark":
        class FailSpark(FakeSpark):
            def understand(self, *args, **kwargs):
                raise RuntimeError("fake-fail spark")
        spark = FailSpark(out_dir / "spark-raw.json")
    elif mode == "image":
        class FailImage(FakeImage):
            def redraw(self, *args, **kwargs):
                raise RuntimeError("fake-fail image")
        image = FailImage(out_dir / "muse-image-raw.png")
    return SimpleNamespace(spark=spark, image=image, box=box), wonder


def _run_pipeline_with_fail(gift_id, worker_base, token, clients, fake_fail_ingest):
    if not fake_fail_ingest:
        return run_pipeline(gift_id, worker_base, token, clients)

    def http_fn(method, url, headers, body=None):
        from . import pipeline as pipe_mod
        if method == "POST" and url.endswith("/api/ingest") and body:
            try:
                payload = json.loads(body.decode())
            except json.JSONDecodeError:
                payload = {}
            if payload.get("type") == "gift_ready":
                raise RuntimeError("fake-fail ingest")
        return pipe_mod.http_request(method, url, headers, body)

    return run_pipeline(gift_id, worker_base, token, clients, http_fn=http_fn)


def _run_failure_check(args, photo_bytes, photo_sha, mime, worker_base, token, owner_code, out_dir, trail):
    mode = args.fake_fail
    if args.fresh:
        _seed_local_db()
    _wait_worker(worker_base)
    before_objects = _objects_snapshot()
    before_segments = _segments_snapshot()
    idem = f"fail_{mode}_{uuid.uuid4().hex[:12]}"
    body, headers = _multipart_photo(photo_bytes, mime, idem, owner_code)
    status, resp, _ = _http("POST", worker_base + "/api/gift/photo", headers, body)
    gift_id = json.loads(resp.decode()).get("gift_id") if status == 200 else None
    trail.append(_trail_entry(
        "gift_photo_upload",
        model="none",
        started=_iso(),
        ended=_iso(),
        input_summary={"fake_fail": mode, "idem": idem},
        output_summary={"http_status": status, "gift_id": gift_id},
        ok=status == 200 and bool(gift_id),
        reasons=[] if status == 200 else ["upload failed"],
        cost_usd=0.0,
        cost_basis="local",
        ids={"gift_id": gift_id},
    ))
    if not gift_id:
        return 1
    object_id = f"o_{gift_id}"
    fail_mode = mode if mode in ("spark", "image") else None
    clients, _ = _clients_with_fake_fail(out_dir, fail_mode)
    t0 = _iso()
    result = _run_pipeline_with_fail(
        gift_id, worker_base, token, clients, fake_fail_ingest=(mode == "ingest"))
    ok_type = result.get("type") == "gift_failed"
    trail.append(_trail_entry(
        "python_pipeline",
        model="fake",
        started=t0,
        ended=_iso(),
        input_summary={"fake_fail": mode, "gift_id": gift_id},
        output_summary={"type": result.get("type"), "step": result.get("step")},
        ok=ok_type,
        reasons=[] if ok_type else ["expected gift_failed"],
        cost_usd=float(result.get("cost_usd") or 0),
        cost_basis="local",
        ids={"gift_id": gift_id, "object_id": object_id},
    ))
    gift = _gift_row(gift_id)
    after_objects = _objects_snapshot()
    after_segments = _segments_snapshot()
    budget = _budget_for_gift(gift_id)
    placed = _d1_rows(
        f"SELECT id FROM objects WHERE id='{object_id}' AND kind='toy' AND status='placed'"
    )
    objects_ok, segments_ok, gift_not_placed_toy = _world_stable_after_fail(
        before_objects, after_objects, before_segments, after_segments, object_id)
    budget_ok = bool(budget) and all(row[1] in ("settled", "released") for row in budget)
    checks = {
        "gift_status_failed": gift and gift[1] == "failed",
        "no_toy_placed": len(placed) == 0 and gift_not_placed_toy,
        "segments_unchanged": segments_ok,
        "objects_unchanged": objects_ok,
        "budget_ok": budget_ok,
        "budget_rows": [{"id": r[0], "status": r[1], "actual_usd": r[2]} for r in budget],
    }
    trail.append(_trail_entry(
        "failure_check",
        model="none",
        started=_iso(),
        ended=_iso(),
        input_summary={"fake_fail": mode},
        output_summary=checks,
        ok=all(checks[k] for k in ("gift_status_failed", "no_toy_placed", "segments_unchanged",
                                   "objects_unchanged", "budget_ok")),
        reasons=[],
        cost_usd=0.0,
        cost_basis="local",
        ids={"gift_id": gift_id},
    ))
    _write_trail(out_dir, trail)
    return 0 if trail[-1]["validation"]["ok"] else 1


def _stage_deadline(max_minutes, stage, overall):
    """Each stage gets its own waiting budget, bounded by the whole-run deadline."""
    return min(overall, time.monotonic() + max_minutes * DEFAULT_STAGE_FRACTIONS[stage] * 60)


def _run_full_chain(args, photo_bytes, photo_sha, mime, worker_base, token, owner_code, out_dir, trail):
    try:
        return _run_full_chain_inner(
            args, photo_bytes, photo_sha, mime, worker_base, token, owner_code, out_dir, trail)
    except SystemExit:
        raise
    except Exception as error:
        trail.append(_trail_entry(
            "run_error",
            model="none",
            started=_iso(),
            ended=_iso(),
            input_summary={},
            output_summary={"error": f"{type(error).__name__}: {error}"},
            ok=False,
            reasons=["unhandled runner exception"],
            cost_usd=0.0,
            cost_basis="local",
            ids={},
        ))
        _write_trail(out_dir, trail)
        return 1


def _run_full_chain_inner(args, photo_bytes, photo_sha, mime, worker_base, token, owner_code, out_dir, trail):
    if args.fresh:
        _seed_local_db(fixed_start=True)
    clock = VirtualClock(worker_base)
    if args.fresh:
        before = clock.get()
        clock.set(CHAIN_START_MS)
        trail.append(_trail_entry("test_setup_clock_advance", model="none", started=_iso(), ended=_iso(),
            input_summary={"stage": "fresh_start", "from": before, "to": CHAIN_START_MS},
            output_summary={"advanced_to": CHAIN_START_MS}, ok=True, reasons=["fixed fresh seed"],
            cost_usd=0.0, cost_basis="local", ids={}))
    _wait_worker(worker_base)
    overall = time.monotonic() + args.max_minutes * 60

    idem = f"local_{uuid.uuid4().hex[:16]}"
    t0 = _iso()
    body, headers = _multipart_photo(photo_bytes, mime, idem, owner_code)
    status, resp, _ = _http("POST", worker_base + "/api/gift/photo", headers, body)
    gift_id = None
    try:
        gift_id = json.loads(resp.decode()).get("gift_id")
    except json.JSONDecodeError:
        pass
    trail.append(_trail_entry(
        "gift_photo_upload",
        model="none",
        started=t0,
        ended=_iso(),
        input_summary={"photo_sha256": photo_sha, "bytes": len(photo_bytes), "idem": idem},
        output_summary={"http_status": status, "gift_id": gift_id},
        ok=status == 200 and bool(gift_id),
        reasons=[] if status == 200 else ["upload failed"],
        cost_usd=0.0,
        cost_basis="local",
        ids={"gift_id": gift_id},
    ))
    if status != 200 or not gift_id:
        return 1

    object_id = f"o_{gift_id}"
    spark, image, box, wonder = fake_clients(out_dir)
    clients = SimpleNamespace(spark=spark, image=image, box=box)
    if args.live:
        from .clients import MetaImage, MetaSpark, SamBox
        clients = SimpleNamespace(spark=_EvidenceRecorder(MetaSpark(), out_dir),
                                  image=_EvidenceRecorder(MetaImage(), out_dir), box=SamBox())
        wonder = None
        if not _check_spend_cap(args.max_usd, 0, True):
            trail.append(_trail_entry(
                "spend_guard",
                model="live",
                started=_iso(),
                ended=_iso(),
                input_summary={"max_usd": args.max_usd},
                output_summary={"spent_usd": _budget_spend_usd()},
                ok=False,
                reasons=["budget already at cap before pipeline"],
                cost_usd=_budget_spend_usd(),
                cost_basis="worker",
                ids={},
            ))
            _write_trail(out_dir, trail)
            return 1

    t1 = _iso()
    try:
        result = run_pipeline(gift_id, worker_base, token, clients)
        ok = result.get("type") == "gift_ready"
    except Exception:
        ok = False
        result = {"type": "gift_failed"}
    if args.live:
        _pipeline_basis = _pipeline_cost_basis(result, True)
    else:
        _pipeline_basis = "local"
    trail.append(_trail_entry(
        "python_pipeline",
        model="fake" if not args.live else "live",
        started=t1,
        ended=_iso(),
        input_summary={"photo_sha256": photo_sha, "gift_id": gift_id},
        output_summary={
            "type": result.get("type"),
            "cost_usd": result.get("cost_usd"),
            "spark_sha256": _sha256_file(out_dir / "spark-raw.json")
            if (out_dir / "spark-raw.json").is_file() else None,
        },
        ok=ok,
        reasons=[] if ok else ["pipeline did not return gift_ready"],
        cost_usd=float(result.get("cost_usd") or 0),
        cost_basis=_pipeline_basis,
        ids={"gift_id": gift_id, "object_id": object_id},
    ))
    if not ok:
        _write_trail(out_dir, trail)
        return 1

    placement, placement_ok, placement_reasons = _placement_check(object_id, _fetch_cam(worker_base))
    trail.append(_trail_entry(
        "stage_placement",
        model="none",
        started=_iso(),
        ended=_iso(),
        input_summary={"object_id": object_id},
        output_summary=placement,
        ok=placement_ok,
        reasons=placement_reasons,
        cost_usd=0.0,
        cost_basis="local",
        ids={"object_id": object_id},
    ))
    if not placement_ok:
        _write_trail(out_dir, trail)
        return 1

    if args.live and not _check_spend_cap(args.max_usd, result.get("cost_usd"), True):
        trail.append(_trail_entry(
            "spend_guard",
            model="live",
            started=_iso(),
            ended=_iso(),
            input_summary={"max_usd": args.max_usd},
            output_summary={"spent_usd": _budget_spend_usd()},
            ok=False,
            reasons=["max_usd exceeded after pipeline"],
            cost_usd=_budget_spend_usd(),
            cost_basis="worker",
            ids={},
        ))
        _write_trail(out_dir, trail)
        return 1

    plan = _poll_stage(
        "stage_plan",
        lambda: _segment_plan_match(_fetch_cam(worker_base), object_id),
        _stage_deadline(args.max_minutes, "plan", overall),
        trail,
        clock,
        worker_base,
        owner_code,
        token,
        input_summary={"object_id": object_id},
    )
    if not plan:
        _write_trail(out_dir, trail)
        return 1

    act = _poll_stage(
        "stage_act",
        lambda: _act_evidence(worker_base, owner_code, object_id, plan["segment_id"]),
        _stage_deadline(args.max_minutes, "act", overall),
        trail,
        clock,
        worker_base,
        owner_code,
        token,
        input_summary={"segment_id": plan["segment_id"], "object_id": object_id},
    )
    if not act:
        _write_trail(out_dir, trail)
        return 1

    settle = _poll_stage(
        "stage_settle",
        lambda: _settle_evidence(worker_base, owner_code, object_id, act["experience_id"]),
        _stage_deadline(args.max_minutes, "settle", overall),
        trail,
        clock,
        worker_base,
        owner_code,
        token,
        input_summary={"object_id": object_id},
    )
    if not settle:
        _write_trail(out_dir, trail)
        return 1

    reflect_ok = False
    wonder_path = out_dir / "wonder-raw.json"
    reflect_wait = _poll_stage(
        "stage_reflect_wait",
        _reflect_dispatched,
        _stage_deadline(args.max_minutes, "reflect_wait", overall),
        trail,
        clock,
        worker_base,
        owner_code,
        token,
        input_summary={"object_id": object_id},
    )
    reflect_payload = {}
    if reflect_wait:
        intent_id = reflect_wait["intent_id"]
        t3 = _iso()
        wonder_client = wonder
        try:
            wonder_client, _ = _run_reflect_step(
                intent_id, worker_base, token, wonder,
                live=args.live, max_usd=args.max_usd,
                record_dir=out_dir if args.live else None)
            reflect_ok = True
            if wonder_path.is_file():
                raw = json.loads(wonder_path.read_text(encoding="utf-8"))
                reflect_payload = {
                    "cited_event_ids": raw.get("reflection", {}).get("event_ids"),
                    "tomorrow_intent": raw.get("tomorrow"),
                    "habit_candidate": raw.get("habit_candidate"),
                }
        except _SpendGuardStop as guard:
            trail.append(_trail_entry(
                "spend_guard",
                model="live",
                started=_iso(),
                ended=_iso(),
                input_summary={"max_usd": args.max_usd, "step": "reflect"},
                output_summary={"spent_usd": _budget_spend_usd()},
                ok=False,
                reasons=[str(guard) or "max_usd would be passed by reflect"],
                cost_usd=_budget_spend_usd(),
                cost_basis="worker",
                ids={"intent_id": intent_id},
            ))
            _write_trail(out_dir, trail)
            return 1
        except Exception:
            reflect_ok = False
        persisted, persistence_reasons = _reflection_evidence(intent_id, settle["experience_id"])
        reflect_ok = reflect_ok and not persistence_reasons
        reflection_event_id = persisted.get("reflection_event_id")
        trail.append(_trail_entry(
            "stage_reflect",
            model=getattr(wonder_client, "model", None) or ("muse-wonder-1.0" if args.live else "fake-wonder"),
            started=t3,
            ended=_iso(),
            input_summary={"intent_id": reflect_wait.get("intent_id")},
            output_summary={
                **reflect_payload,
                "reflection_event_id": reflection_event_id,
                **persisted,
                "wonder_sha256": _sha256_file(wonder_path) if wonder_path.is_file() else None,
                "reflect_budget_settled_at": "site/src/worker/cam/ingest.ts ingestCloud wonder branch",
            },
            ok=reflect_ok,
            reasons=[] if reflect_ok else persistence_reasons or ["reflect runner failed"],
            cost_usd=_client_cost_usd(wonder_client, 0.0) if reflect_ok else 0.0,
            cost_basis=_client_cost_basis(wonder_client, "estimate" if args.live else "local"),
            ids={"intent_id": reflect_wait.get("intent_id"), "reflection_event_id": reflection_event_id},
        ))
    elif reflect_wait is None:
        trail.append(_trail_entry(
            "stage_reflect",
            model="none",
            started=_iso(),
            ended=_iso(),
            input_summary={"object_id": object_id},
            output_summary={},
            ok=False,
            reasons=["reflect dispatch not observed"],
            cost_usd=0.0,
            cost_basis="local",
            ids={},
        ))

    after = _after_snapshot(worker_base, object_id)
    m2 = None
    m2_ok = args.registration is None
    if args.registration is not None:
        t4 = _iso()
        try:
            m2 = _run_m2(object_id, out_dir, Path(args.registration))
            m2_ok = _m2_accepted(m2)
        except Exception as error:
            m2 = {"error": f"{type(error).__name__}: {error}"}
            m2_ok = False
        trail.append(_trail_entry(
            "stage_m2",
            model="blind.ts judge",
            started=t4,
            ended=_iso(),
            input_summary={"object_id": object_id, "registration": str(args.registration)},
            output_summary={**(m2 or {}), "stage_verdicts": _m2_stage_verdicts(m2)},
            ok=m2_ok,
            reasons=["all six stages and M2 passed"] if m2_ok else ["M2 missing or acceptance verdicts did not all pass"],
            cost_usd=0.0,
            cost_basis="local",
            ids={"object_id": object_id,
                 "experience_id": (m2 or {}).get("experience_id")},
        ))
        if m2_ok:
            after = {**after, "m2": m2["m2"]}
    trail.append(_trail_entry(
        "stage_after",
        model="none",
        started=_iso(),
        ended=_iso(),
        input_summary={"object_id": object_id},
        output_summary=after,
        ok=bool(after.get("next_segments") is not None),
        reasons=["snapshot after chain"],
        cost_usd=0.0,
        cost_basis="local",
        ids={"object_id": object_id},
    ))

    for line in _m2_verdict_lines(m2):
        print(line)

    _write_trail(out_dir, trail)
    if plan and act and settle and reflect_ok and m2_ok:
        return 0
    return 1


def main(argv=None):
    parser = argparse.ArgumentParser(description="Local cam photo gift e2e (fake models by default)")
    parser.add_argument("--photo", required=True, help="Path to gift photo outside the repo")
    parser.add_argument("--out", required=True, help="Evidence directory outside the repo")
    parser.add_argument("--worker-base", default=os.environ.get("WORKER_BASE", "http://127.0.0.1:8788"))
    parser.add_argument("--fresh", action="store_true", help="Reset local D1 cam tables before run")
    parser.add_argument("--live", action="store_true", help="Use real Meta model clients (requires MODEL_API_KEY)")
    parser.add_argument("--skip-settle-wait", action="store_true", help="Deprecated: stop after ingest only")
    parser.add_argument("--max-minutes", type=float, default=180)
    parser.add_argument("--cron-every-s", type=float, default=60)
    parser.add_argument("--max-usd", type=float, default=1.0)
    parser.add_argument("--fake-fail", choices=("spark", "image", "ingest"))
    parser.add_argument("--registration", default=None,
                        help="Pre-registered blind registration JSON (outside repo) for the M2 step")
    args = parser.parse_args(argv)

    if args.live:
        _require_live_approval()
    if args.skip_settle_wait:
        print("warning: --skip-settle-wait ignored; full chain waits are always attempted", file=sys.stderr)

    photo_path = Path(args.photo).resolve()
    out_dir = Path(args.out).resolve()
    if not photo_path.is_file():
        raise SystemExit("photo path missing")
    if args.live and args.registration is None:
        raise SystemExit("live chain requires --registration for explicit six-stage/M2 acceptance")
    if args.fresh and not (os.environ.get("NORI_CAM_LOCAL_CONFIG") and os.environ.get("NORI_CAM_LOCAL_PERSIST")):
        raise SystemExit("--fresh requires explicit NORI_CAM_LOCAL_CONFIG and NORI_CAM_LOCAL_PERSIST")
    if _inside_repo(out_dir):
        raise SystemExit("refusing --out inside the repository")
    out_dir.mkdir(parents=True, exist_ok=True)
    if args.registration is not None:
        registration_path = Path(args.registration).resolve()
        if _inside_repo(registration_path) or not registration_path.is_file():
            raise SystemExit("registration file must exist outside the repository")
        args.registration = str(registration_path)

    os.environ.setdefault("NORI_CAM_ALLOW_LOCAL_HTTP", "1")
    if not allow_local_http():
        raise SystemExit("NORI_CAM_ALLOW_LOCAL_HTTP must be enabled")

    token = _require_env("NORI_INGEST_TOKEN")
    owner_code = _require_env("NORI_OWNER_CODE")
    worker_base = args.worker_base.rstrip("/")

    photo_bytes = photo_path.read_bytes()
    photo_sha = _sha256_bytes(photo_bytes)
    mime = "image/png" if photo_bytes[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
    trail = []

    if args.fake_fail:
        code = _run_failure_check(
            args, photo_bytes, photo_sha, mime, worker_base, token, owner_code, out_dir, trail)
    else:
        code = _run_full_chain(
            args, photo_bytes, photo_sha, mime, worker_base, token, owner_code, out_dir, trail)
    return code


def _write_trail(out_dir: Path, trail):
    (out_dir / "trail.json").write_text(json.dumps(trail, indent=2), encoding="utf-8")


def _local_d1_copy(out_dir: Path):
    """Consistent offline copy of the live local D1 sqlite via the online backup API."""
    persist = Path(os.environ.get("NORI_CAM_LOCAL_PERSIST") or SITE / ".wrangler/state")
    candidates = sorted((persist / "v3/d1/miniflare-D1DatabaseObject").glob("*.sqlite"))
    candidates = [p for p in candidates if p.name != "metadata.sqlite"]
    if not candidates:
        return None
    if len(candidates) != 1:
        raise RuntimeError("ambiguous local D1 evidence: use a dedicated persist directory")
    import sqlite3
    src, dst = candidates[0], out_dir / "local-d1.sqlite"
    if dst.exists():
        dst.unlink()
    source = sqlite3.connect(f"file:{src}?mode=ro", uri=True, timeout=30)
    try:
        target = sqlite3.connect(dst, timeout=30)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()
    return dst


def _m2_stage_verdicts(m2):
    """Stage verdicts (stage, name, verdict) from an m2.json summary."""
    verdicts = []
    for entry in ((m2 or {}).get("stage_verdicts") or []):
        if isinstance(entry, dict):
            verdicts.append({key: entry.get(key) for key in ("stage", "name", "verdict")})
    return verdicts


def _m2_accepted(m2):
    stages = _m2_stage_verdicts(m2)
    return (len(stages) == 6 and {s["stage"] for s in stages} == set(range(1, 7))
            and all(s["verdict"] == "pass" for s in stages)
            and ((m2 or {}).get("m2") or {}).get("verdict") == "pass")


def _m2_verdict_lines(m2):
    """One-line-per-stage verdict table for the end of the run."""
    return [f"m2 stage {v.get('stage')} {v.get('name')}: {v.get('verdict')}"
            for v in _m2_stage_verdicts(m2)]


def _run_m2(object_id, out_dir: Path, registration: Path):
    """Pre-registered M2 numbers for the real local state via blind.ts; needs the Worker stopped."""
    db_copy = _local_d1_copy(out_dir)
    if db_copy is None:
        return None
    m2_out = out_dir / "m2.json"
    proc = subprocess.run(
        ["node", "--experimental-transform-types", "scripts/cam-m2-local.ts", "--db", str(db_copy),
         "--object", object_id, "--registration", str(registration), "--out", str(m2_out)],
        cwd=SITE,
        capture_output=True,
        text=True,
        shell=sys.platform == "win32",
    )
    if proc.returncode not in (0, 2) or not m2_out.is_file():
        raise RuntimeError(f"m2 script failed: {proc.returncode} {proc.stderr[:500]}")
    return json.loads(m2_out.read_text(encoding="utf-8"))


def synthesize_test_photo(path: Path):
    image = Image.new("RGB", (120, 120), "#4488cc")
    draw = ImageDraw.Draw(image)
    draw.ellipse((30, 30, 89, 89), fill="#ffcc00", outline="#222222")
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG")


def live_runbook_lines():
    return LIVE_WORKER_VARS, LIVE_RUNNER_CMD


if __name__ == "__main__":
    raise SystemExit(main())
