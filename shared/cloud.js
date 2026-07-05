/* =========================================================================
   SchoolCloud – geteilter Spielstand-Speicher fuer das Zweitklass-Lernportal
   -------------------------------------------------------------------------
   • EIN Familien-Code + EIN Firebase-Projekt fuer ALLE Faecher/Themen.
   • Pro Thema ein eigener Fortschritt (Sterne, erledigt, offener Punkt).
   • Lokale Kopie in localStorage (Offline-Cache) + optionale Cloud-Sync.

   Einbinden (in jeder Portal-/Themenseite):
     <script src=".../shared/config.js"></script>
     <script src=".../shared/cloud.js"></script>

   Nutzung in einer Themenseite:
     const Store = SchoolCloud.store("uhrzeit");   // gleiche API wie frueher
     SchoolCloud.bootSync(renderHome);             // laedt + synct, dann anzeigen
   ========================================================================= */
window.SchoolCloud = (function(){
  const SAVE_KEY="school2ndyear_v1";
  const CODE_KEY="school2ndyear_code";
  const OLD_UHRZEIT_KEY="zeitabenteuer_uhrzeit_v1";   // Migration aus der frueheren Einzel-App

  let data={topics:{},stats:{},_t:0};
  let code="";

  /* ---- Firebase / Firestore-REST ---------------------------------------- */
  const PID=()=>window.FIREBASE_PROJECT_ID, KEY=()=>window.FIREBASE_API_KEY;
  const ready=()=> !!PID() && !!KEY() && PID()!=="DEIN_PROJECT_ID" && KEY()!=="DEIN_API_KEY";
  const docUrl=c=>`https://firestore.googleapis.com/v1/projects/${PID()}/databases/(default)/documents/progress/${encodeURIComponent(c)}?key=${KEY()}`;
  async function pull(c){
    if(!ready()||!c) return null;
    const r=await fetch(docUrl(c));
    if(r.status===404) return null;                  // diesen Code gibt es noch nicht
    if(!r.ok) throw new Error("pull "+r.status);
    const j=await r.json();
    const s=j.fields&&j.fields.data&&j.fields.data.stringValue;
    return s?JSON.parse(s):null;
  }
  async function push(c,obj){
    if(!ready()||!c) return;
    const body={fields:{data:{stringValue:JSON.stringify(obj)}}};   // ganzer Spielstand als ein JSON-Feld
    const r=await fetch(docUrl(c),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    if(!r.ok) throw new Error("push "+r.status);
  }
  let pushT=null;
  function schedulePush(){
    if(!ready()||!code) return;
    clearTimeout(pushT);
    pushT=setTimeout(()=>{ push(code,data).catch(()=>{}); },700);   // gebuendelt, verzoegert
  }

  /* ---- lokale Persistenz -------------------------------------------------- */
  function loadLocal(){
    try{const d=JSON.parse(localStorage.getItem(SAVE_KEY)); if(d&&d.topics) data=d;}catch(e){}
    try{code=localStorage.getItem(CODE_KEY)||"";}catch(e){}
    // einmalige Migration: alten Einzel-App-Stand als Thema "uhrzeit" uebernehmen
    if(!data.topics.uhrzeit){
      try{const old=JSON.parse(localStorage.getItem(OLD_UHRZEIT_KEY));
        if(old&&(old.stars||old.done)){
          data.topics.uhrzeit={stars:old.stars||{},done:old.done||{},progress:old.progress||null,_t:old._t||Date.now()};
        }
      }catch(e){}
    }
  }
  function saveLocal(){ data._t=Date.now(); try{localStorage.setItem(SAVE_KEY,JSON.stringify(data));}catch(e){} }
  function persist(){ saveLocal(); schedulePush(); }

  /* ---- Zusammenfuehren: Sterne gehen NIE verloren (Maximum je Station),
     "erledigt" wird verodert, offener Punkt kommt vom zuletzt aktiven Geraet. */
  function mergeTopic(a,b){
    if(!a) return b; if(!b) return a;
    const out={stars:{},done:{},progress:null,_t:Math.max(a._t||0,b._t||0)};
    new Set([...Object.keys(a.stars||{}),...Object.keys(b.stars||{})]).forEach(id=>{
      const v=Math.max((a.stars||{})[id]||0,(b.stars||{})[id]||0); if(v) out.stars[id]=v; });
    new Set([...Object.keys(a.done||{}),...Object.keys(b.done||{})]).forEach(id=>{
      if((a.done||{})[id]||(b.done||{})[id]) out.done[id]=true; });
    out.progress=(a._t||0)>=(b._t||0)?a.progress:b.progress;
    return out;
  }
  function mergeStats(a,b){          // Zaehler je Frage: Maximum nehmen (idempotent, kein Doppelzaehlen)
    a=a||{}; b=b||{}; const out={};
    new Set([...Object.keys(a),...Object.keys(b)]).forEach(t=>{
      const at=a[t]||{}, bt=b[t]||{}; out[t]={};
      new Set([...Object.keys(at),...Object.keys(bt)]).forEach(k=>{
        const ae=at[k]||{}, be=bt[k]||{};
        out[t][k]={
          station: ae.station||be.station||"",
          label:   ae.label||be.label||"",
          seen:  Math.max(ae.seen||0, be.seen||0),
          wrong: Math.max(ae.wrong||0, be.wrong||0),
          lastAt:Math.max(ae.lastAt||0, be.lastAt||0)
        };
      });
    });
    return out;
  }
  function mergeData(a,b){
    if(!b) return a; if(!a) return b;
    const out={topics:{},stats:{},_t:Math.max(a._t||0,b._t||0)};
    new Set([...Object.keys(a.topics||{}),...Object.keys(b.topics||{})]).forEach(id=>{
      out.topics[id]=mergeTopic((a.topics||{})[id],(b.topics||{})[id]); });
    out.stats=mergeStats(a.stats,b.stats);
    return out;
  }

  /* ---- Fehler-Statistik (fuer den Elternbericht) ------------------------- */
  function stripTags(s){ return String(s||"").replace(/<[^>]+>/g," ").replace(/&[a-z]+;/gi," ").replace(/\s+/g," ").replace(/\s+([?!.,:;])/g,"$1").trim(); }
  function statNode(topic,stationId,exi){
    if(!data.stats) data.stats={};
    if(!data.stats[topic]) data.stats[topic]={};
    const key=stationId+"#"+exi;
    if(!data.stats[topic][key]) data.stats[topic][key]={station:"",label:"",seen:0,wrong:0,lastAt:0};
    return data.stats[topic][key];
  }

  /* ---- Thema-Objekt: gleiche Schnittstelle wie der alte Store ------------- */
  function slice(id){ if(!data.topics[id]) data.topics[id]={stars:{},done:{},progress:null,_t:0}; return data.topics[id]; }
  function store(id){
    return {
      get data(){ return slice(id); },                               // { stars, done, progress }
      stars(sid){ return slice(id).stars[sid]||0; },
      setStars(sid,n){ const c=slice(id); if(n>(c.stars[sid]||0)) c.stars[sid]=n; c.done[sid]=true; c._t=Date.now(); persist(); },
      total(){ return Object.values(slice(id).stars).reduce((a,b)=>a+b,0); },
      saveProgress(p){ const c=slice(id); c.progress=p; c._t=Date.now(); persist(); },
      clearProgress(){ const c=slice(id); if(c.progress){ c.progress=null; c._t=Date.now(); persist(); } },
      getProgress(){ return slice(id).progress; },
      reset(){ data.topics[id]={stars:{},done:{},progress:null,_t:Date.now()}; persist(); },
      // Fehler-Protokoll fuer den Elternbericht:
      recordSeen(stationId,exi,label,stationName){ const n=statNode(id,stationId,exi); if(stationName)n.station=stationName; n.label=stripTags(label); n.seen=(n.seen||0)+1; persist(); },
      recordWrong(stationId,exi,label,stationName){ const n=statNode(id,stationId,exi); if(stationName)n.station=stationName; n.label=stripTags(label); n.wrong=(n.wrong||0)+1; n.lastAt=Date.now(); persist(); }
    };
  }

  /* ---- Uebersicht fuers Portal ------------------------------------------- */
  function topicTotal(id){ const t=data.topics[id]; return t?Object.values(t.stars).reduce((a,b)=>a+b,0):0; }
  function grandTotal(){ return Object.keys(data.topics).reduce((s,id)=>s+topicTotal(id),0); }
  function resetAll(){ data={topics:{},stats:{},_t:Date.now()}; persist(); }
  function getStats(){ return data.stats||{}; }
  function resetStats(){ data.stats={}; persist(); }

  /* ---- kleiner Toast (nutzt #toast der Seite, sonst still) --------------- */
  let tT=null;
  function toast(msg){ const t=document.getElementById("toast"); if(!t) return;
    t.textContent=msg; t.classList.add("show"); clearTimeout(tT); tT=setTimeout(()=>t.classList.remove("show"),1800); }

  function setCode(c){ code=(c||"").trim(); try{localStorage.setItem(CODE_KEY,code);}catch(e){} }

  /* ---- Familien-Code-Bildschirm (dependency-frei, nutzt die geteilte CSS) - */
  function showCodeScreen(firstRun,onDone){
    const host=document.getElementById("screen"); if(!host) return;
    const wrap=document.createElement("div"); wrap.className="screen";
    wrap.innerHTML =
      '<h1 class="hub-title">☁️ Familien-Code</h1>'+
      '<div class="card center">'+
        '<div class="mascot-row"><div class="bubble" style="flex:1">'+
          (firstRun
            ? 'Damit dein Fortschritt auf <b>jedem Gerät</b> gleich ist, brauchst du einen <b>Familien-Code</b>. Denk dir einen aus – oder lass mich einen erstellen!'
            : 'Gib auf allen Geräten <b>denselben Code</b> ein – dann geht es überall dort weiter, wo du aufgehört hast.')+
        '</div></div>'+
        '<div class="muted" style="margin:10px 0 6px">Dein Familien-Code:</div>'+
        '<input id="sc_code" type="text" maxlength="40" autocomplete="off" autocapitalize="none" spellcheck="false" '+
               'placeholder="z. B. familie-mueller-7" '+
               'style="font:inherit;font-size:1.3rem;text-align:center;padding:10px 14px;border-radius:14px;border:3px solid var(--sky-1);width:min(320px,90%)">'+
        '<div style="margin-top:12px"><button id="sc_gen" class="btn blue">🎲 Code erstellen</button></div>'+
        '<div class="muted" style="margin-top:10px;font-size:.95rem">Merke dir den Code und gib ihn auf dem nächsten Gerät genauso ein.</div>'+
        '<div style="margin-top:14px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">'+
          '<button id="sc_ok" class="btn green lg">Weiter →</button>'+
          (firstRun?'':'<button id="sc_cancel" class="btn gray">Abbrechen</button>')+
        '</div>'+
      '</div>';
    host.innerHTML=""; host.append(wrap); window.scrollTo(0,0);
    const inp=wrap.querySelector("#sc_code"); inp.value=code||"";
    const animals=["igel","hase","fuchs","biber","otter","dachs","reh","luchs"];
    wrap.querySelector("#sc_gen").onclick=()=>{
      inp.value="tikki-"+(1000+Math.floor(Math.random()*9000))+"-"+animals[Math.floor(Math.random()*animals.length)];
    };
    wrap.querySelector("#sc_ok").onclick=async()=>{
      const c=(inp.value||"").trim();
      if(c.length<4){ toast("Bitte mindestens 4 Zeichen"); return; }
      setCode(c);
      try{ const remote=await pull(c); if(remote){ data=mergeData(data,remote); } }
      catch(e){ toast("Offline – nur lokaler Stand"); }
      persist();
      if(onDone) onDone();
    };
    const cancel=wrap.querySelector("#sc_cancel");
    if(cancel) cancel.onclick=()=>{ if(onDone) onDone(); };
  }

  /* ---- Boot: lokal laden, Cloud holen/mergen, ggf. Code abfragen --------- */
  async function bootSync(home){
    loadLocal();
    if(ready() && code){
      try{ const remote=await pull(code); if(remote){ data=mergeData(data,remote); persist(); } }
      catch(e){ toast("Offline – lokaler Spielstand wird genutzt"); }
    }
    if(ready() && !code){ showCodeScreen(true, home); return; }
    if(home) home();
  }

  return {
    ready, code:()=>code, setCode,
    store, topicTotal, grandTotal, resetAll,
    getStats, resetStats,
    mergeData, bootSync, showCodeScreen, toast
  };
})();
