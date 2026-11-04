"""Read-only adjacent settlement snapshots; never writes a runtime DB."""
import json
import sqlite3


class Capture:
    def __init__(self, out, object_id):
        self.out, self.object_id, self.previous, self.done = out, object_id, None, False

    def sample(self):
        if self.done:
            return
        files = [p for p in (self.out / "state/v3/d1/miniflare-D1DatabaseObject").glob("*.sqlite")
                 if p.name != "metadata.sqlite"]
        if len(files) != 1:
            raise RuntimeError("expected one isolated local DB")
        with sqlite3.connect(files[0].as_uri() + "?mode=ro", uri=True) as db:
            db.row_factory = sqlite3.Row
            db.execute("BEGIN")
            snap = {table: [dict(r) for r in db.execute(query)] for table, query in {
                "world": "SELECT * FROM world",
                "objects": "SELECT o.*,c.card FROM objects o JOIN object_cards c ON c.id=o.card_id ORDER BY o.id",
                "segments": "SELECT * FROM segments ORDER BY start_at,id",
                "interactions": "SELECT * FROM interactions WHERE status IN ('accepted','degraded') ORDER BY id",
                "experiences": "SELECT * FROM experiences ORDER BY at,id",
                "events": "SELECT * FROM events ORDER BY at,id",
                "weather": "SELECT * FROM weather ORDER BY hour_utc",
                "intents": "SELECT * FROM intents ORDER BY id",
            }.items()}
        if any(x["object_id"] == self.object_id for x in snap["experiences"]):
            self.done = True
            (self.out / "causal-sample.json").write_text(json.dumps({
                "mode": "atomic read-only DB samples bracketing first target experience",
                "target_id": self.object_id, "before": self.previous, "after": snap}, indent=2), encoding="utf-8")
        else:
            self.previous = snap
