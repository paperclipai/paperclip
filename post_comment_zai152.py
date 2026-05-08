import json, os, urllib.request, urllib.error

api = 'http://127.0.0.1:3100'
key = os.environ['PAPERCLIP_API_KEY']
run = os.environ['PAPERCLIP_RUN_ID']
parent = 'f3b5d7c5-8e9a-46f6-a30c-4e947f7d8eb1'

body_text = open('zai152_comment.md', 'r', encoding='utf-8').read()
body = {'body': body_text}

req = urllib.request.Request(
    f'{api}/api/issues/{parent}/comments',
    data=json.dumps(body).encode('utf-8'),
    headers={
        'Authorization': f'Bearer {key}',
        'X-Paperclip-Run-Id': run,
        'Content-Type': 'application/json',
    },
    method='POST',
)
try:
    with urllib.request.urlopen(req) as resp:
        out = json.loads(resp.read().decode('utf-8'))
    print('OK comment id:', out.get('id'))
except urllib.error.HTTPError as e:
    print('HTTP', e.code, e.read().decode('utf-8'))
