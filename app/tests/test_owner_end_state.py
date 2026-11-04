import copy
import json
from types import SimpleNamespace as N
import unittest
from app.cam.owner_spark import OwnerSpark, STATE_CONTRACT
from app.cam.pipeline import _check_candidate, InteractionContractError
from app.cam.owner_status import photo_progress, hud


class StateContractTests(unittest.TestCase):
    def test_owner_request_includes_explicit_cross_field_contract_without_changing_adapter_or_answer(self):
        calls=[]; answer={'synthetic_test_response':True}
        class Responses:
            def create(self, **kwargs):
                calls.append(kwargs)
                return N(output_text=json.dumps(answer),usage=N(input_tokens=1,output_tokens=1))
        executor={'ObjectCard':{'states':{'type':'array'}},'InteractionSpec':{'end_state':{'type':['string','null']}}}
        original=copy.deepcopy(executor)
        result=OwnerSpark(N(responses=Responses())).understand('data:image/png;base64,TEST',executor,[])
        prompt=calls[0]['input'][0]['content'][0]['text']
        self.assertIn('OWNER_STATE_CONSISTENCY',prompt)
        self.assertIn('JSON null',prompt)
        self.assertIn('AND to allowed_states',prompt)
        self.assertIn('self_check',prompt)
        self.assertEqual(executor,original);self.assertEqual(result,answer)
        self.assertEqual(len(calls),1)

    def test_original_validator_still_rejects_exact_reported_invariant(self):
        # Synthetic counterexample only; actual failed model states were NOT saved/known.
        card={'states':['open','closed'],'parts':[]}
        bad={'allowed_states':['open'],'end_state':'closed','steps':[]}
        with self.assertRaisesRegex(InteractionContractError,'end state outside allowed states'):
            _check_candidate(card,bad)
        self.assertEqual(bad['end_state'],'closed')
        for allowed,end in [(['open'],None),(['open'],'open'),([], 'closed')]:
            _check_candidate(card,{'allowed_states':allowed,'end_state':end,'steps':[]})
        for sentinel in ('unchanged','none','null'):
            with self.assertRaisesRegex(InteractionContractError,'unknown end state'):
                _check_candidate(card,{'allowed_states':['open'],'end_state':sentinel,'steps':[]})


class OperatorProgressTests(unittest.TestCase):
    def fixture(self,status='gift_failed'):
        return {'jobs':[{'id':'photo:actual-id','kind':'photo','status':status,'detail':json.dumps({'result':{
            'step':'understand','pipeline':[{'step':'fetch_source','ok':True},{'step':'understand','ok':False,
              'note':'step failed: InteractionContractError: end state outside allowed states'}]}})}],
            'budget':{'calls':[]},'experiences':[],'wonder_influence_segments':[]}
    def test_existing_failure_has_readable_code_and_never_claims_ready_or_finished(self):
        snapshot=self.fixture();original=copy.deepcopy(snapshot);p=photo_progress(snapshot)[0]
        self.assertEqual(p['reason_code'],'END_STATE_OUTSIDE_ALLOWED_STATES')
        self.assertFalse(p['photo_ready']);self.assertFalse(p['bounded_loop_complete'])
        self.assertIn('佔位',p['headline']);self.assertEqual(p['reflection'],'not_started')
        self.assertEqual(snapshot,original)
    def test_ready_reflection_and_settled_intent_are_separate_requirements(self):
        snapshot=self.fixture('gift_ready');snapshot['jobs'][0]['detail']='{}'
        p=photo_progress(snapshot)[0];self.assertTrue(p['photo_ready']);self.assertFalse(p['bounded_loop_complete'])
        snapshot['jobs'].append({'id':'reflect:o_actual-id','kind':'meaningful_event_reflection','status':'accepted',
            'detail':json.dumps({'dispatch':{'intent_id':'seg:7'}})})
        snapshot['experiences']=[{'object_id':'o_actual-id'}]
        snapshot['wonder_influence_segments']=[{'source':'intent:wonder:seg:7:0','settled_at':None,'cut_at':None}]
        self.assertEqual(photo_progress(snapshot)[0]['future_intent'],'planned')
        self.assertFalse(photo_progress(snapshot)[0]['bounded_loop_complete'])
        snapshot['wonder_influence_segments'][0]['settled_at']=123
        self.assertTrue(photo_progress(snapshot)[0]['bounded_loop_complete'])
        snapshot['wonder_influence_segments'][0]['cut_at']=122
        self.assertFalse(photo_progress(snapshot)[0]['bounded_loop_complete'])
    def test_foreign_future_intent_cannot_complete_this_photo(self):
        snapshot=self.fixture('gift_ready');snapshot['jobs'][0]['detail']='{}'
        snapshot['jobs'].append({'id':'reflect:o_actual-id','status':'accepted','detail':json.dumps({'dispatch':{'intent_id':'seg:7'}})})
        snapshot['experiences']=[{'object_id':'o_actual-id'}]
        snapshot['wonder_influence_segments']=[{'source':'intent:wonder:seg:8:0','settled_at':123,'cut_at':None}]
        self.assertFalse(photo_progress(snapshot)[0]['bounded_loop_complete'])
    def test_hud_labels_mock_and_uses_text_content_for_data(self):
        text=hud('MOCK_TEST');self.assertIn('MOCK_TEST · 非 Live',text)
        self.assertIn('owner-progress',text);self.assertIn('bounded_loop_complete',text)
        self.assertNotIn('innerHTML',text);self.assertIn('textContent',text)


if __name__=='__main__':unittest.main()
