"""Human-readable operator progress derived only from existing receipts/jobs/world rows."""
import json


def detail(job):
    try:
        value = json.loads(job.get('detail', '{}'))
        return value if isinstance(value, dict) else {}
    except (TypeError, ValueError):
        return {}


def failure_code(result, info):
    notes = [str(s.get('note', '')) for s in result.get('pipeline', []) if not s.get('ok')]
    if any('end state outside allowed states' in note for note in notes):
        return 'END_STATE_OUTSIDE_ALLOWED_STATES'
    if info.get('error_class') == 'BudgetStop':
        return 'OWNER_BUDGET_STOP'
    stage = str(result.get('step', 'unknown'))
    return {'understand':'SPARK_CONTRACT_OR_SAFETY_FAILED','redraw':'IMAGE_GENERATION_FAILED',
            'pixelize':'IMAGE_PROCESSING_FAILED','upload':'IMAGE_UPLOAD_FAILED','fetch_source':'SOURCE_CHECK_FAILED'}.get(stage, 'PHOTO_FAILED')


def photo_progress(snapshot):
    jobs = snapshot.get('jobs', [])
    calls = snapshot.get('budget', {}).get('calls', [])
    output = []
    for job in jobs:
        if job.get('kind') != 'photo':
            continue
        gift_id = job['id'].removeprefix('photo:')
        object_id = 'o_' + gift_id
        info = detail(job); result = info.get('result', {})
        failed = job.get('status') in ('failed', 'gift_failed', 'rejected')
        ready = job.get('status') == 'gift_ready'
        pipeline = {s['step']: ('done' if s.get('ok') else 'failed') for s in result.get('pipeline', [])}
        active = [c for c in calls if c['id'].startswith('photo:' + gift_id + ':') and c['status'] in ('reserved', 'uncertain')]
        stage = result.get('step') if failed else ('placed' if ready else 'processing')
        if active and not failed:
            stage = 'image' if active[-1]['model'] == 'muse-image-1.0' else 'spark'
        headline = '禮物已放入房間；等待 Nori 自己互動' if ready else {'image':'Muse Image 正在生成圖片','spark':'Spark 正在理解照片'}.get(stage,'照片處理中，尚未完成')
        code = failure_code(result, info) if failed else None
        if failed:
            headline = '照片處理失敗；未完成。紙箱只是佔位，請勿自動重送。'
        reflection = next((j for j in jobs if j.get('id') == 'reflect:' + object_id), None)
        reflection_state = 'not_started'; future = 'not_planned'
        if reflection:
            rd = detail(reflection)
            reflection_state = reflection.get('status', 'unknown')
            ref = rd.get('dispatch', {}).get('intent_id')
            segments = [s for s in snapshot.get('wonder_influence_segments', []) if ref and s.get('source', '').startswith('intent:wonder:' + ref + ':')]
            if any(s.get('settled_at') is not None and s.get('cut_at') is None for s in segments):
                future = 'settled'
            elif segments:
                future = 'planned'
        experience = any(e.get('object_id') == object_id for e in snapshot.get('experiences', []))
        output.append({'gift_id': gift_id, 'headline': headline, 'photo_stage': stage, 'photo_ready': ready,
            'failed': failed, 'reason_code': code, 'pipeline_stages': pipeline, 'experience_persisted': experience,
            'reflection': reflection_state, 'future_intent': future,
            'bounded_loop_complete': ready and experience and reflection_state == 'accepted' and future == 'settled'})
    return output


def hud(mode):
    label = 'LIVE Meta · 正常時間' if mode == 'LIVE' else 'MOCK_TEST · 非 Live'
    return '''<aside style="position:fixed;top:8px;right:8px;z-index:80;background:#201a16;color:#eee;padding:8px;max-width:330px;font:12px sans-serif"><strong id="owner-mode">''' + label + '''</strong><div id="owner-budget"></div><div id="owner-progress" role="status" aria-live="polite">正在讀取處理狀態…</div><a href="/owner/status" target="_blank" style="color:#f9c67d">詳細事件／記憶紀錄</a><button onclick="fetch('/owner/stop',{method:'POST'})">停止本機服務</button></aside><script>
async function ownerRefresh(){try{let s=await(await fetch('/owner/status')).json();document.getElementById('owner-mode').textContent=s.mode==='LIVE'?'LIVE Meta · 正常時間':'MOCK_TEST · 非 Live';document.getElementById('owner-budget').textContent='$'+s.budget.accounted_and_reserved_usd.toFixed(3)+' / $20（含保留，非供應商帳單 cap）'+(s.budget.halted?' 已停付費工作':'');let p=document.getElementById('owner-progress');p.replaceChildren();let items=(s.photo_progress||[]).slice(0,3);if(!items.length)p.textContent='尚未送出照片；選圖後按 Send photo。';for(let x of items){let line=document.createElement('p');let reflection={accepted:'反思已驗證並保存',running:'Wonder 反思中',failed:'反思失敗，未完成',rejected:'反思驗證失敗',not_started:'反思尚未開始'}[x.reflection]||'反思狀態未確認';let future={settled:'後續 intent 行為已結算',planned:'後續 intent 已規劃，尚未執行',not_planned:'尚無後續 intent 行為'}[x.future_intent];line.textContent='照片 '+x.gift_id.slice(0,8)+'：'+x.headline+(x.reason_code?' ['+x.reason_code+']':'')+(x.photo_ready?'；'+(x.experience_persisted?'經驗已保存':'等待實際互動經驗')+'；'+reflection+'；'+future:'')+(x.bounded_loop_complete?'。本次有界流程完成；不代表長期學習已驗證。':'');p.append(line);}for(let i of document.querySelectorAll('input[type=password]'))if(!i.value)i.value='owner-session';}catch(e){document.getElementById('owner-progress').textContent='狀態暫時無法讀取；不能視為完成。';}}
ownerRefresh();setInterval(ownerRefresh,2000);</script>'''
