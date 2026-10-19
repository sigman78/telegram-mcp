/** All the HTML this server serves. Small, self-contained pages; no framework. */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--fg:#14171a;--muted:#5b6670;--line:#dde2e7;--accent:#229ed9;--accent-fg:#fff;--bad:#c0392b}
@media (prefers-color-scheme:dark){:root{--bg:#0f1418;--card:#171d23;--fg:#e8edf1;--muted:#93a0ab;--line:#28323b;--accent:#37aee2;--accent-fg:#06222f;--bad:#ff7b6b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:1.35rem;margin:0 0 .5rem}p{margin:.5rem 0;color:var(--muted)}
label{display:block;margin:1rem 0 .3rem;font-size:.9rem}
input{width:100%;padding:.65rem .75rem;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit}
button,.btn{display:inline-block;margin-top:1rem;padding:.65rem 1.1rem;border:0;border-radius:8px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button.quiet{background:transparent;color:var(--muted);border:1px solid var(--line)}
.err{color:var(--bad)}code,pre{font:.85rem ui-monospace,Consolas,monospace;background:var(--bg);border:1px solid var(--line);border-radius:6px}
code{padding:.1rem .3rem}pre{padding:.7rem;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
#qr{background:#fff;border-radius:10px;padding:10px;margin:1rem auto;max-width:280px}#qr svg{display:block;width:100%;height:auto}
ol{padding-left:1.2rem;color:var(--muted)}
`;

const shell = (title: string, body: string, script = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;

export const messagePage = (title: string, msg: string) => shell(title, `<h1>${esc(title)}</h1><p>${esc(msg)}</p>`);

export const landingPage = () =>
  shell(
    'telegram-mcp',
    `<h1>telegram-mcp</h1><p>A private, read-only MCP server over one person's Telegram account. If this is your server, set it up below.</p>` +
      `<a class="btn" href="/setup">Set up or sign in</a>`,
  );

export const loginPage = (action: string, error?: string, approve?: { name: string; host: string }) =>
  shell(
    'Sign in',
    (approve
      ? `<h1>Approve ${esc(approve.name)}?</h1><p><strong>${esc(approve.name)}</strong> (it will be sent back to <code>${esc(approve.host)}</code>) will be able to read and search your Telegram chats. If you did not just ask an app to connect, close this page.</p><p>Enter the owner password to approve.</p>`
      : `<h1>Sign in</h1><p>Enter the owner password for this server.</p>`) +
      `<form method="post" action="${esc(action)}"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>` +
      (error ? `<p class="err">${esc(error)}</p>` : '') +
      `<button type="submit">Continue</button></form>`,
  );

export const consentPage = (clientName: string, host: string, signInUrl: string) =>
  shell(
    'Allow access',
    `<h1>Allow access?</h1><p><strong>${esc(clientName)}</strong> (it will be sent back to <code>${esc(host)}</code>) wants to read this server's Telegram chats. It can read and search messages. It cannot send, edit or delete anything.</p>` +
      `<a class="btn" href="${esc(signInUrl)}">Continue</a>`,
  );

/** The setup screen: shows the QR code, takes the 2FA password, and finishes an MCP client's approval once linked. */
export const linkPage = (token: string, oauthReq: string | null) =>
  shell(
    'Link Telegram',
    `<h1>Link Telegram</h1><div id="view"><p>Loading...</p></div>`,
    `
const TOKEN=${JSON.stringify(token)}, REQ=${JSON.stringify(oauthReq)};
const view=document.getElementById('view');
const h=(html)=>{view.innerHTML=html};
const el=(tag,text,cls)=>{const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e};
async function api(path,body){
  const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+TOKEN,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  if(r.status===401){h('<p class="err">This page timed out. Reload it to sign in again.</p>');throw new Error('expired')}
  return r.json();
}
let lastStart=0, finishing=false, lastPhase='', lastSvg='';
async function tick(){
  let s;
  try{s=await api('/link/status')}catch(e){return}
  if(!s.configured){h('<p class="err">This server has no Telegram API credentials yet. Set the TG_API_ID and TG_API_HASH secrets (from my.telegram.org) and reload.</p>');return}
  if(s.linked){
    if(REQ&&!finishing){finishing=true;h('<p>Linked. Finishing sign-in...</p>');const r=await api('/link/finish',{req:REQ});location.href=r.redirectTo;return}
    if(lastPhase!=='linked'){
      lastPhase='linked';view.textContent='';
      view.append(el('p','Linked as '+s.me.name+(s.me.username?' (@'+s.me.username+')':'')+'.'));
      view.append(el('p','Add it to Claude Code:'));
      const pre=el('pre','claude mcp add --transport http telegram '+location.origin+'/mcp');view.append(pre);
      const b=el('button','Unlink','quiet');b.onclick=async()=>{b.disabled=true;await api('/link/relink',{});lastPhase=''};view.append(b);
    }
    return;
  }
  if(s.phase==='idle'){if(Date.now()-lastStart>5000){lastStart=Date.now();await api('/link/start',{})}return}
  if(s.phase==='error'){
    if(lastPhase==='error:'+s.error)return;lastPhase='error:'+s.error;view.textContent='';
    view.append(el('p','Linking failed: '+s.error,'err'));
    const b=el('button','Try again');b.onclick=async()=>{await api('/link/start',{})};view.append(b);return;
  }
  if(s.phase==='password'){
    const key='password:'+s.attempt;if(lastPhase===key)return;lastPhase=key;view.textContent='';
    view.append(el('p','This account has two-step verification. Enter your Telegram cloud password.'));
    if(s.error)view.append(el('p',s.error,'err'));
    const i=document.createElement('input');i.type='password';i.autocomplete='current-password';view.append(i);
    const b=el('button','Continue');b.onclick=async()=>{b.disabled=true;await api('/link/password',{password:i.value})};view.append(b);i.focus();return;
  }
  if(s.phase==='scanned'){if(lastPhase!=='scanned'){lastPhase='scanned';h('<p>Scanned. Finishing the link...</p>')}return}
  if(s.phase==='qr'&&s.qrSvg){
    if(lastPhase==='qr'&&lastSvg===s.qrSvg)return;lastPhase='qr';lastSvg=s.qrSvg;
    view.innerHTML='<p>Scan this with the Telegram app on your phone:</p><div id="qr"></div><ol><li>Open Telegram, then Settings</li><li>Devices, then Link Desktop Device</li><li>Point the camera at this code</li></ol>';
    document.getElementById('qr').innerHTML=s.qrSvg;
  }
}
tick();setInterval(tick,1500);
`,
  );
