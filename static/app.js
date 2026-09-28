const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let token = null;
let resolutions = {};

function fmtBytes(n){ if(n<1024)return n+' B'; if(n<1048576)return (n/1024).toFixed(1)+' KB'; return (n/1048576).toFixed(1)+' MB'; }
function fmtDate(sec){ return new Date(sec*1000).toLocaleString(); }
function showError(msg){ const e=$('#errorBox'); e.textContent=msg; e.classList.remove('hidden'); }
function clearError(){ $('#errorBox').classList.add('hidden'); }
function setBusy(on){ $('#progress').classList.toggle('hidden',!on); $('#analyzeBtn').disabled=on; if($('#buildBtn')) $('#buildBtn').disabled=on; }

function wireDrop(zoneSel,inputSel,nameSel){
  const zone=$(zoneSel), input=$(inputSel), name=$(nameSel);
  zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('drag')});
  zone.addEventListener('dragleave',()=>zone.classList.remove('drag'));
  zone.addEventListener('drop',e=>{
    e.preventDefault();
    zone.classList.remove('drag');
    if(e.dataTransfer.files.length){
      input.files=e.dataTransfer.files;
      name.textContent=e.dataTransfer.files[0].name;
    }
  });
  input.addEventListener('change',()=>name.textContent=input.files[0]?.name||'No file selected');
}
wireDrop('#oldDrop','#oldPack','#oldName');
wireDrop('#newDrop','#newPack','#newName');

$('#clearBtn').onclick=()=>location.reload();
$('#newMergeBtn').onclick=()=>location.reload();

$('#analyzeBtn').onclick=async()=>{
  clearError();
  const old=$('#oldPack').files[0], neu=$('#newPack').files[0];
  if(!old||!neu){showError('Choose both complete ZIP files first.'); return;}
  const fd=new FormData();
  fd.append('old_pack',old);
  fd.append('new_pack',neu);
  setBusy(true);
  try{
    const r=await fetch('/api/analyze',{method:'POST',body:fd});
    const j=await r.json();
    if(!j.ok) throw new Error(j.error||'Analysis failed');
    token=j.token;
    resolutions={};
    renderReport(j.report,j.conflicts);
    $('#reviewPanel').classList.remove('hidden');
    $('#reviewPanel').scrollIntoView({behavior:'smooth'});
  }catch(e){
    showError(e.message);
  }finally{
    setBusy(false);
  }
};

function renderReport(report,conflicts){
  const c=report.counts;
  const stats=[['Added',c.added],['Updated',c.updated],['Unchanged',c.unchanged],['Smart merged',c.smart_merged],['Conflicts',c.conflicts]];
  $('#stats').innerHTML=stats.map(([k,v])=>'<div class="stat"><b>'+v+'</b><span>'+k+'</span></div>').join('');
  const wrap=$('#conflictWrap'), box=$('#conflicts');
  box.innerHTML='';
  if(conflicts.length){
    wrap.classList.remove('hidden');
    conflicts.forEach(item=>{
      resolutions[item.path]='new';
      const row=document.createElement('div');
      row.className='conflict';
      const code=document.createElement('code');
      code.textContent=item.path;
      const choice=document.createElement('div');
      choice.className='choice';
      const n=document.createElement('button');
      n.textContent='Use NEW';
      n.className='active';
      const o=document.createElement('button');
      o.textContent='Keep OLD';
      n.onclick=()=>{resolutions[item.path]='new';n.classList.add('active');o.classList.remove('active')};
      o.onclick=()=>{resolutions[item.path]='old';o.classList.add('active');n.classList.remove('active')};
      choice.append(n,o);
      row.append(code,choice);
      box.append(row);
    });
  } else {
    wrap.classList.add('hidden');
  }
}

$('#buildBtn').onclick=async()=>{
  if(!token)return;
  clearError();
  setBusy(true);
  try{
    const r=await fetch('/api/build',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token,resolutions})
    });
    const j=await r.json();
    if(!j.ok) throw new Error(j.error||'Build failed');
    renderResult(j);
    await loadHistory();
    $('#resultPanel').classList.remove('hidden');
    $('#resultPanel').scrollIntoView({behavior:'smooth'});
  }catch(e){
    showError(e.message);
  }finally{
    setBusy(false);
  }
};

function renderResult(j){
  const b=j.build;
  $('#resultTitle').textContent='WorldForge Pack v'+b.version;
  $('#resultMeta').textContent=fmtBytes(b.size)+' • SHA-1 verified';
  $('#urlOut').value=j.pack_url;
  $('#shaOut').value=b.sha1;
  $('#propsOut').value=j.server_properties;
  $('#downloadBtn').href=j.download_url;
  $('#urlHint').textContent=j.public
    ? 'Durable public URL ready for a hosted Minecraft server.'
    : 'Hosted app URL. Configure R2 for durable pack hosting across redeploys.';
  const w=$('#publishWarning');
  if(j.publish_error){
    w.textContent='Pack built successfully, but public publishing failed: '+j.publish_error;
    w.classList.remove('hidden');
  } else {
    w.classList.add('hidden');
  }
}

$$('[data-copy]').forEach(btn=>btn.onclick=async()=>{
  const el=$('#'+btn.dataset.copy);
  await navigator.clipboard.writeText(el.value);
  const old=btn.textContent;
  btn.textContent='Copied';
  setTimeout(()=>btn.textContent=old,1000);
});

async function loadHistory(){
  const j=await fetch('/api/history').then(r=>r.json());
  const box=$('#history');
  if(!j.builds?.length){
    box.innerHTML='<div class="empty">No builds yet.</div>';
    return;
  }
  box.innerHTML='';
  j.builds.forEach(b=>{
    const row=document.createElement('div');
    row.className='history-row';
    row.innerHTML='<div class="ver">v'+b.version+'</div>'+
      '<div class="history-main"><strong>'+b.filename+'</strong><small>'+fmtBytes(b.size)+(b.note?' • '+b.note:'')+'</small></div>'+
      '<div class="history-sha">'+b.sha1.slice(0,16)+'…</div>'+
      '<div class="history-date">'+fmtDate(b.created_at)+'</div>'+
      '<div class="history-actions"><a href="/download/'+b.id+'">Download</a><button data-restore="'+b.id+'">Restore</button></div>';
    box.append(row);
  });
  $$('[data-restore]').forEach(btn=>btn.onclick=async()=>{
    if(!confirm('Restore this build as a new version?'))return;
    const j=await fetch('/api/restore/'+btn.dataset.restore,{method:'POST'}).then(r=>r.json());
    if(j.ok) loadHistory(); else alert(j.error||'Restore failed');
  });
}
$('#refreshHistory').onclick=loadHistory;
loadHistory();
