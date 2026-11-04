"""Wall-clock owner dispatcher. World access is read-only except real Worker APIs."""
import hashlib
import json
from pathlib import Path
import sqlite3
import time
from types import SimpleNamespace

from .clients import MetaSpark, MetaImage, NotConfigured
from .wake import MetaWonder, run_reflect, wonder_validation_reasons
from .reflect_evidence import safe_error, save_evidence
from .pipeline import run as gift_pipeline
from . import local_e2e as transport
from .owner_budget import BoundedResponses, BudgetStop
from .owner_spark import OwnerSpark
from .owner_status import photo_progress


class Costed:
    def __init__(self, inner, guard):
        self.inner, self.guard = inner, guard

    def __getattr__(self, name):
        if name == "cost_usd":
            return self.guard.costs.get(self.inner.model, getattr(self.inner, name, 0))
        return getattr(self.inner, name)


class NoSegmentation:
    model, cost_usd, cost_basis = 'sam-box-not-called', 0, 'not_called'
    def box(self, *args):
        raise NotConfigured('owner loop uses Spark and Muse Image only')


class FocusWonder:
    def __init__(self, inner, event_id, evidence=None):
        self.inner, self.event_id = inner, event_id
        self.evidence = evidence if evidence is not None else {}

    def __getattr__(self, name):
        return getattr(self.inner, name)

    def wonder(self, context):
        self.evidence['stage'] = 'focus_context'
        # Actual event evidence only, preserving current preferences/objects/valid actions.
        focus = [e for e in context["events"] if e["id"] == self.event_id]
        if len(focus) != 1:
            raise RuntimeError("exact experience event unavailable in context")
        self.evidence.update(stage='wonder_call', required_event_id=self.event_id)
        try:
            raw = self.inner.wonder({**context, "events": focus, "required_event_id": self.event_id})
        finally:
            self.evidence['raw_wonder_response'] = getattr(self.inner, 'raw_response', None)
            self.evidence['stage'] = getattr(self.inner, 'stage', 'wonder_call')
        reasons = wonder_validation_reasons(raw, [self.event_id])
        cited = raw.get('reflection', {}).get('event_ids', []) if isinstance(raw, dict) and isinstance(raw.get('reflection'), dict) else []
        if not isinstance(cited, list) or self.event_id not in cited:
            reasons.append('exact_experience_citation_absent')
        self.evidence.update(stage='focus_validation', parsed_reflection=raw, cited_event_ids=cited,
            validator={'valid': not reasons, 'reasons': reasons})
        if self.evidence['raw_wonder_response'] is None:
            self.evidence['raw_wonder_response'] = raw
        if reasons:
            raise RuntimeError('invalid focused Wonder output: ' + ','.join(reasons))
        return raw


class Core:
    def __init__(self, state, base, token, ledger, sdk, *, mode="LIVE", factory=None, stop_event=None, art_profile=None, reflect=True):
        self.state, self.base, self.token = Path(state), base, token
        self.ledger, self.sdk, self.mode, self.factory = ledger, sdk, mode, factory
        self.latest_error = None
        self.stop_event = stop_event
        self.art_profile, self.reflect = art_profile, reflect
        with ledger.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,kind TEXT,status TEXT,detail TEXT,updated REAL)")
            db.execute("CREATE TABLE IF NOT EXISTS uploads (gift_id TEXT PRIMARY KEY,sha256 TEXT,bytes INTEGER)")

    def rows(self, sql, params=()):
        paths = [p for p in (self.state/"persist/v3/d1/miniflare-D1DatabaseObject").glob("*.sqlite") if p.name != "metadata.sqlite"]
        if len(paths) != 1:
            raise RuntimeError("isolated world DB unavailable")
        db = sqlite3.connect(paths[0].as_uri()+"?mode=ro", uri=True, timeout=10)
        try:
            db.row_factory = sqlite3.Row
            return [dict(x) for x in db.execute(sql, params)]
        finally:
            db.close()

    def receipt(self, gift_id, sha256, size):
        with self.ledger.connect() as db:
            db.execute("INSERT OR IGNORE INTO uploads VALUES(?,?,?)", (gift_id, sha256, size))

    def claim(self, ident, kind):
        with self.ledger.connect() as db:
            return db.execute("INSERT OR IGNORE INTO jobs VALUES(?,?,'running','{}',?)", (ident, kind, time.time())).rowcount == 1

    def finish(self, ident, status, detail):
        with self.ledger.connect() as db:
            db.execute("UPDATE jobs SET status=?,detail=?,updated=? WHERE id=?", (status, json.dumps(detail), time.time(), ident))

    def call_api(self, path, payload, *, evidence=None):
        status, body, _ = transport._json_request(self.base, path, token=self.token, method="POST", payload=payload)
        if evidence is not None:
            evidence['worker_responses'].append({'stage': evidence['stage'], 'status': status,
                'body': body.decode('utf-8', errors='replace') if isinstance(body, bytes) else body})
        if status != 200:
            raise RuntimeError("local Worker rejected operation")
        return json.loads(body)

    def providers(self, event):
        if self.stop_event is not None and self.stop_event.is_set():
            raise BudgetStop('owner requested stop')
        if self.factory:
            if self.mode != "MOCK_TEST":
                raise RuntimeError("test providers prohibited for Live URL")
            return self.factory(event)
        if self.mode != "LIVE" or self.sdk is None:
            raise RuntimeError("Live provider required")
        guard = BoundedResponses(self.sdk.responses, self.ledger, event,
            cancelled=self.stop_event.is_set if self.stop_event is not None else None)
        client = SimpleNamespace(responses=guard)
        image = self.art_profile.image_client(client) if self.art_profile else MetaImage(client)
        return SimpleNamespace(spark=Costed(OwnerSpark(client), guard), image=Costed(image, guard),
                               wonder=Costed(MetaWonder(client), guard), box=NoSegmentation())

    def process_photo(self, gift):
        ident = "photo:"+gift["id"]
        with self.ledger.connect() as db:
            receipt = db.execute("SELECT sha256,bytes FROM uploads WHERE gift_id=?", (gift["id"],)).fetchone()
        # The receipt is saved just after the real Worker upload response. A tick
        # racing that response must wait, not consume the gift's only attempt.
        if receipt is None:
            return
        if not self.claim(ident, "photo"):
            return
        try:
            status, raw, _ = transport._http("GET", self.base+"/api/gift/source/"+gift["id"], {"Authorization": "Bearer "+self.token})
            digest = hashlib.sha256(raw).hexdigest()
            if status != 200 or receipt is None or receipt[0] != digest or receipt[1] != len(raw):
                raise RuntimeError("actual multipart/receiver source hash mismatch")
            clients = self.providers(ident)
            kwargs = {"art_profile": self.art_profile} if self.art_profile else {}
            result = gift_pipeline(gift["id"], self.base, self.token, clients, **kwargs)
            self.finish(ident, result["type"], {"mode": self.mode, "receiver_sha256": digest,
                "multipart_source_matches": True, "result": result})
        except Exception as error:
            self.finish(ident, "failed", {"error_class": type(error).__name__, "automatic_retry": False})
            self.call_api("/api/ingest", {"type": "gift_failed", "gift_id": gift["id"], "step": "owner_live_guard", "pipeline": [], "cost_usd": 0})

    def process_experience(self, row):
        ident = "reflect:"+row["object_id"]
        if not self.claim(ident, "meaningful_event_reflection"):
            return
        evidence = {'experience_id': row['id'], 'mode': self.mode, 'stage': 'dispatch',
            'raw_wonder_response': None, 'parsed_reflection': None, 'validator': None,
            'cited_event_ids': [], 'dispatch_id': None, 'intent_id': None, 'worker_responses': []}
        detail = {}
        try:
            dispatch = self.call_api("/api/owner/experience-reflect", {"experience_id": row["id"]}, evidence=evidence)
            if not dispatch or "intent_id" not in dispatch:
                raise RuntimeError("actual experience dispatch rejected")
            evidence.update(stage='provider_setup', dispatch=dispatch, dispatch_id=dispatch['intent_id'],
                intent_id='intent:wonder:'+dispatch['intent_id']+':0')
            provider = self.providers("experience:"+row["id"])
            evidence['stage'] = 'experience_event_lookup'
            focus = self.rows("SELECT id FROM events WHERE type='experience_settled' AND json_extract(payload,'$.experience')=?", (row["id"],))
            if len(focus) != 1:
                raise RuntimeError("experience event unavailable")
            result = run_reflect(dispatch["intent_id"], self.base, self.token,
                FocusWonder(provider.wonder, focus[0]["id"], evidence), evidence=evidence)
            evidence['stage'] = 'persisted_verification'
            # Check persisted exact event + intent + budget, using the existing acceptance function.
            old = transport._d1_rows
            try:
                transport._d1_rows = self.rows
                verification, reasons = transport._reflection_evidence(dispatch["intent_id"], row["id"])
            finally:
                transport._d1_rows = old
            # Avoid replacing the complete model receipt with the smaller persisted verdict.
            evidence.update(stage='complete', verification=verification, acceptance_reasons=reasons)
            status = "accepted" if not reasons else "rejected"
            detail = {"mode": self.mode, "experience_id": row["id"], "dispatch": dispatch,
                "verification": verification, "reasons": reasons, "cost_usd": result["cost_usd"]}
        except Exception as error:
            status = 'failed'
            detail = {"error_class": type(error).__name__, "error_message": safe_error(error, (self.token,)),
                "stage": evidence['stage'], "automatic_retry": False, "experience_id": row["id"]}
            evidence['error'] = detail
        try:
            detail['evidence_file'] = str(save_evidence(self.state, row['id'], evidence))
        except Exception as error:
            detail['evidence_write_error'] = safe_error(error, (self.token,))
        self.finish(ident, status, detail)

    def tick(self):
        self.call_api("/api/owner/advance", {})  # production settlement at Date.now(), never test clock/cron.
        transport._fetch_cam(self.base)
        for gift in self.rows("SELECT id FROM gifts WHERE kind='photo' AND status='processing' ORDER BY created_at LIMIT 5"):
            if self.stop_event is not None and self.stop_event.is_set():return
            self.process_photo(gift)
        for row in self.rows("SELECT x.id,x.object_id FROM experiences x JOIN gifts g ON g.object_id=x.object_id WHERE g.kind='photo' AND g.status='ready' ORDER BY x.at,x.id"):
            if self.stop_event is not None and self.stop_event.is_set():return
            if not self.reflect:continue
            self.process_experience(row)

    def settled_photo_experiences(self):
        return self.rows("""SELECT x.id,x.at,x.object_id,x.interaction_id FROM experiences x
            JOIN gifts g ON g.object_id=x.object_id
            JOIN segments s ON s.id=json_extract(x.segment_ids,'$[#-1]')
            WHERE g.kind='photo' AND g.status='ready' AND s.settled_at IS NOT NULL
            AND s.cut_at IS NULL AND s.superseded_at IS NULL
            AND json_extract(s.completion,'$.last')=1
            AND EXISTS(SELECT 1 FROM events e WHERE e.type='experience_settled'
                AND json_extract(e.payload,'$.experience')=x.id) ORDER BY x.at,x.id""")

    def reflect_one(self, experience_id):
        # Manual probing must never compete with automatic dispatch of other objects.
        if self.reflect:
            raise ValueError('restart with automatic reflection disabled for a one-call probe')
        rows = [r for r in self.settled_photo_experiences() if r['id'] == experience_id]
        if len(rows) != 1:
            raise ValueError('one settled photo experience required')
        self.process_experience(rows[0])

    def snapshot(self):
        with self.ledger.connect() as db:
            db.row_factory = sqlite3.Row
            jobs = [dict(x) for x in db.execute("SELECT * FROM jobs ORDER BY updated DESC LIMIT 30")]
        if self.art_profile:
            ids={r['id'] for r in self.rows('SELECT id FROM gifts')}
            allowed={'photo:'+i for i in ids}|{'reflect:o_'+i for i in ids}
            jobs=[j for j in jobs if j['id'] in allowed]
        result = {"mode": self.mode, "automatic_reflection": self.reflect, "clock": "normal wall clock", "budget": self.ledger.snapshot(), "jobs": jobs,
                  "dispatcher_error_class": self.latest_error, "not_claimed": "no guaranteed reaction or long-term learning"}
        try:
            world = self.rows("SELECT version,state_json FROM world WHERE id=1")[0]
            state = json.loads(world["state_json"])
            result["world"] = {"version": world["version"], "preferences": state["prefs"], "familiarity": state["familiarity"], "habits": state["habits"]}
            result["experiences"] = self.rows("SELECT id,at,object_id,interaction_id,appraisal FROM experiences ORDER BY at DESC LIMIT 20")
            result["wonder_influence_segments"] = self.rows("SELECT id,start_at,end_at,source,primitive,settled_at,cut_at,superseded_at FROM segments WHERE source LIKE 'intent:wonder:%' ORDER BY start_at DESC LIMIT 20")
            result["placed_gifts"] = self.rows("SELECT o.id,o.x,o.y,o.z,o.status,o.state,o.sprite FROM objects o JOIN gifts g ON g.object_id=o.id WHERE g.kind='photo'")
        except Exception:
            result["world"] = "starting"
        result["photo_progress"] = photo_progress(result)
        return result
