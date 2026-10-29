/** 阶段 2 的测试页：流式对话 + 工具审批卡片。 */
export const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>pii · 阶段 2</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
         background:#0f1115; color:#d6d9e0; }
  header { position:sticky; top:0; z-index:2; padding:10px 14px; background:#161a21;
           border-bottom:1px solid #232936; display:flex; gap:12px; align-items:center; }
  #dot { width:8px; height:8px; border-radius:50%; background:#e0533d; flex:none; }
  #dot.on { background:#4caf7d; }
  #usage { margin-left:auto; color:#7d8798; font-size:12px; overflow:hidden;
           text-overflow:ellipsis; white-space:nowrap; }
  #log { padding:14px 14px 260px; max-width:900px; }
  .e { margin:0 0 14px; }
  .k { font-size:11px; letter-spacing:.06em; color:#7d8798; text-transform:uppercase; }
  .u .k { color:#6fa8dc; } .a .k { color:#8fd694; } .t .k { color:#c8a2e8; }
  .think { color:#7d8798; font-style:italic; white-space:pre-wrap; }
  .tool { color:#e0b96b; white-space:pre-wrap; }
  .toolres { color:#7d8798; white-space:pre-wrap; }
  pre { margin:4px 0 0; white-space:pre-wrap; word-break:break-word; }

  #approvals { position:fixed; bottom:64px; left:0; right:0; z-index:3;
               display:flex; flex-direction:column; gap:8px; padding:0 14px;
               max-height:60vh; overflow-y:auto; }
  .appr { background:#2a1f16; border:1px solid #7a5a2e; border-radius:8px;
          padding:10px 12px; max-width:900px; margin:0 auto; width:100%; }
  .appr h4 { margin:0 0 6px; font-size:12px; letter-spacing:.06em;
             color:#e0b96b; text-transform:uppercase; }
  .appr .cmd { white-space:pre-wrap; word-break:break-word; max-height:30vh;
               overflow-y:auto; background:#0f1115; border-radius:6px;
               padding:8px; border:1px solid #3a2c1c; }
  .appr .row { display:flex; gap:8px; margin-top:10px; align-items:center; }
  .appr .hint { color:#7d8798; font-size:12px; margin-left:auto; }
  form { position:fixed; bottom:0; left:0; right:0; display:flex; gap:8px;
         padding:10px 14px; background:#161a21; border-top:1px solid #232936; }
  input { flex:1; padding:10px; background:#0f1115; color:inherit;
          border:1px solid #2b3242; border-radius:6px; font:inherit; }
  button { padding:9px 16px; background:#2b3242; color:inherit; border:0;
           border-radius:6px; font:inherit; cursor:pointer; }
  button.allow { background:#2e6b4a; }
  button.deny { background:#7a2f2a; }
  button:disabled { opacity:.4; cursor:default; }
</style>
</head>
<body>
<header>
  <span id="dot"></span>
  <span id="status">连接中…</span>
  <span id="usage"></span>
</header>
<div id="log"></div>
<div id="approvals"></div>
<form id="form">
  <input id="text" placeholder="说点什么…（试试：用 bash 列出当前目录）" autocomplete="off">
  <button id="send">发送</button>
</form>
<script>
const log = document.getElementById("log");
const approvalsEl = document.getElementById("approvals");
const dot = document.getElementById("dot");
const statusEl = document.getElementById("status");
const usageEl = document.getElementById("usage");
const input = document.getElementById("text");
const form = document.getElementById("form");
const sendBtn = document.getElementById("send");

const pending = new Map();   // approval id -> request

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/** 整页重绘：阶段 2 仍然坚持"快照是账单"。 */
function render(snapshot) {
  const parts = [];
  for (const entry of snapshot.entries) {
    let cls = "e a";
    if (entry.kind === "pi.user") cls = "e u";
    else if (entry.kind !== "pi.assistant") cls = "e t";
    const label = entry.kind.replace(/^pi\./, "");
    const body = entry.blocks.map(b => {
      if (b.type === "thinking") return '<div class="think">' + esc(b.text) + "</div>";
      if (b.type === "toolCall") return '<div class="tool">▸ ' + esc(b.name) + " " + esc(JSON.stringify(b.input)) + "</div>";
      if (b.type === "toolResult") return '<div class="toolres">◂ ' + esc(b.text.slice(0, 800)) + "</div>";
      return "<pre>" + esc(b.text) + "</pre>";
    }).join("");
    parts.push('<div class="' + cls + '"><div class="k">' + esc(label) + "</div>" + body + "</div>");
  }
  const live = snapshot.live;
  if (live && (live.phase === "generating" || live.phase === "streaming")) {
    parts.push('<div class="e a"><div class="k">streaming…</div><pre>▊</pre></div>');
  }
  log.innerHTML = parts.join("") || '<div class="e"><div class="k">空会话</div></div>';
  usageEl.textContent = snapshot.usage ? JSON.stringify(snapshot.usage).slice(0, 160) : "";
}

function renderApprovals() {
  approvalsEl.innerHTML = "";
  for (const req of pending.values()) {
    const left = Math.max(0, Math.round((req.expiresAt - Date.now()) / 1000));
    const card = document.createElement("div");
    card.className = "appr";
    card.innerHTML =
      "<h4>需要你确认 · " + esc(req.tool) + "</h4>" +
      '<div class="cmd">' + esc(JSON.stringify(req.input, null, 2)) + "</div>";
    const row = document.createElement("div");
    row.className = "row";
    const allow = document.createElement("button");
    allow.className = "allow";
    allow.textContent = "允许";
    const deny = document.createElement("button");
    deny.className = "deny";
    deny.textContent = "拒绝";
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = left + " 秒后自动拒绝";
    row.append(allow, deny, hint);
    card.append(row);
    const answer = async (ok) => {
      allow.disabled = deny.disabled = true;
      hint.textContent = ok ? "已允许" : "已拒绝";
      await fetch("/api/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: req.id, allow: ok }),
      });
      pending.delete(req.id);
      renderApprovals();
    };
    allow.onclick = () => answer(true);
    deny.onclick = () => answer(false);
    approvalsEl.append(card);
  }
}

setInterval(renderApprovals, 1000);

function setStatus(state, text) {
  dot.className = state;
  statusEl.textContent = text;
}

function connect() {
  const es = new EventSource("/api/stream");
  es.addEventListener("state", ev => render(JSON.parse(ev.data)));
  es.addEventListener("approval", ev => {
    const req = JSON.parse(ev.data);
    pending.set(req.id, req);
    renderApprovals();
  });
  es.addEventListener("approval-resolved", ev => {
    const out = JSON.parse(ev.data);
    pending.delete(out.id);
    renderApprovals();
  });
  es.onopen = () => { setStatus("on", "已连接"); sendBtn.disabled = false; };
  es.onerror = () => setStatus("", "断开，重连中…");
}

form.addEventListener("submit", async ev => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  await fetch("/api/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
});

connect();
</script>
</body>
</html>
`;

// self-update e2e 测试：01:48:48
