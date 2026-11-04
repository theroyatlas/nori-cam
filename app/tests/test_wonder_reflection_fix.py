"""Zero-provider failure receipts and exact owner reflection contract."""
import json
from types import SimpleNamespace as N
from unittest.mock import patch

import pytest
from app.cam.owner_budget import Ledger
from app.cam.owner_core import Core, FocusWonder
from app.cam.pipeline import Response
from app.cam.reflect_evidence import evidence_path, safe_error, save_evidence
from app.cam.wake import MetaWonder, run_reflect, wonder_validation_reasons

EVENT = 'experience_settled:compiled:photo:0:7'
EXPERIENCE = 'exp:compiled:photo:0:7'


def valid():
    return {'reflection': {'summary': 'The globe stayed still while I examined it.', 'event_ids': [EVENT]},
        'tomorrow': {'action': 'sniff', 'object_id': 'o_photo', 'window_minutes': 120,
            'reason_tag': 'revisit_globe', 'summary': 'Examine the same globe again.'}, 'habit_candidate': None}


def context():
    return {'events': [{'id': EVENT, 'type': 'experience_settled', 'payload': {'experience': EXPERIENCE}}],
        'objects': [{'id': 'o_photo', 'kind': 'toy', 'tags': []}], 'interactions': [], 'preferences': {'motion': .5}}


@pytest.mark.parametrize('mode,stage,reason', [
    ('wrong', 'focus_validation', 'invalid_event_ids'),
    ('missing', 'focus_validation', 'exact_experience_citation_absent'),
    ('drift', 'focus_validation', 'invalid_intent_keys'),
    ('carry', 'focus_validation', 'invalid_intent_keys'),
    ('action', 'focus_validation', 'unknown_action'),
    ('timeout', 'wonder_call', None),
    ('malformed', 'wonder_parse', None),
    ('context_missing', 'focus_context', None),
    ('worker', 'worker_ingest', None),
    ('success', 'complete', None),
])
def test_owner_receipt_and_no_retry(tmp_path, mode, stage, reason):
    calls = []
    output = valid()
    if mode == 'wrong': output['reflection']['event_ids'] = [EXPERIENCE]
    if mode == 'missing': output['reflection']['event_ids'] = []
    if mode == 'drift': output['tomorrow']['confidence'] = .8
    if mode == 'carry': output['tomorrow']['action'] = 'carry'  # old prompt omitted destination_id
    if mode == 'action': output['tomorrow']['action'] = 'observe'
    class Responses:
        def create(self, **kwargs):
            calls.append(kwargs)
            if mode == 'timeout': raise TimeoutError('Bearer secret-local timeout\n' + 'x' * 900)
            text = 'not json' if mode == 'malformed' else json.dumps(output)
            return N(model_dump=lambda **k: {'model': 'muse-wonder-1.0', 'output_text': text},
                output_text=text, usage=N(input_tokens=1319, output_tokens=1438))
    inner = MetaWonder(N(responses=Responses()))
    ledger = Ledger(tmp_path / 'ledger.sqlite')
    core = Core(tmp_path, 'http://127.0.0.1:8812', 'secret-local', ledger, None,
        mode='MOCK_TEST', factory=lambda event: N(wonder=inner), reflect=False)
    ctx = context()
    if mode == 'context_missing': ctx['events'] = []
    def http(method, url, headers, body=None):
        if method == 'GET': return Response(200, json.dumps(ctx).encode())
        return Response(400 if mode == 'worker' else 200, b'{"error":"object_not_placed"}' if mode == 'worker' else b'{"ok":true}')
    def api(path, payload, **kwargs):
        kwargs['evidence']['worker_responses'].append({'stage': 'dispatch', 'status': 200, 'body': '{"intent_id":"seg:7"}'})
        return {'intent_id': 'seg:7'}
    def runner(*args, **kwargs):
        return run_reflect(*args, **kwargs, http_fn=http)
    with patch.object(core, 'call_api', side_effect=api), patch.object(core, 'rows', return_value=[{'id': EVENT}]), \
            patch('app.cam.owner_core.run_reflect', side_effect=runner), \
            patch('app.cam.local_e2e._reflection_evidence', return_value=({'intent_persisted': True}, [])), \
            patch.dict('os.environ', {'NORI_CAM_ALLOW_LOCAL_HTTP': '1'}):
        core.process_experience({'id': EXPERIENCE, 'object_id': 'o_photo'})
        core.process_experience({'id': EXPERIENCE, 'object_id': 'o_photo'})
    receipt = json.loads(evidence_path(tmp_path, EXPERIENCE).read_text(encoding='utf-8'))
    with ledger.connect() as db:
        status, detail = db.execute('SELECT status,detail FROM jobs').fetchone()
    detail = json.loads(detail)
    assert receipt['stage'] == stage
    assert len(calls) == (0 if mode == 'context_missing' else 1)
    assert receipt['dispatch_id'] == 'seg:7'
    assert receipt['intent_id'] == 'intent:wonder:seg:7:0'
    assert status == ('accepted' if mode == 'success' else 'failed')
    if mode != 'success':
        assert detail['stage'] == stage
        assert len(detail['error_message']) <= 500
        assert 'secret-local' not in detail['error_message']
    if reason: assert reason in receipt['validator']['reasons']
    if mode not in ('timeout', 'context_missing'): assert receipt['raw_wonder_response'] is not None
    if mode == 'worker': assert receipt['worker_responses'][-1]['status'] == 400


def test_single_event_context_is_sufficient_and_prompt_exposes_exact_contract():
    requests = []
    adapter = MetaWonder(N(responses=N(create=lambda **kw: (requests.append(kw) or
        N(output_text=json.dumps(valid()), usage=None)))))
    evidence = {}
    result = FocusWonder(adapter, EVENT, evidence).wonder(context())
    prompt = requests[0]['input'][0]['content'][0]['text']
    assert result == valid()
    assert EVENT in prompt and 'required_event_id' in prompt
    for text in ['destination_id', 'try_interaction', 'EXACTLY', 'One event is sufficient']:
        assert text in prompt
    assert evidence['validator'] == {'valid': True, 'reasons': []}


def test_manual_probe_refuses_automatic_mode_before_any_call(tmp_path):
    core = Core(tmp_path, 'http://127.0.0.1:8812', 'local', Ledger(tmp_path/'budget.sqlite'), None)
    with patch.object(core, 'process_experience') as process, pytest.raises(ValueError):
        core.reflect_one(EXPERIENCE)
    process.assert_not_called()


def test_unhashable_schema_drift_is_rejected_and_error_redaction():
    output = valid(); output['tomorrow']['action'] = {'verb': 'sniff'}
    assert wonder_validation_reasons(output, [EVENT]) == ['unknown_action']
    text = safe_error(RuntimeError('api_key=private token=private2 Bearer hidden sk-hidden'))
    assert all(value not in text for value in ['private', 'private2', 'hidden'])


def test_invalid_numeric_output_does_not_destroy_evidence(tmp_path):
    path = save_evidence(tmp_path, 'exp:'+'x'*235, {'raw_wonder_response': {'output_text':'{"window_minutes":NaN}'},
        'parsed_reflection': {'window_minutes': float('nan')}, 'validator': {'valid': False, 'reasons':['window_bounds']}})
    result = json.loads(path.read_text(encoding='utf-8'))
    assert result['parsed_reflection']['window_minutes'] == {'invalid_nonfinite_number':'nan'}
    assert result['raw_wonder_response']['output_text'] == '{"window_minutes":NaN}'
    assert len(path.name) < 200


def test_manual_probe_exact_selection_and_duplicate_do_not_call_twice(tmp_path):
    core = Core(tmp_path, 'http://127.0.0.1:8812', 'local', Ledger(tmp_path/'budget.sqlite'), None, reflect=False)
    row = {'id': EXPERIENCE, 'object_id': 'o_photo'}
    with patch.object(core, 'settled_photo_experiences', return_value=[row]), patch.object(core, 'process_experience') as process:
        with pytest.raises(ValueError): core.reflect_one('wrong-experience')
        process.assert_not_called()
        core.reflect_one(EXPERIENCE)
        process.assert_called_once_with(row)


def test_probe_status_never_counts_future_or_superseded_segments_as_used():
    # Import for a pure verdict test only. The live probe entrypoint is not run.
    from tools.wonder_live_probe import verdict
    evidence = {'dispatch_id':'seg:7', 'raw_wonder_response':{'output_text':'MOCK'}}
    source = 'intent:wonder:seg:7:0'
    snap = {'jobs':[{'id':'reflect:o_photo','status':'accepted','detail':json.dumps({'verification':{'intent_persisted':True}})}],
        'wonder_influence_segments':[{'source':source,'start_at':2000,'end_at':3000,'superseded_at':None,'settled_at':None}]}
    with patch('tools.wonder_live_probe.time.time', return_value=1):
        result = verdict(snap, EXPERIENCE, 'o_photo', evidence)
    assert result['reflection_accepted'] and result['intent_created']
    assert not result['later_intent_started'] and not result['later_intent_used']
    snap['wonder_influence_segments'][0].update(start_at=0, settled_at=900, superseded_at=800)
    with patch('tools.wonder_live_probe.time.time', return_value=1):
        assert not verdict(snap, EXPERIENCE, 'o_photo', evidence)['later_intent_used']
