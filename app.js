import {
  BlobReader, BlobWriter, TextReader, TextWriter, ZipReader, ZipWriter
} from "https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.18.2/+esm";
import { createSHA1 } from "https://cdn.jsdelivr.net/npm/hash-wasm@4.12.0/+esm";

const REPO_OWNER = "kiillzzz132-commits";
const REPO_NAME = "worldforge-pack-manager";
const API_RELEASES = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=100`;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const state = {
  oldFile: null, newFile: null,
  oldPack: null, newPack: null,
  analysis: null,
  resolutions: {},
  outputBlob: null,
  outputName: "WorldForge-Merged.zip",
  outputSha1: "",
  report: null,
  directSaved: false
};

const fmtBytes = (n=0) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n/1024**2).toFixed(1)} MB`;
  return `${(n/1024**3).toFixed(2)} GB`;
};
const fmtDate = (s) => new Date(s).toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"});
const esc = (s="") => s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function switchView(name){
  $$(".nav-link").forEach(b=>b.classList.toggle("active",b.dataset.view===name));
  $$(".view").forEach(v=>v.classList.toggle("active",v.id===`view-${name}`));
  location.hash = name;
  if(name==="releases") loadReleases();
}
$$(".nav-link").forEach(b=>b.addEventListener("click",()=>switchView(b.dataset.view)));
if(["merge","releases","about"].includes(location.hash.slice(1))) switchView(location.hash.slice(1));

function showError(message){
  $("#errorText").textContent=message;
  $("#errorToast").classList.remove("hidden");
}
$("#closeError").onclick=()=>$("#errorToast").classList.add("hidden");

function setProgress(phase, pct, title, detail){
  const order=["read","compare","merge","validate","hash"];
  $("#workingStage").classList.remove("hidden");
  $("#workingPercent").textContent=`${Math.max(0,Math.min(100,Math.round(pct)))}%`;
  $("#progressBar").style.width=`${pct}%`;
  if(title) $("#workingTitle").textContent=title;
  if(detail) $("#workingDetail").textContent=detail;
  const idx=order.indexOf(phase);
  $$(".phase").forEach((el,i)=>{
    el.classList.toggle("active",i===idx);
    el.classList.toggle("done",i<idx);
  });
}
function hideWorking(){ $("#workingStage").classList.add("hidden"); }

function wireDrop(zoneSel,inputSel,which){
  const zone=$(zoneSel), input=$(inputSel);
  ["dragenter","dragover"].forEach(ev=>zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.add("drag")}));
  ["dragleave","drop"].forEach(ev=>zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.remove("drag")}));
  zone.addEventListener("drop",e=>{ if(e.dataTransfer.files?.[0]) setFile(which,e.dataTransfer.files[0],input,zone); });
  input.addEventListener("change",()=>{ if(input.files?.[0]) setFile(which,input.files[0],input,zone); });
}
function setFile(which,file,input,zone){
  if(!file.name.toLowerCase().endsWith(".zip")) return showError("Resource packs must be ZIP files.");
  state[which+"File"]=file;
  zone.classList.add("ready");
  const target = which==="old" ? "#oldMeta" : "#newMeta";
  $(target).innerHTML=`<span title="${esc(file.name)}">${esc(file.name)} • ${fmtBytes(file.size)}</span>`;
  $("#analyzeBtn").disabled=!(state.oldFile&&state.newFile);
}
wireDrop("#oldDrop","#oldFile","old");
wireDrop("#newDrop","#newFile","new");

async function closePack(pack){
  try{ if(pack?.reader) await pack.reader.close(); }catch{}
}
async function resetAll(){
  await closePack(state.oldPack); await closePack(state.newPack);
  if(state.outputBlob) URL.revokeObjectURL(state.outputBlob);
  Object.assign(state,{oldFile:null,newFile:null,oldPack:null,newPack:null,analysis:null,resolutions:{},outputBlob:null,outputSha1:"",report:null,directSaved:false});
  $("#oldFile").value=""; $("#newFile").value="";
  $("#oldDrop").classList.remove("ready"); $("#newDrop").classList.remove("ready");
  $("#oldMeta").innerHTML="<span>No ZIP selected</span>"; $("#newMeta").innerHTML="<span>No ZIP selected</span>";
  $("#analyzeBtn").disabled=true;
  $("#reviewStage").classList.add("hidden"); $("#resultStage").classList.add("hidden"); hideWorking();
}
$("#resetBtn").onclick=resetAll;

function cleanName(name){
  return name.replace(/\\/g,"/").replace(/^\.\//,"");
}
function safeRelative(name){
  const parts=name.split("/").filter(Boolean);
  if(parts.some(p=>p===".."||p===".")) return false;
  return !name.startsWith("/");
}
function findPackPrefix(entries){
  const candidates=entries
    .filter(e=>!e.directory)
    .map(e=>cleanName(e.filename))
    .filter(n=>n==="pack.mcmeta"||n.endsWith("/pack.mcmeta"))
    .sort((a,b)=>a.split("/").length-b.split("/").length);
  if(!candidates.length) throw new Error("pack.mcmeta was not found. Make sure each ZIP is a complete Minecraft resource pack.");
  const marker=candidates[0];
  return marker.slice(0,marker.length-"pack.mcmeta".length);
}
async function openPack(file,label){
  const reader=new ZipReader(new BlobReader(file),{checkCrc32:false});
  let entries;
  try{ entries=await reader.getEntries(); }
  catch(e){ await reader.close(); throw new Error(`${label} is not a valid ZIP: ${e.message}`); }
  const prefix=findPackPrefix(entries);
  const map=new Map();
  for(const e of entries){
    if(e.directory) continue;
    const raw=cleanName(e.filename);
    if(!raw.startsWith(prefix)) continue;
    const rel=raw.slice(prefix.length);
    if(!rel||rel.endsWith("/")||!safeRelative(rel)||rel.startsWith("__MACOSX/")) continue;
    if(map.has(rel)) throw new Error(`${label} contains the same path twice: ${rel}`);
    map.set(rel,e);
  }
  if(!map.has("pack.mcmeta")) throw new Error(`${label} has no pack.mcmeta at the detected pack root.`);
  return {file,label,reader,entries:map,prefix};
}
function sameEntry(a,b){
  if(!a||!b) return false;
  if(a.uncompressedSize!==b.uncompressedSize) return false;
  if(Number.isInteger(a.crc32)&&Number.isInteger(b.crc32)) return a.crc32===b.crc32;
  return false;
}
function smartKind(path){
  const p=path.toLowerCase();
  if(p==="pack.mcmeta") return "pack_mcmeta";
  if(p.endsWith("/sounds.json")) return "sounds";
  if(p.includes("/font/")&&p.endsWith(".json")) return "font";
  if(p.includes("/lang/")&&p.endsWith(".json")) return "lang";
  if(p.includes("/atlases/")&&p.endsWith(".json")) return "atlas";
  if(p.includes("/tags/")&&p.endsWith(".json")) return "tag";
  return null;
}
async function readJson(entry,path){
  try{
    const text=await entry.getData(new TextWriter("utf-8"));
    return JSON.parse(text.replace(/^\uFEFF/,""));
  }catch(e){ throw new Error(`${path}: ${e.message}`); }
}
function dedupeList(values){
  const seen=new Set(), out=[];
  for(const v of values){
    const key=JSON.stringify(v,Object.keys(v&&typeof v==="object"&&!Array.isArray(v)?v:{}).sort());
    if(!seen.has(key)){seen.add(key);out.push(v);}
  }
  return out;
}
function recursiveMerge(oldVal,newVal){
  if(oldVal&&newVal&&typeof oldVal==="object"&&typeof newVal==="object"&&!Array.isArray(oldVal)&&!Array.isArray(newVal)){
    const out={...oldVal};
    for(const [k,v] of Object.entries(newVal)) out[k]=k in out?recursiveMerge(out[k],v):v;
    return out;
  }
  return newVal;
}
function smartMerge(oldVal,newVal,kind){
  if(!oldVal||!newVal||typeof oldVal!=="object"||typeof newVal!=="object"||Array.isArray(oldVal)||Array.isArray(newVal)) return newVal;
  const out=recursiveMerge(oldVal,newVal);
  if(kind==="font") out.providers=dedupeList([...(Array.isArray(oldVal.providers)?oldVal.providers:[]),...(Array.isArray(newVal.providers)?newVal.providers:[])]);
  if(kind==="atlas") out.sources=dedupeList([...(Array.isArray(oldVal.sources)?oldVal.sources:[]),...(Array.isArray(newVal.sources)?newVal.sources:[])]);
  if(kind==="tag") out.values=newVal.replace===true
    ? dedupeList(Array.isArray(newVal.values)?newVal.values:[])
    : dedupeList([...(Array.isArray(oldVal.values)?oldVal.values:[]),...(Array.isArray(newVal.values)?newVal.values:[])]);
  return out;
}

async function analyze(){
  if(!state.oldFile||!state.newFile) return;
  $("#reviewStage").classList.add("hidden"); $("#resultStage").classList.add("hidden");
  try{
    setProgress("read",4,"Opening both ZIPs…","Reading archive indexes locally.");
    await closePack(state.oldPack); await closePack(state.newPack);
    state.oldPack=await openPack(state.oldFile,"Older pack");
    setProgress("read",11,"Opening newer pack…",`${state.oldPack.entries.size.toLocaleString()} files indexed in the older pack.`);
    state.newPack=await openPack(state.newFile,"Newer pack");

    const paths=[...new Set([...state.oldPack.entries.keys(),...state.newPack.entries.keys()])].sort();
    const analysis={paths,items:new Map(),merged:new Map(),counts:{preserved:0,added:0,updated:0,unchanged:0,smart:0,conflicts:0}};
    setProgress("compare",18,"Comparing pack contents…",`${paths.length.toLocaleString()} unique paths to compare.`);

    for(let i=0;i<paths.length;i++){
      const path=paths[i], oldE=state.oldPack.entries.get(path), newE=state.newPack.entries.get(path);
      let item;
      if(!oldE){ item={path,type:"added",source:"new"}; analysis.counts.added++; }
      else if(!newE){ item={path,type:"preserved",source:"old"}; analysis.counts.preserved++; }
      else if(sameEntry(oldE,newE)){ item={path,type:"unchanged",source:"new"}; analysis.counts.unchanged++; }
      else{
        const kind=smartKind(path);
        if(kind){
          try{
            const [a,b]=await Promise.all([readJson(oldE,path),readJson(newE,path)]);
            analysis.merged.set(path,smartMerge(a,b,kind));
            item={path,type:"smart",kind}; analysis.counts.smart++;
          }catch(err){
            item={path,type:"conflict",reason:err.message}; analysis.counts.conflicts++; analysis.counts.updated++;
          }
        }else{
          item={path,type:"conflict"}; analysis.counts.conflicts++; analysis.counts.updated++;
        }
      }
      analysis.items.set(path,item);
      if(i%40===0) setProgress("compare",18+42*(i/Math.max(1,paths.length)),"Comparing pack contents…",`${i.toLocaleString()} / ${paths.length.toLocaleString()} paths checked.`);
    }
    state.analysis=analysis;
    state.resolutions={};
    for(const [path,item] of analysis.items) if(item.type==="conflict") state.resolutions[path]="new";
    setProgress("merge",63,"Analysis complete","Preparing conflict review.");
    renderReview();
    setTimeout(()=>{hideWorking();$("#reviewStage").classList.remove("hidden");$("#reviewStage").scrollIntoView({behavior:"smooth",block:"start"});},220);
  }catch(e){
    hideWorking(); showError(e.message||String(e));
  }
}
$("#analyzeBtn").onclick=analyze;

function renderReview(){
  const c=state.analysis.counts;
  const stats=[["Preserved",c.preserved],["Added",c.added],["Unchanged",c.unchanged],["Smart merged",c.smart],["Conflicts",c.conflicts]];
  $("#stats").innerHTML=stats.map(([k,v])=>`<div class="stat"><b>${v.toLocaleString()}</b><span>${k}</span></div>`).join("");
  const conflicts=[...state.analysis.items.values()].filter(i=>i.type==="conflict");
  $("#conflictCount").textContent=`${conflicts.length.toLocaleString()} conflict${conflicts.length===1?"":"s"}`;
  $("#conflictBlock").classList.toggle("hidden",!conflicts.length);
  const box=$("#conflicts"); box.innerHTML="";
  for(const item of conflicts){
    const row=document.createElement("div");row.className="conflict";
    const code=document.createElement("code");code.textContent=item.path;
    const choice=document.createElement("div");choice.className="choice";
    const newer=document.createElement("button"), older=document.createElement("button");
    newer.textContent="Use NEW";older.textContent="Keep OLD";newer.className="active";
    newer.onclick=()=>{state.resolutions[item.path]="new";newer.classList.add("active");older.classList.remove("active")};
    older.onclick=()=>{state.resolutions[item.path]="old";older.classList.add("active");newer.classList.remove("active")};
    choice.append(newer,older);row.append(code,choice);box.append(row);
  }
  const supported="showSaveFilePicker" in window;
  $("#largeMode").disabled=!supported;
  $("#largeModeHint").classList.toggle("hidden",supported);
}

async function getNormalBlob(entry){
  return entry.getData(new BlobWriter("application/octet-stream"));
}
async function copyEntry(writer,path,entry){
  try{
    const raw=await entry.getData(new BlobWriter("application/octet-stream"),{passThrough:true});
    await writer.add(path,new BlobReader(raw),{passThrough:true,entry});
    return "passthrough";
  }catch{
    const blob=await getNormalBlob(entry);
    await writer.add(path,new BlobReader(blob),{entry,level:6});
    return "recompressed";
  }
}
function selectedEntry(path,item){
  const oldE=state.oldPack.entries.get(path),newE=state.newPack.entries.get(path);
  if(item.type==="preserved") return oldE;
  if(item.type==="added"||item.type==="unchanged") return newE;
  if(item.type==="conflict") return state.resolutions[path]==="old"?oldE:newE;
  return null;
}
async function validateMergedJson(){
  let checked=0;
  for(const [path,obj] of state.analysis.merged){
    JSON.stringify(obj);
    checked++;
  }
  const packObj=state.analysis.merged.get("pack.mcmeta");
  if(packObj){
    if(!packObj.pack||typeof packObj.pack!=="object") throw new Error("Merged pack.mcmeta does not contain a valid pack object.");
  }else{
    const item=state.analysis.items.get("pack.mcmeta");
    const e=selectedEntry("pack.mcmeta",item);
    const obj=await readJson(e,"pack.mcmeta");
    if(!obj.pack||typeof obj.pack!=="object") throw new Error("pack.mcmeta does not contain a valid pack object.");
  }
  return checked;
}
async function createHashingWritable(fileWritable,hasher){
  return new WritableStream({
    async write(chunk){ hasher.update(chunk); await fileWritable.write(chunk); },
    async close(){ await fileWritable.close(); },
    async abort(reason){ try{await fileWritable.abort(reason)}catch{} }
  });
}
async function hashBlob(blob){
  const h=await createSHA1();h.init();
  const reader=blob.stream().getReader();
  while(true){
    const {done,value}=await reader.read();
    if(done)break;
    h.update(value);
  }
  return h.digest("hex");
}
function mergedFilename(){
  const clean=(name)=>name.replace(/\.zip$/i,"").replace(/[^a-z0-9._-]+/gi,"-").replace(/-+/g,"-").slice(0,70);
  return `${clean(state.newFile.name)||"WorldForge"}-Merged.zip`;
}

async function build(){
  if(!state.analysis)return;
  $("#resultStage").classList.add("hidden");
  state.outputBlob=null;state.directSaved=false;
  const paths=state.analysis.paths;
  const largeMode=$("#largeMode").checked&&("showSaveFilePicker" in window);
  state.outputName=mergedFilename();
  let writer,hashingState=null,fileHandle=null;
  try{
    setProgress("validate",66,"Validating merged metadata…","Checking smart-merged JSON and pack.mcmeta.");
    const checked=await validateMergedJson();
    setProgress("merge",70,"Building merged ZIP…",`${checked} smart-merged JSON files validated.`);

    if(largeMode){
      fileHandle=await window.showSaveFilePicker({suggestedName:state.outputName,types:[{description:"Minecraft resource pack",accept:{"application/zip":[".zip"]}}]});
      const fileWritable=await fileHandle.createWritable();
      const h=await createSHA1();h.init();hashingState=h;
      const hashingWritable=await createHashingWritable(fileWritable,h);
      writer=new ZipWriter(hashingWritable,{zip64:true,useCompressionStream:true});
    }else{
      writer=new ZipWriter(new BlobWriter("application/zip"),{zip64:true,useCompressionStream:true});
    }

    let pass=0,recompressed=0;
    for(let i=0;i<paths.length;i++){
      const path=paths[i],item=state.analysis.items.get(path);
      if(item.type==="smart"){
        const text=JSON.stringify(state.analysis.merged.get(path),null,2)+"\n";
        await writer.add(path,new TextReader(text),{level:6});
      }else{
        const entry=selectedEntry(path,item);
        if(!entry) throw new Error(`No selected source for ${path}`);
        const mode=await copyEntry(writer,path,entry);
        if(mode==="passthrough")pass++;else recompressed++;
      }
      if(i%12===0) setProgress("merge",70+20*(i/Math.max(1,paths.length)),"Building merged ZIP…",`${i.toLocaleString()} / ${paths.length.toLocaleString()} files • ${pass.toLocaleString()} fast-copied`);
    }

    setProgress("hash",92,"Finishing archive…","Finalizing ZIP and SHA-1.");
    const result=await writer.close();
    if(largeMode){
      state.directSaved=true;
      state.outputSha1=hashingState.digest("hex");
    }else{
      state.outputBlob=result;
      state.outputSha1=await hashBlob(result);
    }
    state.report=makeReport(pass,recompressed,largeMode);
    setProgress("hash",100,"Done","Merged pack is ready.");
    setTimeout(()=>{hideWorking();renderResult();$("#resultStage").classList.remove("hidden");$("#resultStage").scrollIntoView({behavior:"smooth",block:"start"});},250);
  }catch(e){
    try{if(writer)await writer.close()}catch{}
    hideWorking();
    if(e?.name==="AbortError") return;
    showError(e.message||String(e));
  }
}
$("#buildBtn").onclick=build;

function makeReport(pass,recompressed,largeMode){
  const c=state.analysis.counts;
  return {
    generated_at:new Date().toISOString(),
    merger:"WorldForge Resource Merger",
    older_pack:{name:state.oldFile.name,size:state.oldFile.size},
    newer_pack:{name:state.newFile.name,size:state.newFile.size},
    output:{name:state.outputName,sha1:state.outputSha1,size:state.outputBlob?.size??null,direct_to_disk:largeMode},
    counts:c,
    fast_copied_entries:pass,
    recompressed_entries:recompressed,
    conflict_resolutions:state.resolutions,
    smart_merged:[...state.analysis.items.values()].filter(x=>x.type==="smart").map(x=>({path:x.path,kind:x.kind}))
  };
}
function renderResult(){
  $("#resultName").textContent=state.outputName;
  $("#shaOut").value=state.outputSha1;
  $("#sizeOut").textContent=state.outputBlob?fmtBytes(state.outputBlob.size):"Saved directly to disk";
  $("#resultSummary").textContent=state.directSaved
    ?"Large Pack Mode saved the ZIP directly to your computer and calculated SHA-1 while writing."
    :"Validated and ready to download.";
  $("#propertiesOut").textContent=`resource-pack=<DIRECT_RELEASE_DOWNLOAD_URL>\nresource-pack-sha1=${state.outputSha1}\nresource-pack-required=true`;
  $("#downloadResult").disabled=state.directSaved;
  $("#downloadResult").textContent=state.directSaved?"Already saved to disk":"Download merged ZIP";
}
$("#downloadResult").onclick=()=>{
  if(!state.outputBlob)return;
  const url=URL.createObjectURL(state.outputBlob);
  const a=document.createElement("a");a.href=url;a.download=state.outputName;document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
};
$("#downloadReport").onclick=()=>{
  if(!state.report)return;
  const blob=new Blob([JSON.stringify(state.report,null,2)+"\n"],{type:"application/json"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=state.outputName.replace(/\.zip$/i,"")+"-merge-report.json";a.click();
  setTimeout(()=>URL.revokeObjectURL(url),10000);
};
$("#copyReleaseNotes").onclick=async()=>{
  const size=state.outputBlob?fmtBytes(state.outputBlob.size):"See uploaded asset";
  const notes=`## WorldForge Resource Pack\n\nMerged with WorldForge Resource Merger.\n\n- SHA-1: \`${state.outputSha1}\`\n- Size: ${size}\n- Older source: ${state.oldFile.name}\n- Newer source: ${state.newFile.name}\n\n### Minecraft server.properties\n\n\`\`\`properties\nresource-pack=<PASTE_RELEASE_ASSET_URL>\nresource-pack-sha1=${state.outputSha1}\nresource-pack-required=true\n\`\`\``;
  await navigator.clipboard.writeText(notes);
  const b=$("#copyReleaseNotes"),old=b.textContent;b.textContent="Copied";setTimeout(()=>b.textContent=old,1200);
};
$$("[data-copy]").forEach(b=>b.onclick=async()=>{await navigator.clipboard.writeText($("#"+b.dataset.copy).value);const t=b.textContent;b.textContent="Copied";setTimeout(()=>b.textContent=t,900)});
$$("[data-copy-text]").forEach(b=>b.onclick=async()=>{await navigator.clipboard.writeText($("#"+b.dataset.copyText).textContent);const t=b.textContent;b.textContent="Copied";setTimeout(()=>b.textContent=t,900)});

function releaseAsset(release){
  const zips=(release.assets||[]).filter(a=>a.name.toLowerCase().endsWith(".zip"));
  return zips[0]||null;
}
function shaFromBody(body=""){
  const m=body.match(/SHA-?1\s*[:=]\s*[`*]*([a-f0-9]{40})/i);
  return m?.[1]||"";
}
function notesPreview(body=""){
  return body.replace(/[#>*_`]/g,"").replace(/\s+/g," ").trim().slice(0,240);
}
async function loadReleases(){
  const latest=$("#latestRelease"),list=$("#releaseList"),empty=$("#releaseEmpty");
  latest.innerHTML='<div class="release-loading">Loading official releases…</div>';list.innerHTML="";empty.classList.add("hidden");
  try{
    const r=await fetch(API_RELEASES,{headers:{"Accept":"application/vnd.github+json"}});
    if(!r.ok) throw new Error(r.status===404?"The release archive is not public yet.":"GitHub returned "+r.status);
    const releases=(await r.json()).filter(x=>!x.draft);
    if(!releases.length){latest.innerHTML="";latest.classList.add("hidden");empty.classList.remove("hidden");return;}
    latest.classList.remove("hidden");
    const first=releases[0],asset=releaseAsset(first),sha=shaFromBody(first.body||"");
    latest.innerHTML=`<div class="latest-layout"><div><div class="latest-label">LATEST RELEASE</div><h2>${esc(first.name||first.tag_name)}</h2><div class="latest-meta"><span>${fmtDate(first.published_at||first.created_at)}</span>${asset?`<span>${fmtBytes(asset.size)}</span><span>${asset.download_count.toLocaleString()} downloads</span>`:""}${sha?`<span>SHA-1 ${sha.slice(0,10)}…</span>`:""}</div><div class="latest-notes">${esc(notesPreview(first.body||"Official WorldForge resource pack release."))}</div></div><div>${asset?`<a class="primary download-main" href="${asset.browser_download_url}">Download latest ↓</a>`:'<span class="secondary">No ZIP asset</span>'}</div></div>`;
    for(const rel of releases){
      const a=releaseAsset(rel),row=document.createElement("div");row.className="release-row";
      row.innerHTML=`<div class="release-tag">${esc(rel.tag_name)}</div><div class="release-main"><strong>${esc(rel.name||rel.tag_name)}</strong><small>${a?esc(a.name):"No ZIP asset attached"}</small></div><div class="release-size">${a?fmtBytes(a.size):"—"}</div><div class="release-date">${fmtDate(rel.published_at||rel.created_at)}</div><div class="release-actions">${a?`<a href="${a.browser_download_url}">Download</a>`:""}</div>`;
      list.append(row);
    }
  }catch(e){
    latest.classList.add("hidden");empty.classList.remove("hidden");
    empty.querySelector("h3").textContent="Release archive not available yet";
    empty.querySelector("p").textContent=e.message+" Once the repository and first GitHub Release are public, versions will appear here automatically.";
  }
}
$("#refreshReleases").onclick=loadReleases;
