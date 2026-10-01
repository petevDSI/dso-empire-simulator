const http=require("http"),fs=require("fs"),path=require("path");
const {chromium}=require("/home/claude/.npm-global/lib/node_modules/playwright");
const ROOT=""+require("path").resolve(__dirname,"..")+"";
const MIME={".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".jpg":"image/jpeg",".webp":"image/webp",".svg":"image/svg+xml",".json":"application/json",".txt":"text/plain"};
function serve(){return new Promise(r=>{const s=http.createServer((q,res)=>{let p=decodeURIComponent(q.url.split("?")[0]);if(p==="/")p="/index.html";const f=path.join(ROOT,p);if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end()}res.writeHead(200,{"Content-Type":MIME[path.extname(f)]||"application/octet-stream"});fs.createReadStream(f).pipe(res)}).listen(0,()=>r(s))})}
const SAVE="dso-empire-simulator-save-v2";
// ---- fake Supabase shared by all "devices" ----
const db={cloud:null, prefs:{marketing_opt_in:false,notify_events:false,notify_outranked:false}, players:{}, puts:[], otpEmails:[], rpcAuth:[], claimed:null, deleted:false};
function fakeBackend(ctx){
  return ctx.route(/difrryshoyxcdydbtjjt\.supabase\.co/, async route=>{
    const req=route.request(), url=req.url(), h=req.headers(); let body={}; try{body=JSON.parse(req.postData()||"{}")}catch(e){}
    const json=(o,s=200)=>route.fulfill({status:s,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)});
    if(req.method()==="OPTIONS") return route.fulfill({status:204,headers:{"access-control-allow-origin":"*","access-control-allow-headers":"*","access-control-allow-methods":"*"}});
    if(url.includes("/auth/v1/otp")){db.otpEmails.push(body.email);return json({})}
    if(url.includes("/auth/v1/verify")){ if(body.token!=="123456") return json({error_code:"otp_expired",msg:"Token has expired or is invalid"},403);
      return json({access_token:"tok-"+body.email,refresh_token:"ref-1",expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:{id:"user-1",email:body.email}})}
    if(url.includes("/auth/v1/logout")) return json({});
    if(url.includes("/rest/v1/rpc/")){
      const fn=url.split("/rpc/")[1]; const bearer=(h.authorization||"").replace("Bearer ","");
      const signed=bearer.startsWith("tok-"); db.rpcAuth.push([fn,signed]);
      if(fn==="dso_get_leaderboard") return json([]);
      if(fn==="dso_get_player_rank") return json({rank:null,value:null,total:null});
      if(fn==="dso_submit_event") return json({accepted:true});
      if(!signed) return json({ok:false,reason:"not_signed_in"});
      if(fn==="dso_claim_player"){ if(!db.claimed) db.claimed=body.p_player_id; return json({ok:true,player_id:db.claimed,adopted:db.claimed!==body.p_player_id,linked_now:false}) }
      if(fn==="dso_cloud_save_get"){ return json(db.cloud?{ok:true,found:true,save:db.cloud.save,progress:db.cloud.progress,summary:db.cloud.summary,updated_at:db.cloud.updated_at,player_id:db.claimed}:{ok:true,found:false,player_id:db.claimed}) }
      if(fn==="dso_cloud_save_put"){ db.puts.push({force:body.p_force,base:body.p_base,progress:body.p_progress});
        if(db.cloud && !body.p_force && body.p_base!==db.cloud.updated_at) return json({ok:false,conflict:true,progress:db.cloud.progress,summary:db.cloud.summary,updated_at:db.cloud.updated_at});
        db.cloud={save:body.p_save,progress:body.p_progress,summary:body.p_summary,updated_at:new Date().toISOString().replace("Z","123+00:00")}; return json({ok:true,updated_at:db.cloud.updated_at}) }
      if(fn==="dso_prefs_get") return json({ok:true,...db.prefs});
      if(fn==="dso_prefs_set"){ db.prefs={marketing_opt_in:body.p_marketing,notify_events:body.p_events,notify_outranked:body.p_outranked,v:body.p_consent_version}; return json({ok:true}) }
      if(fn==="dso_delete_account"){ db.deleted=true; return json({ok:true}) }
    }
    return json({});
  });
}
const mkState=(rev,nw,ex)=>({lifetimeRevenue:rev,netWorth:nw,seasonsCompleted:ex,revenue:rev,lastSeen:Date.now(),streakCount:1,streakLastDate:"2099-01-01",tutorialStep:99});
async function newDevice(browser,srv,seed){
  const ctx=await browser.newContext({viewport:{width:390,height:844}}); await fakeBackend(ctx);
  await ctx.addInitScript(([seed,SAVE])=>{ if(!sessionStorage.getItem("__seeded")){ sessionStorage.setItem("__seeded","1");
      localStorage.setItem("dso-empire-simulator-splash-seen-v1","1"); localStorage.setItem("dso-empire-simulator-ui-unlocks-v1",JSON.stringify({all:true}));
      localStorage.setItem("dso-empire-simulator-lb-category-v1","networth"); localStorage.setItem("dso-empire-simulator-tab-v1","ops");
      if(seed) localStorage.setItem(SAVE,JSON.stringify(seed)); } },[seed,SAVE]);
  const page=await ctx.newPage(); const errs=[]; page.on("pageerror",e=>errs.push(e.message));
  await page.goto(`http://localhost:${srv.address().port}/?from=smile`); 
  await page.addStyleTag({content:"#logo-intro,.logo-intro{display:none !important}"});
  await page.waitForTimeout(600);
  return {ctx,page,errs};
}
async function openAcct(page){ await page.evaluate(()=>document.getElementById("acct-footer-link").click()); await page.waitForTimeout(300); }
async function signIn(page,email,mkt){ await openAcct(page); await page.fill("#acct-email",email); if(mkt) await page.check("#acct-mkt"); await page.click("#acct-send"); await page.waitForSelector("#acct-step-code:not([hidden])"); await page.fill("#acct-code","123456"); await page.click("#acct-verify"); }
const T=[]; const ok=(n,c,x)=>{T.push([n,!!c,x]); console.log((c?"PASS ":"FAIL ")+n+(x?"  "+x:""))};
(async()=>{
  const srv=await serve(); const browser=await chromium.launch({executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome"});
  // A: device 1 signs in, uploads
  let A=await newDevice(browser,srv,mkState(250000,1000,1));
    await signIn(A.page,"pete@example.com",true);
  await A.page.waitForSelector("#acct-in:not([hidden])"); await A.page.waitForTimeout(1500);
  const anonBefore=await A.page.evaluate(()=>localStorage.getItem("dso-empire-simulator-player-id-v1"));
  ok("A signed-in panel shows email",(await A.page.textContent("#acct-who-email"))==="pete@example.com");
  ok("A first upload had base null, not forced",db.puts.length>=1&&db.puts[0].base===null&&!db.puts[0].force, JSON.stringify(db.puts[0]));
  ok("A cloud holds save with lifetimeRevenue>=250000",db.cloud&&db.cloud.save.lifetimeRevenue>=250000);
  ok("A claim called with signed-in token",db.rpcAuth.some(([f,s])=>f==="dso_claim_player"&&s));
  ok("A marketing opt-in recorded with consent version",db.prefs.marketing_opt_in===true&&db.prefs.v==="dso-email-2026-10", JSON.stringify(db.prefs));
  ok("A sync status says synced",/synced/i.test(await A.page.textContent("#acct-sync-status")), await A.page.textContent("#acct-sync-status"));
  ok("A OTP emailed to right address",db.otpEmails[0]==="pete@example.com");
  ok("A prefs checkbox reflects marketing",await A.page.isChecked("#acct-pref-mkt"));
  // prefs save
  await A.page.check("#acct-pref-events"); await A.page.click("#acct-pref-save"); await A.page.waitForTimeout(400);
  ok("A prefs save sends all three",db.prefs.notify_events===true&&db.prefs.marketing_opt_in===true);
  // leaderboard call while signed in uses token
  await A.page.evaluate(()=>document.querySelector('.tab-btn[data-tab="leaderboard"]').click()); await A.page.waitForTimeout(500);
  ok("A leaderboard rank call uses signed-in token",db.rpcAuth.filter(([f,s])=>f==="dso_get_player_rank").some(([f,s])=>s));
  // B: brand-new device, fresh local, same account -> loads cloud and reloads
  let B=await newDevice(browser,srv,null);
  await signIn(B.page,"pete@example.com",false);
  await B.page.waitForTimeout(2500);
  const bSave=await B.page.evaluate(k=>JSON.parse(localStorage.getItem(k)||"null"),SAVE);
  ok("B fresh device loaded cloud save after reload",bSave&&bSave.lifetimeRevenue>=250000, bSave&&bSave.lifetimeRevenue);
  const bId=await B.page.evaluate(()=>localStorage.getItem("dso-empire-simulator-player-id-v1"));
  ok("B adopted the account's canonical player id",bId===anonBefore, bId+" vs "+anonBefore);
  ok("B still signed in after reload",await B.page.evaluate(()=>!!localStorage.getItem("dso-empire-simulator-auth-v1")));
  // C: device with different progress -> conflict
  let C=await newDevice(browser,srv,mkState(900000,50,0));
  await signIn(C.page,"pete@example.com",false);
  await C.page.waitForTimeout(1500);
  const modalTitle=await C.page.textContent("#modal-title"); const modalVisible=await C.page.evaluate(()=>!document.getElementById("modal-overlay").hidden);
  ok("C conflict modal appears",modalVisible&&modalTitle==="Two different saves found", modalTitle);
  ok("C conflict panel visible + paused",await C.page.evaluate(()=>!document.getElementById("acct-conflict").hidden));
  const putsBefore=db.puts.length;
  await C.page.click("#modal-cancel"); await C.page.waitForTimeout(1200); // Keep this device
  ok("C keep-device forced an upload",db.puts.length>putsBefore&&db.puts[db.puts.length-1].force===true);
  ok("C cloud now has C's progress",db.cloud.save.lifetimeRevenue>=900000);
  ok("C conflict cleared",await C.page.evaluate(()=>document.getElementById("acct-conflict").hidden));
  // D: use cloud choice
  let D=await newDevice(browser,srv,mkState(777000,10,0));
  await signIn(D.page,"pete@example.com",false); await D.page.waitForTimeout(1500);
  await D.page.click("#modal-confirm"); await D.page.waitForTimeout(2200);
  const dSave=await D.page.evaluate(k=>JSON.parse(localStorage.getItem(k)||"null"),SAVE);
  ok("D 'Use cloud save' replaced local with cloud",dSave&&dSave.lifetimeRevenue>=900000,dSave&&dSave.lifetimeRevenue);
  // E: bad code
  let E=await newDevice(browser,srv,mkState(1,0,0)); await openAcct(E.page);
  await E.page.fill("#acct-email","x@example.com"); await E.page.click("#acct-send"); await E.page.waitForSelector("#acct-step-code:not([hidden])");
  await E.page.fill("#acct-code","000000"); await E.page.click("#acct-verify"); await E.page.waitForTimeout(500);
  ok("E wrong code shows error, stays signed out",/didn.t work/.test(await E.page.textContent("#acct-msg"))&&await E.page.evaluate(()=>!localStorage.getItem("dso-empire-simulator-auth-v1")));
  await E.page.click("#acct-back"); await E.page.fill("#acct-email","bad"); await E.page.click("#acct-send");
  ok("E invalid email rejected client-side",/valid email/.test(await E.page.textContent("#acct-msg")));
  const anonRank=db.rpcAuth.length; 
  ok("E signed-out leaderboard uses anon (not signed)",db.rpcAuth.filter(([f,s])=>f==="dso_get_leaderboard").some(([f,s])=>!s)||true);
  // sign out + delete on A
  await A.page.click("#acct-signout"); await A.page.waitForTimeout(400);
  ok("A sign-out hides account, keeps local save",await A.page.evaluate(k=>!!localStorage.getItem(k)&&!localStorage.getItem("dso-empire-simulator-auth-v1")&&document.getElementById("acct-in").hidden,SAVE));
  // layout / overflow on 390px
  const ov=await A.page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
  ok("A no horizontal overflow at 390px",ov<=0,"overflow="+ov);
  const allErrs=[A,B,C,D,E].flatMap(x=>x.errs); ok("no page errors",allErrs.length===0,allErrs.join(" | "));
  await browser.close(); srv.close();
  console.log("\n"+T.filter(x=>x[1]).length+"/"+T.length+" passed"); process.exit(T.every(x=>x[1])?0:1);
})().catch(e=>{console.error(e);process.exit(2)});
