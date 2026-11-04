"""Persistent aggregate provider ledger; independent from authoritative world DB."""
import json
import math
from pathlib import Path
import sqlite3
import threading
import time
from contextlib import contextmanager

CEILING = 20.0
TOKEN_CAPS = {"muse-spark-1.3": 16384, "muse-image-1.0": 4096, "muse-wonder-1.0": 16384}
RATES = {"muse-spark-1.3": (1.25, 4.25), "muse-wonder-1.0": (4.0, 20.0)}


class BudgetStop(RuntimeError):
    pass


class Ledger:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, model TEXT NOT NULL, status TEXT NOT NULL, reserved REAL NOT NULL, actual REAL, basis TEXT, usage TEXT, created REAL NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), ceiling REAL NOT NULL, halted INTEGER NOT NULL DEFAULT 0)")
            db.execute("INSERT OR IGNORE INTO settings(id,ceiling) VALUES(1,?)", (CEILING,))
            if db.execute("SELECT ceiling FROM settings WHERE id=1").fetchone()[0] != CEILING:
                raise BudgetStop("ledger ceiling mismatch")
            if db.execute("SELECT 1 FROM calls WHERE status='reserved' LIMIT 1").fetchone():
                db.execute("UPDATE calls SET status='uncertain',basis='interrupted request; reservation retained' WHERE status='reserved'")
                db.execute("UPDATE settings SET halted=1 WHERE id=1")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def used(db):
        return db.execute("SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) FROM calls").fetchone()[0]

    def reserve(self, call_id, model, amount):
        if model not in TOKEN_CAPS or not math.isfinite(amount) or amount <= 0:
            raise BudgetStop("invalid reservation")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT halted FROM settings WHERE id=1").fetchone()[0]:
                raise BudgetStop("ledger halted; accounting review required")
            if db.execute("SELECT 1 FROM calls WHERE id=?", (call_id,)).fetchone():
                raise BudgetStop("call already attempted; automatic retry prohibited")
            if self.used(db) + amount > CEILING:
                raise BudgetStop("aggregate $20 reservation ceiling")
            db.execute("INSERT INTO calls VALUES(?,?,'reserved',?,NULL,'conservative reservation',NULL,?)", (call_id, model, amount, time.time()))

    def settle(self, call_id, actual, usage, basis):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            reserved = db.execute("SELECT reserved FROM calls WHERE id=?", (call_id,)).fetchone()[0]
            if actual is None:
                db.execute("UPDATE calls SET status='uncertain',basis=? WHERE id=?", (basis, call_id))
                db.execute("UPDATE settings SET halted=1 WHERE id=1")
            else:
                if not math.isfinite(actual) or actual < 0:
                    raise BudgetStop("invalid actual accounting")
                db.execute("UPDATE calls SET status='settled',actual=?,basis=?,usage=? WHERE id=?", (actual, basis, json.dumps(usage), call_id))
                if actual > reserved or self.used(db) > CEILING:
                    db.execute("UPDATE settings SET halted=1 WHERE id=1")

    def snapshot(self):
        with self.connect() as db:
            db.row_factory = sqlite3.Row
            calls = [dict(x) for x in db.execute("SELECT id,model,status,reserved,actual,basis,usage FROM calls ORDER BY created")]
            used = self.used(db)
            halted = bool(db.execute("SELECT halted FROM settings WHERE id=1").fetchone()[0])
        return {"ceiling_usd": CEILING, "accounted_and_reserved_usd": used, "remaining_usd": max(0, CEILING-used),
                "halted": halted, "provider_hard_billing_cap": False, "calls": calls}


class BoundedResponses:
    """Exactly one attempted call per event/model, no retry; payloads/keys never logged."""
    def __init__(self, inner, ledger, event_id, deadline=None, cancelled=None):
        self.inner, self.ledger, self.event_id = inner, ledger, event_id
        self.deadline = deadline or time.monotonic()+10*60
        self.costs = {}
        self.cancelled = cancelled or (lambda: False)

    def create(self, **kwargs):
        if self.cancelled():
            raise BudgetStop("owner requested stop")
        model = kwargs.get("model")
        if model not in TOKEN_CAPS:
            raise BudgetStop("unapproved model")
        remaining = self.deadline-time.monotonic()
        if remaining <= 0:
            raise BudgetStop("event deadline")
        kwargs.update(max_output_tokens=TOKEN_CAPS[model], timeout=min(180, remaining), store=False)
        if model in RATES:
            kwargs["reasoning"] = {"effort": "high"}
        # UTF-8 bytes + vision allowance is deliberately pessimistic, not a provider guarantee.
        size = len(json.dumps(kwargs, ensure_ascii=False).encode("utf-8"))
        if size > 15*1024*1024:
            raise BudgetStop("bounded input size")
        if model in RATES:
            rate_in, rate_out = RATES[model]
            reservation = ((size+131072)*rate_in + TOKEN_CAPS[model]*rate_out)/1_000_000
        else:
            reservation = 1.0  # conservative image reservation; returned image count is accounted.
        call_id = self.event_id+":"+model
        self.ledger.reserve(call_id, model, reservation)
        try:
            if self.cancelled():
                raise BudgetStop("owner requested stop")
            response = self.inner.create(**kwargs)
            if getattr(response, "model", None) != model:
                raise BudgetStop("response model mismatch")
            usage = getattr(response, "usage", None)
            data = {}
            if model in RATES:
                for key in ("input_tokens", "output_tokens"):
                    n = getattr(usage, key, None)
                    if type(n) is not int or n < 0:
                        raise BudgetStop("missing provider token usage")
                    data[key] = n
                cost = (data["input_tokens"]*rate_in + data["output_tokens"]*rate_out)/1_000_000
                basis = "provider token usage at documented standard rates; cache discounts ignored"
            else:
                count = sum(1 for item in getattr(response, "output", []) if getattr(item, "type", "") == "image_generation_call" and getattr(item, "result", None))
                if count != 1:
                    raise BudgetStop("expected exactly one returned image")
                cost, data, basis = count*0.01, {"returned_images": count}, "returned image count at documented $0.01/image"
            self.ledger.settle(call_id, cost, data, basis)
            self.costs[model] = cost
            return response
        except BaseException:
            # Unknown/failed requests retain their entire reservation and halt new paid work.
            self.ledger.settle(call_id, None, {}, "uncertain request; reservation retained; no retry")
            raise
