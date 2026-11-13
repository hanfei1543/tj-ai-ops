#!/usr/bin/env python3
"""Read-only TJ isolation evidence. Never reads DYT business tables or credentials files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
from urllib.request import Request, urlopen
from datetime import datetime, timezone

PRODUCTION = Path('/home/hermes/projects/TJ-AI-Ops')
WRAPPER = Path('/home/hermes/.hermes/scripts/tj-po-push.sh')

def digest(data):
    return hashlib.sha256(data).hexdigest()

def api(url, token, body=None):
    req = Request(url, data=None if body is None else json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    with urlopen(req, timeout=90) as res:
        return json.load(res)

def capture():
    paths = subprocess.check_output(['git', 'ls-files', 'scripts', 'web/src/lib/core'], cwd=PRODUCTION, text=True).splitlines()
    files = {str(PRODUCTION / p): digest((PRODUCTION / p).read_bytes()) for p in paths}
    files[str(WRAPPER)] = digest(WRAPPER.read_bytes())
    jobs = json.loads(Path('/home/hermes/.hermes/cron/jobs.json').read_text())
    jobs = jobs if isinstance(jobs, list) else jobs['jobs']
    cron = [{k: x.get(k) for k in ['id', 'script', 'enabled', 'schedule', 'no_agent']} for x in jobs if x.get('script') == 'tj-po-push.sh']
    # Only TJ tables in public; canonical JSON is hashed in Python, not written to the report.
    selects = [f"'{t}', (select coalesce(jsonb_agg(to_jsonb(x) order by id), '[]'::jsonb) from public.{t} x)" for t in ['tj_suppliers', 'tj_items', 'tj_po_headers', 'tj_po_lines', 'tj_po_exports', 'tj_item_requests']]
    query = "select jsonb_build_object(" + ','.join(selects) + ", 'sequences', (select jsonb_agg(to_jsonb(x) order by sequencename) from pg_sequences x where schemaname='public' and sequencename like 'tj_%'), 'columns',(select jsonb_agg(to_jsonb(x) order by table_name,ordinal_position) from information_schema.columns x where table_schema='public' and table_name like 'tj_%'), 'policies',(select jsonb_agg(to_jsonb(x) order by tablename,policyname) from pg_policies x where schemaname='public' and tablename like 'tj_%'), 'indexes',(select jsonb_agg(to_jsonb(x) order by indexname) from pg_indexes x where schemaname='public' and tablename like 'tj_%'), 'triggers',(select jsonb_agg(pg_get_triggerdef(g.oid) order by g.tgname) from pg_trigger g join pg_class c on c.oid=g.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname like 'tj_%' and not g.tgisinternal)) as state"
    ref = os.environ['SUPABASE_PROJECT_REF']
    state = api('https://api.supabase.com/v1/projects/' + ref + '/database/query', os.environ['SUPABASE_ACCESS_TOKEN'], {'query': query})[0]['state']
    hashes = {k: {'sha256': digest(json.dumps(v, sort_keys=True, separators=(',', ':')).encode()), 'count': len(v) if isinstance(v, list) else None} for k, v in state.items()}
    return {'captured_at': datetime.now(timezone.utc).isoformat(), 'production_root': str(PRODUCTION), 'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=PRODUCTION, text=True).strip(), 'git_status': subprocess.check_output(['git', 'status', '--porcelain'], cwd=PRODUCTION, text=True), 'files': files, 'cron': cron, 'argv': ['node', str(PRODUCTION / 'scripts/tj-po-push.mjs'), '--once'], 'pusher_schema': 'public', 'public_tj': hashes}

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--out', required=True)
    p.add_argument('--compare')
    a = p.parse_args()
    result = capture()
    if a.compare:
        old = json.loads(Path(a.compare).read_text())
        result['comparison'] = {k: old[k] == result[k] for k in ['production_root', 'head', 'git_status', 'files', 'cron', 'argv', 'pusher_schema', 'public_tj']}
    target = Path(a.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    target.chmod(0o600)
    print(json.dumps({'evidence': str(target), 'public_tj': result['public_tj'], 'comparison': result.get('comparison'), 'production_head': result['head']}, ensure_ascii=False))

if __name__ == '__main__':
    main()
