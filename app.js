const $=s=>document.querySelector(s);
const state={items:JSON.parse(localStorage.getItem("carStealItems")||"[]"),view:"all",editingId:null};
const ANALYZER_URL=(window.WHEELBEAST_ANALYZER_URL||"").replace(/\/$/,"");
const fmt=n=>n==null?"Price ?":new Intl.NumberFormat("en-CA",{style:"currency",currency:"CAD",maximumFractionDigits:0}).format(n);
const esc=s=>String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
function source(url=""){try{const h=new URL(url).hostname;if(h.includes("facebook"))return"Facebook Marketplace";if(h.includes("kijiji"))return"Kijiji";if(h.includes("autotrader"))return"AutoTrader";return h}catch{return"Manual"}}
function decodeShared(v=""){
 let s=String(v||"");
 for(let i=0;i<2;i++){try{const d=decodeURIComponent(s);if(d===s)break;s=d}catch{break}}
 return s;
}
function decodeShare64(v=""){
 try{
   // URLSearchParams converts "+" to a space. Apple Shortcuts standard Base64
   // legitimately contains "+", so restore it before decoding. Also remove
   // any line breaks Shortcuts may insert into long Base64 output.
   const normalized=String(v||"")
     .replace(/ /g,"+")
     .replace(/[\r\n\t]/g,"")
     .replace(/-/g,"+")
     .replace(/_/g,"/");
   const padded=normalized+"=".repeat((4-normalized.length%4)%4);
   return decodeURIComponent(Array.from(atob(padded),c=>"%"+c.charCodeAt(0).toString(16).padStart(2,"0")).join(""));
 }catch{return""}
}
function extractSharedUrl(v=""){
 const s=decodeShared(v);
 const m=s.match(/https?:\/\/[^\s]+/i);
 return m?m[0].replace(/[),.;]+$/,""):s.trim();
}
function ensurePendingListing(url){
 if(!url)return;
 const idx=state.items.findIndex(x=>x.url===url);
 const pending={
   id:url,
   url,
   source:source(url),
   title:"Reviewing Marketplace listing…",
   text:"",
   capturedAt:new Date().toISOString(),
   firstSeen:new Date().toISOString(),
   lastSeen:new Date().toISOString(),
   price:null,km:null,year:null,score:45,tier:"WATCH",
   safetyConfirmed:false,reliability:"Unknown",
   reasons:["Analyzing listing"],
   analysisStatus:"pending",
   draft:true
 };
 if(idx>=0) state.items[idx]={...state.items[idx],analysisStatus:"pending",lastSeen:new Date().toISOString()};
 else state.items.unshift(pending);
 persist();render();
}
function persist(){localStorage.setItem("carStealItems",JSON.stringify(state.items))}
function buildText(){
 const v=$("#vehicle").value.trim(),p=$("#priceInput").value.trim(),k=$("#kmInput").value.trim(),y=$("#yearInput").value.trim(),notes=$("#text").value.trim();
 const safe=$("#safetyInput").checked?" safety certified safetied":"";
 return [v,y,p,k?(k+" km"):"",safe,notes].filter(Boolean).join(" ");
}
function saveListing(url,text){
 const scored=CarScore.score({id:state.editingId||url||crypto.randomUUID(),url,source:source(url),title:$("#vehicle").value.trim()||text.split("\n").find(x=>x.trim())||"Vehicle listing",text,capturedAt:new Date().toISOString()});
 const idx=state.items.findIndex(x=>x.id===state.editingId||(url&&x.url===url));
 if(idx>=0)state.items[idx]={...state.items[idx],...scored,lastSeen:new Date().toISOString(),draft:false,analysisStatus:"complete"};
 else state.items.unshift({...scored,firstSeen:new Date().toISOString(),lastSeen:new Date().toISOString()});
 state.editingId=null;persist();render();return scored;
}
function filters(){return{maxPrice:Number($("#maxPrice").value),maxKm:Number($("#maxKm").value),safety:$("#safetyOnly").checked}}
function isPriority(x){return/toyota|honda|pontiac\s+vibe|scion/i.test((x.title||"")+" "+(x.text||""))}
function needsDetails(x){return x.price==null||x.km==null||x.year==null||x.title==="Vehicle listing"}
function facebookAppUrl(url){return"fb://facewebmodal/f?href="+encodeURIComponent(url)}
function applyMetadata(m={}){
 const vehicle=[m.year,m.make,m.model,m.trim].filter(Boolean).join(" ").trim();
 if(vehicle) $("#vehicle").value=vehicle;
 if(m.price!=null) $("#priceInput").value=m.price;
 if(m.km!=null) $("#kmInput").value=m.km;
 if(m.year!=null) $("#yearInput").value=m.year;
 $("#safetyInput").checked=m.safety_status==="certified";
 const notes=[
   m.description_summary,
   ...(Array.isArray(m.maintenance_signals)?m.maintenance_signals.map(x=>"Maintenance: "+x):[]),
   ...(Array.isArray(m.warning_flags)?m.warning_flags.map(x=>"Warning: "+x):[]),
   m.seller_notes
 ].filter(Boolean).join("\n");
 if(notes) $("#text").value=notes;
}
async function analyzeUrl(url){
 if(!ANALYZER_URL||!url||source(url)!=="Facebook Marketplace") return false;
 const note=$("#missingNote");
 const save=$("#saveBtn");
 note.classList.remove("hidden");
 note.textContent="🤖 AI reviewing Facebook Marketplace post…";
 save.disabled=true;
 save.textContent="Reviewing…";
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),40000);
 try{
   const r=await fetch(ANALYZER_URL+"/analyze",{
     method:"POST",
     headers:{"content-type":"application/json"},
     body:JSON.stringify({url}),
     signal:controller.signal
   });
   const data=await r.json().catch(()=>({}));
   if(!r.ok){
     const code=data.code||("HTTP_"+r.status);
     const stage=data.stage?(" • "+data.stage):"";
     throw new Error((data.error||"Analyzer unavailable.")+" ["+code+stage+"]");
   }
   applyMetadata(data.metadata||{});
   const c=data.metadata?.confidence;
   const m=data.metadata||{};
   const found=[m.price!=null&&"price",m.km!=null&&"km",m.year!=null&&"year",m.make&&"vehicle",m.description_summary&&"description"].filter(Boolean);
   if(found.length){
     note.textContent="✓ AI review complete"+(typeof c==="number"?" • "+Math.round(c*100)+"% confidence":"")+" • found "+found.join(", ")+". Verify the populated details, then tap Add to WheelBeast.";
   }else{
     note.textContent="⚠ AI opened the post but could not extract vehicle details. Verify the link or enter the missing details manually before adding.";
   }
   save.disabled=false;
   save.textContent="Add to WheelBeast";
   return true;
 }catch(e){
   if(e.name==="AbortError") note.textContent="⚠ AI review timed out after 40 seconds. You can retry the share or enter the details manually.";
   else note.textContent="⚠ AI review failed: "+e.message;
   save.disabled=false;
   save.textContent="Add to WheelBeast";
   return false;
 }finally{
   clearTimeout(timer);
 }
}
async async function reviewSharedUrl(url){
 if(!ANALYZER_URL||!url||source(url)!=="Facebook Marketplace"){
   openAdd(url,"",false);
   return;
 }

 // Give immediate visible feedback at the top of the app so the user knows
 // the Share Sheet handoff worked before the backend/browser analysis finishes.
 openAdd(url,"",false);
 $("#modalTitle").textContent="Reviewing Facebook listing";
 $("#missingNote").classList.remove("hidden");
 $("#missingNote").textContent="🤖 AI reviewing Facebook Marketplace post…";
 $("#saveBtn").disabled=true;
 $("#saveBtn").textContent="Reviewing…";

 ensurePendingListing(url);
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),40000);
 try{
   const r=await fetch(ANALYZER_URL+"/analyze",{
     method:"POST",
     headers:{"content-type":"application/json"},
     body:JSON.stringify({url}),
     signal:controller.signal
   });
   const data=await r.json().catch(()=>({}));
   if(!r.ok) throw new Error(data.error||("Analyzer unavailable ("+r.status+")"));

   const m=data.metadata||{};
   const idx=state.items.findIndex(x=>x.url===url);
   if(idx>=0){
     const vehicle=[m.year,m.make,m.model,m.trim].filter(Boolean).join(" ").trim();
     state.items[idx]={
       ...state.items[idx],
       title:vehicle||state.items[idx].title,
       price:m.price??null,
       km:m.km??null,
       year:m.year??null,
       analysisStatus:"review-ready",
       reasons:["AI review ready — verify before adding"]
     };
     persist();render();
   }

   openAdd(url,"",false);
   $("#modalTitle").textContent="Verify AI review";
   applyMetadata(m);
   $("#missingNote").classList.remove("hidden");
   const found=[m.price!=null&&"price",m.km!=null&&"km",m.year!=null&&"year",m.make&&"vehicle",m.description_summary&&"description"].filter(Boolean);
   $("#missingNote").textContent=found.length
     ?"✓ AI review complete • found "+found.join(", ")+". Verify the populated details, then tap Add to WheelBeast."
     :"⚠ AI opened the listing but could not extract vehicle details. Verify or fill in the missing fields.";
   $("#saveBtn").disabled=false;
   $("#saveBtn").textContent="Add to WheelBeast";
 }catch(e){
   const msg=e.name==="AbortError"?"AI review timed out after 40 seconds.":(e.message||"AI review failed.");
   const idx=state.items.findIndex(x=>x.url===url);
   if(idx>=0){
     state.items[idx].analysisStatus="failed";
     state.items[idx].analysisError=msg;
     persist();render();
   }
   $("#modalTitle").textContent="Facebook review failed";
   $("#missingNote").classList.remove("hidden");
   $("#missingNote").textContent="⚠ "+msg;
   $("#saveBtn").disabled=false;
   $("#saveBtn").textContent="Add to WheelBeast";
 }finally{
   clearTimeout(timer);
 }
}
function render(){
 const f=filters();
 let xs=state.items.filter(x=>(x.price==null||x.price<=f.maxPrice)&&(x.km==null||x.km<=f.maxKm)&&(!f.safety||x.safetyConfirmed));
 if(state.view==="steals")xs=xs.filter(x=>x.score>=85);
 if(state.view==="priority")xs=xs.filter(isPriority);
 const sort=$("#sort").value;
 if(sort==="score")xs.sort((a,b)=>b.score-a.score||(a.price||Infinity)-(b.price||Infinity));
 if(sort==="newest")xs.sort((a,b)=>new Date(b.lastSeen)-new Date(a.lastSeen));
 if(sort==="price")xs.sort((a,b)=>(a.price||Infinity)-(b.price||Infinity));
 if(sort==="km")xs.sort((a,b)=>(a.km||Infinity)-(b.km||Infinity));
 $("#steals").textContent=state.items.filter(x=>x.score>=85).length;
 $("#matches").textContent=xs.length;
 $("#saved").textContent=state.items.filter(x=>!x.draft).length;
 if(!xs.length){$("#feed").innerHTML='<div class="empty"><b>No matching cars yet.</b><br><br>Shared cars with missing details will stay visible so you can complete them.</div>';return}
 $("#feed").innerHTML=xs.map(x=>{
   const incomplete=needsDetails(x);
   const analysisBanner=x.analysisStatus==="pending"?'<div class="incomplete">🤖 AI reviewing Facebook Marketplace post…</div>':x.analysisStatus==="review-ready"?'<div class="incomplete">✓ AI review ready — verify details before adding.</div>':x.analysisStatus==="failed"?'<div class="incomplete">⚠ AI review failed — try sharing again or edit manually.</div>':"";
   let openButton="";
   if(x.url&&x.source==="Facebook Marketplace")openButton='<a href="'+esc(facebookAppUrl(x.url))+'" class="openFb" rel="noopener noreferrer" data-user-open="facebook">Open in Facebook</a>';
   else if(x.url)openButton='<a href="'+esc(x.url)+'" target="_blank" rel="noopener">Open listing</a>';
   return '<div class="card"><div class="top"><div class="title">'+esc(x.title)+'</div><div class="badge '+esc((x.tier||"").toLowerCase())+'">'+esc(x.tier)+' '+x.score+'/100</div></div><div class="price">'+fmt(x.price)+'</div><div class="meta">'+(x.year||"Year ?")+' • '+(x.km?x.km.toLocaleString()+" km":"km ?")+' • '+(x.safetyConfirmed?"✓ safety":"safety ?")+'</div>'+analysisBanner+(incomplete&&x.analysisStatus!=="pending"?'<div class="incomplete">⚠ Missing details — complete this car for an accurate score.</div>':'')+'<div class="reason">'+esc((x.reasons||[]).slice(0,5).join(" · "))+'</div><div class="url">'+esc(x.source||"")+(x.url?" • "+esc(x.url):"")+'</div><div class="cardActions"><button class="editBtn" data-edit="'+esc(x.id)+'">Edit details</button>'+openButton+'<button class="removeBtn" data-remove="'+esc(x.id)+'">Remove</button></div></div>';
 }).join("");
 document.querySelectorAll("[data-edit]").forEach(b=>b.onclick=e=>{e.preventDefault();e.stopPropagation();editListing(b.dataset.edit)});
 document.querySelectorAll("[data-remove]").forEach(b=>b.onclick=e=>{e.preventDefault();e.stopPropagation();removeListing(b.dataset.remove)});
 document.querySelectorAll("[data-user-open='facebook']").forEach(a=>a.onclick=e=>e.stopPropagation());
}
function removeListing(id){
 const x=state.items.find(i=>i.id===id);
 if(!x) return;
 const label=x.title||x.url||"this listing";
 if(!confirm("Remove "+label+" from WheelBeast?")) return;
 state.items=state.items.filter(i=>i.id!==id);
 persist();
 render();
}
function openAdd(u="",t="",autoAnalyze=false){
 state.editingId=null;
 $("#modalTitle").textContent=autoAnalyze?"Review Facebook listing":"Add a listing";
 $("#saveBtn").disabled=false;
 $("#saveBtn").textContent="Add to WheelBeast";
 $("#url").value=u;$("#vehicle").value="";$("#priceInput").value="";$("#kmInput").value="";$("#yearInput").value="";$("#safetyInput").checked=false;$("#text").value=t;
 $("#missingNote").classList.toggle("hidden",!!t);
 $("#missingNote").textContent=t?"":"Shared links often contain only the URL. Add the vehicle, price and km for an accurate score.";
 $("#modal").classList.remove("hidden");
 if(autoAnalyze&&u){analyzeUrl(u);}
 else setTimeout(()=>$("#vehicle").focus(),100);
}
function editListing(id){
 const x=state.items.find(i=>i.id===id);if(!x)return;state.editingId=id;
 $("#modalTitle").textContent="Complete listing";
 $("#url").value=x.url||"";$("#vehicle").value=x.title==="Vehicle listing"?"":x.title||"";$("#priceInput").value=x.price??"";$("#kmInput").value=x.km??"";$("#yearInput").value=x.year??"";$("#safetyInput").checked=!!x.safetyConfirmed;$("#text").value=x.text||"";
 $("#missingNote").classList.toggle("hidden",!needsDetails(x));$("#missingNote").textContent="Fill in the missing details to recalculate this score.";
 $("#modal").classList.remove("hidden");
}
$("#addBtn").onclick=()=>openAdd();
$("#closeBtn").onclick=()=>{$("#modal").classList.add("hidden");state.editingId=null};
$("#saveBtn").onclick=()=>{
 const u=$("#url").value.trim(),t=buildText();
 if(!u&&!t)return;
 saveListing(u,t||u);
 $("#modal").classList.add("hidden");
};
$("#pasteBtn").onclick=async()=>{try{const t=await navigator.clipboard.readText();const url=(t.match(/https?:\/\/\S+/)||[])[0]||"";openAdd(url,t,!!url)}catch{openAdd()}};
$("#helpBtn").onclick=()=>$("#help").classList.remove("hidden");
$("#helpClose").onclick=$("#helpDone").onclick=()=>$("#help").classList.add("hidden");
["maxPrice","maxKm","safetyOnly","sort"].forEach(id=>$("#"+id).addEventListener("change",render));
document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>{document.querySelectorAll("nav button").forEach(x=>x.classList.remove("active"));b.classList.add("active");state.view=b.dataset.view;render()});
function handleShareHandoff(){
 const q=new URLSearchParams(location.search);
 const hashMatch=location.hash.match(/^#share64=(.+)$/);

 // Read share64 from the raw query string first. This preserves "+" characters
 // and lets us recover %0A/%0D line breaks that Apple Shortcuts may insert.
 const rawMatch=location.search.match(/[?&]share64=([^&]*)/);
 let share64=(rawMatch&&rawMatch[1])||(hashMatch&&hashMatch[1])||"";
 if(share64){
   try{share64=decodeURIComponent(share64)}catch{}
 }
 if(!q.has("share")&&!share64) return false;

 const shared=share64?decodeShare64(share64):decodeShared(q.get("share")||"");
 const url=extractSharedUrl(shared);

 // Strip the handoff payload immediately. The Facebook URL is data only and is never opened locally.
 history.replaceState({},"",location.pathname);

 if(url){
   reviewSharedUrl(url);
 } else {
   openAdd("","",false);
   $("#missingNote").classList.remove("hidden");
   $("#missingNote").textContent=share64
     ?"⚠ WheelBeast received the Shortcut payload but could not decode a Facebook Marketplace URL."
     :"⚠ No Marketplace URL reached WheelBeast from the Shortcut.";
 }
 return true;
}

// Query-string share64 is preferred because iOS reliably performs a fresh navigation.
// Hash share64 remains supported for older shortcuts.
handleShareHandoff();
window.addEventListener("hashchange",()=>handleShareHandoff());
window.addEventListener("pageshow",()=>handleShareHandoff());
window.wheelBeastStatus=async()=>{if(!ANALYZER_URL)return{ok:false,error:"Analyzer URL not configured"};const r=await fetch(ANALYZER_URL+"/status");return r.json()};
if("serviceWorker"in navigator){
 navigator.serviceWorker.register("./sw.js",{updateViaCache:"none"}).then(reg=>{
   reg.update().catch(()=>{});
   if(reg.waiting)reg.waiting.postMessage({type:"SKIP_WAITING"});
   reg.addEventListener("updatefound",()=>{
     const next=reg.installing;
     if(!next)return;
     next.addEventListener("statechange",()=>{
       if(next.state==="installed"&&navigator.serviceWorker.controller){
         next.postMessage({type:"SKIP_WAITING"});
       }
     });
   });
 }).catch(()=>{});
}
render();