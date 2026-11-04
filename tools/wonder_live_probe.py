"""Explicit one-experience owner probe; listing/re-checking never invokes a model.

Run the observatory WITHOUT --reflect for the one-call bound. This tool reads only
the local owner capability, never provider keys. No HTTP or model retries.
"""
import argparse
import json
from pathlib import Path
import sys
import time
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.cam.reflect_evidence import evidence_path


def request(state, port, path, payload=None):
    owner = (Path(state) / 'owner-code.txt').read_text(encoding='utf-8').strip()
    req = Request(f'http://127.0.0.1:{port}{path}',
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'Cookie': 'nori_owner=' + owner, 'Content-Type': 'application/json'})
    with urlopen(req, timeout=240) as response:
        return json.load(response)


def verdict(snapshot, experience_id, object_id, evidence=None):
    job = next((j for j in snapshot.get('jobs', []) if j['id'] == 'reflect:' + object_id), None)
    detail = json.loads(job['detail']) if job else {}
    dispatch = (evidence or {}).get('dispatch_id') or detail.get('dispatch', {}).get('intent_id')
    source = 'intent:wonder:' + dispatch + ':0' if dispatch else None
    now = int(time.time() * 1000)
    segments = [s for s in snapshot.get('wonder_influence_segments', []) if s['source'] == source]
    planned = [s for s in segments if s.get('superseded_at') is None]
    started = [s for s in planned if s['start_at'] <= now and
        min(s.get('cut_at') or s['end_at'], s['end_at']) > s['start_at']]
    used = [s for s in started if s.get('settled_at') is not None]
    verification = detail.get('verification', {})
    return {'experience_id': experience_id, 'wonder_responded': (evidence or {}).get('raw_wonder_response') is not None,
        'reflection_accepted': job is not None and job['status'] == 'accepted',
        'intent_created': verification.get('intent_persisted', False), 'later_intent_used': bool(used),
        'later_intent_scheduled': bool(planned), 'later_intent_started': bool(started),
        'wonder_segments': segments, 'behaviour_difference_vs_baseline': 'NOT_EVALUABLE (no paired live baseline)',
        'job_status': job['status'] if job else 'not_attempted', 'detail': detail}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--experience', help='exact listed experience id; omit to list only')
    parser.add_argument('--check-only', action='store_true', help='never trigger reflection')
    parser.add_argument('--check-after', type=int, default=30, help='seconds before one read-only re-check (0-1800)')
    args = parser.parse_args(argv)
    if not 1024 <= args.port <= 65535 or not 0 <= args.check_after <= 1800:
        parser.error('invalid port or check-after')
    listing = request(args.state, args.port, '/owner/reflect/experiences')
    print(json.dumps(listing, ensure_ascii=False, indent=2), flush=True)
    if not args.experience:
        return 0
    matches = [x for x in listing['experiences'] if x['id'] == args.experience]
    if len(matches) != 1:
        parser.error('choose exactly one listed experience')
    if not args.check_only and listing['automatic_reflection']:
        parser.error('automatic dispatcher enabled: restart owner without --reflect before a one-call probe')
    if not args.check_only:
        snapshot = request(args.state, args.port, '/owner/reflect', {'experience_id': args.experience})
    else:
        snapshot = request(args.state, args.port, '/owner/status')
    path = evidence_path(args.state, args.experience)
    evidence = json.loads(path.read_text(encoding='utf-8')) if path.exists() else None
    print(json.dumps({'evidence_file': str(path), 'evidence': evidence,
        'status': verdict(snapshot, args.experience, matches[0]['object_id'], evidence)}, ensure_ascii=False, indent=2), flush=True)
    if args.check_after:
        time.sleep(args.check_after)
        snapshot = request(args.state, args.port, '/owner/status')
        print(json.dumps({'later_recheck': verdict(snapshot, args.experience, matches[0]['object_id'], evidence)},
            ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
