const $=s=>document.querySelector(s);
const state={items:JSON.parse(localStorage.getItem("carStealItems")||"[]"),view:"all",editingId:null};
const ANALYZER_URL=(window.WHEELBEAST_ANALYZER_URL||"").replace(/\/$/,"");
const fmt=n=>n==null?"Price ?":new Intl.NumberFormat("en-CA",{style:"currency",currency:"CAD",maximumFractionDigits:0}).format(n);
const esc=s=>String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
function source(url=""){try{const h=new URL(url).hostname;if(h.includes("facebook"))return"Facebook Marketplace";if(h.includes("kijiji"))return"Kijiji";if(h.includes("autotrader"))return"AutoTrader";return h}catch{return"Manual"}}
function persist(){localStorage.setItem("carStealItems",JSON.stringify(state.items))}
function buildText(){
 const v=$("#vehicle").value.trim(),p=$("#priceInput").value.trim(),k=$("#kmInput").value.trim(),y=$("#yearInput").value.trim(),notes=$("#text").value.trim();
 const safe=$("#safetyInput").checked?" safety certified safetied":"";
 return [v,y,p,k?(k+" km"):"",safe,notes].filter(Boolean).join(" ");
}
function saveListing(url,text){
 const scored=CarScore.score({id:state.editingId||url||crypto.randomUUID(),url,source:source(url),title:$("#vehicle").value.trim()||text.split("\n").find(x=>x.trim())||"Vehicle listing",text,capturedAt:new Date().toISOString()});
 const idx=state.items.findIndex(x=>x.id===state.editingId||(url&&x.url===url));
 if(idx>=0)state.items[idx]={...state.items[idx],...scored,lastSeen:new Date().toISOString()};
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
 note.classList.remove("hidden");
 note.textContent="🤖 WheelBeast is opening the Marketplace listing…";
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
   const found=[data.metadata?.price!=null&&"price",data.metadata?.km!=null&&"km",data.metadata?.year!=null&&"year",data.metadata?.make&&"vehicle"].filter(Boolean);
   note.textContent="✓ Marketplace read complete"+(typeof c==="number"?" • "+Math.round(c*100)+"% confidence":"")+(found.length?" • found "+found.join(", "):" • no vehicle details detected")+". Review, then Score & Save.";
   return true;
 }catch(e){
   if(e.name==="AbortError") note.textContent="Automatic read timed out after 40 seconds. The Facebook browser session may be waiting on a login/challenge.";
   else note.textContent="Automatic read failed: "+e.message;
   return false;
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
 $("#saved").textContent=state.items.length;
 if(!xs.length){$("#feed").innerHTML='<div class="empty"><b>No matching cars yet.</b><br><br>Shared cars with missing details will stay visible so you can complete them.</div>';return}
 $("#feed").innerHTML=xs.map(x=>{
   const incomplete=needsDetails(x);
   let openButton="";
   if(x.url&&x.source==="Facebook Marketplace")openButton='<a href="'+esc(facebookAppUrl(x.url))+'" class="openFb">Open in Facebook</a>';
   else if(x.url)openButton='<a href="'+esc(x.url)+'" target="_blank" rel="noopener">Open listing</a>';
   return '<div class="card"><div class="top"><div class="title">'+esc(x.title)+'</div><div class="badge '+esc((x.tier||"").toLowerCase())+'">'+esc(x.tier)+' '+x.score+'/100</div></div><div class="price">'+fmt(x.price)+'</div><div class="meta">'+(x.year||"Year ?")+' • '+(x.km?x.km.toLocaleString()+" km":"km ?")+' • '+(x.safetyConfirmed?"✓ safety":"safety ?")+'</div>'+(incomplete?'<div class="incomplete">⚠ Missing details — complete this car for an accurate score.</div>':'')+'<div class="reason">'+esc((x.reasons||[]).slice(0,5).join(" · "))+'</div><div class="url">'+esc(x.source||"")+(x.url?" • "+esc(x.url):"")+'</div><div class="cardActions"><button class="editBtn" data-edit="'+esc(x.id)+'">Edit details</button>'+openButton+'</div></div>';
 }).join("");
 document.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>editListing(b.dataset.edit));
}
function openAdd(u="",t="",autoAnalyze=false){
 state.editingId=null;
 $("#modalTitle").textContent="Add a listing";
 $("#url").value=u;$("#vehicle").value="";$("#priceInput").value="";$("#kmInput").value="";$("#yearInput").value="";$("#safetyInput").checked=false;$("#text").value=t;
 $("#missingNote").classList.toggle("hidden",!!t);
 $("#missingNote").textContent=t?"":"Shared links often contain only the URL. Add the vehicle, price and km for an accurate score.";
 $("#modal").classList.remove("hidden");
 if(autoAnalyze&&u) analyzeUrl(u);
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
$("#saveBtn").onclick=()=>{const u=$("#url").value.trim(),t=buildText();if(!u&&!t)return;saveListing(u,t||u);$("#modal").classList.add("hidden")};
$("#pasteBtn").onclick=async()=>{try{const t=await navigator.clipboard.readText();const url=(t.match(/https?:\/\/\S+/)||[])[0]||"";openAdd(url,t,!!url)}catch{openAdd()}};
$("#helpBtn").onclick=()=>$("#help").classList.remove("hidden");
$("#helpClose").onclick=$("#helpDone").onclick=()=>$("#help").classList.add("hidden");
["maxPrice","maxKm","safetyOnly","sort"].forEach(id=>$("#"+id).addEventListener("change",render));
document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>{document.querySelectorAll("nav button").forEach(x=>x.classList.remove("active"));b.classList.add("active");state.view=b.dataset.view;render()});
const q=new URLSearchParams(location.search);
if(q.get("share")){const shared=q.get("share");const url=(shared.match(/https?:\/\/\S+/)||[])[0]||shared;openAdd(url,shared===url?"":shared,true);history.replaceState({},"",location.pathname)}
window.wheelBeastStatus=async()=>{if(!ANALYZER_URL)return{ok:false,error:"Analyzer URL not configured"};const r=await fetch(ANALYZER_URL+"/status");return r.json()};
if("serviceWorker"in navigator)navigator.serviceWorker.register("./sw.js");
render();