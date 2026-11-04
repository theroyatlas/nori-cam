import contextlib
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace as N
import unittest
from unittest.mock import patch
from app.cam.owner_budget import Ledger, BoundedResponses, BudgetStop
from app.cam.owner_core import Core, FocusWonder
from app.cam import owner_live


class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'budget.sqlite';self.ledger=Ledger(self.path)
    def tearDown(self):self.temp.cleanup()
    def test_shared_ceiling_persists_across_instances_and_duplicate_never_calls(self):
        self.ledger.reserve('a','muse-wonder-1.0',19)
        self.ledger.settle('a',19,{},'test actual')
        second=Ledger(self.path)
        with self.assertRaises(BudgetStop):second.reserve('b','muse-image-1.0',1.01)
        second.reserve('b','muse-image-1.0',1)
        with self.assertRaises(BudgetStop):second.reserve('b','muse-image-1.0',1)
    def test_high_effort_caps_usage_and_one_attempt(self):
        calls=[]
        class Responses:
            def create(inner,**kwargs):
                calls.append(kwargs)
                return N(model='muse-wonder-1.0',usage=N(input_tokens=100,output_tokens=200))
        guard=BoundedResponses(Responses(),self.ledger,'experience:actual')
        guard.create(model='muse-wonder-1.0',input='actual experience')
        with self.assertRaises(BudgetStop):guard.create(model='muse-wonder-1.0',input='again')
        self.assertEqual(len(calls),1);self.assertEqual(calls[0]['reasoning'],{'effort':'high'})
        self.assertEqual(calls[0]['max_output_tokens'],16384)
        self.assertAlmostEqual(self.ledger.snapshot()['accounted_and_reserved_usd'],0.0044)
    def test_exception_retains_reservation_and_halts_all_models(self):
        class Responses:
            def create(inner,**kwargs):raise TimeoutError('private provider text')
        with self.assertRaises(TimeoutError):BoundedResponses(Responses(),self.ledger,'gift:x').create(model='muse-spark-1.3',input='photo')
        self.assertTrue(self.ledger.snapshot()['halted'])
        with self.assertRaises(BudgetStop):self.ledger.reserve('gift:y','muse-image-1.0',1)
        self.assertNotIn('private provider text',json.dumps(self.ledger.snapshot()))
    def test_crash_pending_cannot_be_silently_retried_or_refunded(self):
        self.ledger.reserve('pending','muse-spark-1.3',1)
        resumed=Ledger(self.path)
        self.assertTrue(resumed.snapshot()['halted']);self.assertEqual(resumed.snapshot()['remaining_usd'],19)
    def test_malformed_usage_or_wrong_model_halts(self):
        for response in [N(model='other',usage=N(input_tokens=1,output_tokens=1)),N(model='muse-spark-1.3',usage=None)]:
            with tempfile.TemporaryDirectory() as directory:
                ledger=Ledger(Path(directory)/'test.sqlite')
                guard=BoundedResponses(N(create=lambda **k:response),ledger,'one')
                with self.assertRaises(BudgetStop):guard.create(model='muse-spark-1.3',input='x')
                self.assertTrue(ledger.snapshot()['halted'])
    def test_live_core_rejects_fake_factory(self):
        core=Core(self.temp.name,'http://127.0.0.1:1234','local',self.ledger,None,mode='LIVE',factory=lambda x:N())
        with self.assertRaises(RuntimeError):core.providers('one')
    def test_upload_receipt_race_waits_without_consuming_gift_attempt(self):
        core=Core(self.temp.name,'http://127.0.0.1:1234','local',self.ledger,None)
        with patch.object(core,'claim') as claim,patch.object(core,'providers') as providers:
            core.process_photo({'id':'still-uploading'})
        claim.assert_not_called();providers.assert_not_called()
    def test_stop_prevents_new_provider_request_and_reservation(self):
        with patch('builtins.print'):
            inner=N(create=lambda **k:self.fail('provider called after stop'))
            with self.assertRaises(BudgetStop):BoundedResponses(inner,self.ledger,'stopped',cancelled=lambda:True).create(model='muse-spark-1.3',input='x')
        self.assertEqual(self.ledger.snapshot()['calls'],[])


class InterfaceTests(unittest.TestCase):
    def test_default_plan_reads_no_key_starts_no_process(self):
        with patch.object(owner_live,'load_key') as key,patch.object(owner_live.subprocess,'Popen') as process,contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(owner_live.main([]),0)
        key.assert_not_called();process.assert_not_called();self.assertFalse(json.loads(out.getvalue())['started'])
    def test_child_config_has_no_provider_key(self):
        config=owner_live.config_for(Path('C:/Temp/local-test'),'owner-capability','ingest-capability')
        self.assertEqual(config['vars']['MODEL_API_BASE'],'http://127.0.0.1:9')
        self.assertEqual(config['vars']['CAM_LOCAL_WALL_CLOCK'],'1')
        self.assertNotIn('triggers',config)
    def test_exact_focus_citation_required_no_fabricated_context(self):
        class Wonder:
            def wonder(self,ctx):
                self.context=ctx
                return {'reflection':{'summary':'private reflection','event_ids':['wrong']},'tomorrow':{'action':'ignore','window_minutes':10,'reason_tag':'quiet','summary':'quiet','object_id':'actual'},'habit_candidate':None}
        inner=Wonder();focus=FocusWonder(inner,'experience_settled:7:0')
        ctx={'events':[{'id':'experience_settled:7:0'},{'id':'unrelated'}],'preferences':{'soft':0.6}}
        with self.assertRaises(RuntimeError):focus.wonder(ctx)
        self.assertEqual(inner.context['events'],[ctx['events'][0]])
        self.assertEqual(inner.context['preferences'],ctx['preferences'])


if __name__=='__main__':unittest.main()
