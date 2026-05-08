import json, os, urllib.request, urllib.error

api = 'http://127.0.0.1:3100'
key = os.environ['PAPERCLIP_API_KEY']
run = os.environ['PAPERCLIP_RUN_ID']
parent = 'f3b5d7c5-8e9a-46f6-a30c-4e947f7d8eb1'
child_id = '88c226a3-2a5f-4ae2-82a8-dd5f57f0a6c2'

description = open('child_zai157_desc.md', 'r', encoding='utf-8').read()

body = {
    'parentId': parent,
}

req = urllib.request.Request(
    f'{api}/api/issues/{child_id}',
    data=json.dumps(body).encode('utf-8'),
    headers={
        'Authorization': f'Bearer {key}',
        'X-Paperclip-Run-Id': run,
        'Content-Type': 'application/json',
    },
    method='PATCH',
)
try:
    with urllib.request.urlopen(req) as resp:
        out = json.loads(resp.read().decode('utf-8'))
    print('PATCHED:', out.get('identifier'))
    print('parent:', out.get('parentIssueId'))
    print('description len:', len(out.get('description') or ''))
except urllib.error.HTTPError as e:
    print('HTTP', e.code, e.read().decode('utf-8'))
