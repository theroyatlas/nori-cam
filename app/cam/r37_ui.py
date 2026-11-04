"""Keyless UI-originated photo acceptance. Providers are explicit Mock substitutes.

No UI/API responses are fulfilled or stubbed. All runtime writes go through the
real isolated Worker; SQLite is opened read-only for durable evidence.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import time
from types import SimpleNamespace
from email.parser import BytesParser
from email.policy import default

from . import local_e2e as r
from .fake_clients import FakeSpark, FakeImage, FakeWonder
from .clients import SamBox
from .pipeline import run as pipeline

from .ui_local_e2e import frozen_fixture, multipart_evidence, first_effect_matches
from .r37_observer import Observer
ACTIVE = None

def _run(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", action="store_true", help="Print the blocked future Live proposal; no execution")
    parser.add_argument("--out", help="New dedicated directory outside repo")
    parser.add_argument("--attempt", type=int, choices=(1, 2, 3))
    parser.add_argument("--episode", choices=("r37",), default="r37")
    args = parser.parse_args(argv)
    if args.plan or (args.out is None and args.attempt is None):
        if args.episode == "r37":
            from .r37_plan import PLAN
            print(json.dumps(PLAN, indent=2))
        else:
            print(json.dumps(R33_LIVE_PLAN if args.episode == "r33" else LIVE_PLAN, indent=2))
        return 0
    if args.out is None or args.attempt is None:
        parser.error("local execution requires both --out and --attempt")
    fixture, frozen = frozen_fixture(args.attempt, "r33")
    out = Path(args.out).resolve()
    if out.exists() or out.is_relative_to(r.ROOT):
        raise SystemExit("use a new isolated output directory outside repo")
    out.mkdir(parents=True)
    global ACTIVE
    observer = ACTIVE = Observer(out)
    trail, summary = [], {"mode": "Mock providers / actual browser / real isolated local Worker-D1 / virtual time",
                           "attempt": args.attempt, "fixture_sha256": frozen["fixture_sha256"]}
    site = r.SITE
    config = {"name": "nori-r31-ui", "main": str(site / "src/worker/index.ts"),
              "compatibility_date": "2026-10-01",
              "assets": {"directory": str(site / "public"), "binding": "ASSETS", "run_worker_first": ["/api/*", "/media/*"]},
              "d1_databases": [{"binding": "DB", "database_name": "nori-r31-ui",
                                "database_id": "00000000-0000-0000-0000-000000000031", "migrations_dir": str(site / "migrations")}],
              "kv_namespaces": [{"binding": "MEDIA", "id": "00000000000000000000000000000031"}],
              "vars": {"CAM_LOCAL_PIPELINE": "1", "CAM_SPARK_ENABLED": "0", "CAM_BROWSE_ENABLED": "0",
                       "CAM_REFLECT_ENABLED": "1", "CAM_DAILY_USD": "1", "CAM_WONDER_MAX_USD": "0.10",
                       "MODEL_API_BASE": "http://127.0.0.1:9", "MODEL_API_KEY": "keyless-local-sentinel",
                       "MEDIA_UPLOAD_TOKEN": "local-r31-only", "OWNER_CODE_SHA256": hashlib.sha256(b"local-owner").hexdigest()}}
    path = out / "config.json"
    path.write_text(json.dumps(config, indent=2))
    env = {k: v for k, v in os.environ.items() if not any(s in k.upper() for s in
           ("TOKEN", "SECRET", "API_KEY", "CLOUDFLARE", "SAM_BOX", "LIVE_APPROVED"))}
    env.update(NORI_CAM_LOCAL_CONFIG=str(path), NORI_CAM_LOCAL_PERSIST=str(out / "state"),
               NORI_CAM_ALLOW_LOCAL_HTTP="1", WRANGLER_SEND_METRICS="false")
    os.environ.clear()
    os.environ.update(env)
    # Empty database bootstrap only, using unmodified official migrations/seed.
    # No custom seed clock/state, reset SQL, Nori coordinates or runtime SQL writes.
    r._run_site(["npm", "run", "db:local"])
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    log = (out / "worker.log").open("w", encoding="utf-8")
    child = subprocess.Popen(["node", str(site / "node_modules/wrangler/bin/wrangler.js"), "dev", "--local",
                              "--ip", "127.0.0.1", "--port", str(port), "--config", str(path),
                              "--persist-to", str(out / "state")], cwd=out, env=env, stdout=log, stderr=subprocess.STDOUT)
    (out / "owned-process.json").write_text(json.dumps({"pid": child.pid, "port": port, "config": str(path)}))
    started = time.monotonic()
    try:
        r._wait_worker(base)
        def rows(sql):
            files = [p for p in (out / "state/v3/d1/miniflare-D1DatabaseObject").glob("*.sqlite") if p.name != "metadata.sqlite"]
            if len(files) != 1:
                raise RuntimeError("expected one isolated DB")
            with sqlite3.connect(files[0].as_uri() + "?mode=ro", uri=True) as db:
                db.row_factory = sqlite3.Row
                return [dict(row) for row in db.execute(sql)]
        r._d1_rows = rows
        r.synthesize_test_photo(out / "synthetic-photo.png")
        (out / "registration.json").write_text(json.dumps(fixture["registration"]))
        class ControlSpark(FakeSpark):
            def understand(self, image_data_url, executor, wishes):
                if wishes != []:
                    raise ValueError("synthetic independent-cat control requires empty wishes")
                raw = copy.deepcopy(fixture["answer"])
                self._raw_sink.write_text(json.dumps(raw), encoding="utf-8")
                return raw
        clients = SimpleNamespace(spark=ControlSpark(out / "spark-raw.json"),
                                  image=FakeImage(out / "muse-image-raw.png"), box=SamBox())
        from playwright.sync_api import sync_playwright
        requests, responses, errors, external = observer.requests, observer.responses, observer.errors, observer.external
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, executable_path="C:/Program Files/Google/Chrome/Application/chrome.exe")
            try:
                page = browser.new_page(viewport={"width": 1280, "height": 800})
                observer.attach(page, base)
                observer.stage("photo_ui")
                page.goto(base + "/?t=0", wait_until="networkidle")
                page.get_by_role("button", name="Give Nori a gift", exact=True).click()
                page.locator("details.nori-gift-photo summary").click()
                page.locator('input[type="password"]').fill("local-owner")
                page.locator('input[type="file"]').set_input_files(str(out / "synthetic-photo.png"))
                page.screenshot(path=str(out / "01-selected.png"))
                with page.expect_response(lambda res: res.url == base + "/api/gift/photo") as uploaded:
                    page.get_by_role("button", name="Send photo", exact=True).click()
                upload = uploaded.value
                gift_id = upload.json()["gift_id"]
                object_id = "o_" + gift_id
                page.get_by_role("status").filter(has_text="Nori is looking at your photo").wait_for()
                processing = page.locator(".nori-gift-status").inner_text()
                page.screenshot(path=str(out / "02-processing.png"))
                summary["upload"] = {"http_status": upload.status, "gift_id": gift_id, "multipart": requests,
                                     "input_sha256": r._sha256_file(out / "synthetic-photo.png"), "processing_text": processing}
                source_status, source_bytes, _ = r._http("GET", base + "/api/gift/source/" + gift_id,
                                                        {"Authorization": "Bearer local-r31-only"})
                summary["upload"]["worker_source_http_status"] = source_status
                summary["upload"]["worker_source_sha256"] = hashlib.sha256(source_bytes).hexdigest()
                summary["upload"]["source_matches_input"] = source_status == 200 and hashlib.sha256(source_bytes).hexdigest() == summary["upload"]["input_sha256"]
                # CDP omits binary file data from postData. Worker source bytes
                # are the authoritative check; do not call that omission a 0-byte upload.
                summary["upload"]["cdp_binary_body_note"] = "CDP multipart file bytes may be omitted; verify Worker source hash"
                result = pipeline(gift_id, base, "local-r31-only", clients)
                summary["pipeline"] = result
                if result.get("type") != "gift_ready":
                    raise RuntimeError("positive pipeline refused")
                page.get_by_role("status").filter(has_text="portable toy block is in the room").wait_for(timeout=20000)
                summary["terminal_text"] = page.locator(".nori-gift-status").inner_text()
                page.screenshot(path=str(out / "03-terminal.png"))
                page.get_by_role("button", name="Close gift panel").click()
                before = r._fetch_cam(base)
                summary["before"] = next(o for o in before["objects"] if o["id"] == object_id)
                page.screenshot(path=str(out / "04-before-effect.png"))
                clock = r.VirtualClock(base)
                if args.episode == "r37":
                    from .r35_capture import Capture
                    capture = Capture(out, object_id)
                overall = time.monotonic() + 5 * 60
                def poll(name, check, stage):
                    observer.stage(name)
                    if name == "stage_reflect_wait":
                        from .r37_clock import wait_reflection
                        found = wait_reflection(base, clock, rows, trail, observer)
                        if found is None:
                            raise RuntimeError("no natural reflection dispatch in frozen window")
                        return found
                    def sampled_check():
                        if args.episode == "r37":
                            capture.sample()
                        return check()
                    value = r._poll_stage(name, sampled_check, r._stage_deadline(5, stage, overall), trail,
                                          clock, base, "local-owner", "local-r31-only")
                    if value is None:
                        raise RuntimeError(name + " failed")
                    return value
                plan = poll("stage_plan", lambda: r._segment_plan_match(r._fetch_cam(base), object_id), "plan")
                if args.episode in ("r37",):
                    planned = rows(f"SELECT start_at,end_at FROM segments WHERE interaction='{plan['interaction_id']}' "
                                   "AND primitive='carry' AND superseded_at IS NULL ORDER BY start_at LIMIT 1")
                    if planned:
                        live_at = (planned[0]["start_at"] + planned[0]["end_at"]) // 2
                        clock.set(live_at)
                        live_cam = r._fetch_cam(base)
                        summary["live_carry_sample"] = {"time": live_at,
                            "objects": [o for o in live_cam["objects"] if o["id"] == object_id],
                            "segments": [s for s in live_cam["segments"] if s.get("interaction") == plan["interaction_id"]]}
                        page.reload(wait_until="networkidle")
                        page.screenshot(path=str(out / "live-carry.png"))
                act = poll("stage_act", lambda: r._act_evidence(base, "local-owner", object_id, plan["segment_id"]), "act")
                exp = r._settle_evidence(base, "local-owner", object_id, act["experience_id"])
                summary["experience"] = exp
                after = r._fetch_cam(base)
                summary["after"] = next(o for o in after["objects"] if o["id"] == object_id)
                page.reload(wait_until="networkidle")
                page.screenshot(path=str(out / "05-after-effect.png"))
                summary["position_effect_matches"] = ([summary["before"]["x"], summary["before"]["y"]] == fixture["expected_effect"]["initial_cell"]
                    and [summary["after"]["x"], summary["after"]["y"]] == fixture["expected_effect"]["final_cell"])
                if args.episode in ("r37",):
                    # A repeatable control can have returned by a later settlement
                    # poll. Bind its expected first effect to the exact experience.
                    states = rows(f"SELECT x,y,status,cause,valid_from FROM object_states WHERE object_id='{object_id}' "
                                  f"AND valid_from<={exp['at']} AND (valid_to>{exp['at']} OR valid_to IS NULL) "
                                  "ORDER BY valid_from DESC,id DESC LIMIT 1")
                    summary["first_experience_object_state"] = states[0] if states else None
                    summary["position_effect_matches"] = first_effect_matches(summary["before"],
                        states[0] if states else None, fixture["expected_effect"])
                # Consecutive authoritative history samples; no renderer or world edits.
                segments = rows(f"SELECT id,start_at,end_at,primitive,effects FROM segments WHERE interaction='{plan['interaction_id']}' AND superseded_at IS NULL ORDER BY start_at")
                moving = [s for s in segments if s["primitive"] == "carry"]
                if moving:
                    start, end = moving[0]["start_at"] - 500, moving[-1]["end_at"] + 1000
                    frames = out / "frames"
                    frames.mkdir()
                    frame_times = list(range(start, end + 1, 125))
                    for i, at in enumerate(frame_times):
                        page.goto(base + f"/?replayFrom={start}&replayTo={end}&t={at}", wait_until="networkidle")
                        page.screenshot(path=str(frames / f"{i:03d}.png"))
                    summary["frames"] = {"mode": "consecutive 8fps samples of actual local D1 replay, not wall-clock video", "times": frame_times}
                wait = poll("stage_reflect_wait", r._reflect_dispatched, "reflect_wait")
                r._run_reflect_step(wait["intent_id"], base, "local-r31-only", FakeWonder(out / "wonder-raw.json"), live=False, max_usd=1)
                reflection, reasons = r._reflection_evidence(wait["intent_id"], exp["experience_id"])
                summary["reflection"] = {**reflection, "reasons": reasons, "accepted": not reasons}
                summary["judge"] = r._run_m2(object_id, out, out / "registration.json")
                summary["strict_accepted"] = r._m2_accepted(summary["judge"])
            finally:
                browser.close()
                observer.cleanup["browser_closed"] = True
                observer.flush()
    except Exception as error:
        summary.update(exit=1, error=f"{type(error).__name__}: {error}")
        observer.failure = summary["error"]
    finally:
        summary["wall_s"] = round(time.monotonic() - started, 2)
        try:
            r._local_d1_copy(out)
        except Exception as error:
            summary["snapshot_error"] = type(error).__name__
            summary["exit"] = 1
        finally:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"], capture_output=True)
            else:
                child.terminate()
            child.wait(timeout=15)
            log.close()
            observer.cleanup["worker_stopped"] = child.poll() is not None
            observer.flush()
            summary["ui"] = json.loads((out / "observer.json").read_text())
            try:
                if "object_id" in locals():
                    if not summary.get("judge"):
                        summary["judge"] = r._run_m2(object_id, out, out / "registration.json")
                    summary["legacy_strict_accepted"] = r._m2_accepted(summary["judge"])
                if (out / "causal-sample.json").exists():
                    causal_path = out / "causal-batch.json"
                    result = subprocess.run(["node", "--experimental-transform-types", str(r.ROOT / "app/cam/r37_causal.ts"),
                        str(out / "causal-sample.json"), str(causal_path)], cwd=site, capture_output=True, text=True)
                    if result.returncode:
                        raise RuntimeError(result.stderr[:300])
                    summary["experience_causal_batch_v1"] = json.loads(causal_path.read_text())
                verdicts = r._m2_stage_verdicts(summary.get("judge"))
                summary["r37_accepted"] = (summary.get("experience_causal_batch_v1", {}).get("status") == "PASS"
                    and len(verdicts) == 6 and all(v["verdict"] == "pass" for v in verdicts[:5])
                    and summary.get("reflection", {}).get("accepted") is True
                    and summary.get("position_effect_matches") is True
                    and summary.get("upload", {}).get("source_matches_input") is True
                    and summary.get("upload", {}).get("http_status") == 200
                    and all(observer.installed.values()) and len(requests) == 1 and requests[0]["multipart"]
                    and not errors and not external and all(observer.cleanup.values()))
                summary["exit"] = 0 if summary["r37_accepted"] else 1
            except Exception as error:
                summary["analysis_error"] = f"{type(error).__name__}: {error}"
                summary["exit"] = 1
            (out / "summary.json").write_text(json.dumps(summary, indent=2))
            r._write_trail(out, trail)
    print(json.dumps(summary, indent=2))
    return summary["exit"]



def main(argv=None):
    try:
        return _run(argv)
    except BaseException as error:
        if ACTIVE is not None:
            ACTIVE.failure = f"{type(error).__name__}: {error}"
        raise
    finally:
        if ACTIVE is not None:
            ACTIVE.cleanup["entry_finalized"] = True
            ACTIVE.flush()

if __name__ == "__main__":
    raise SystemExit(main())
