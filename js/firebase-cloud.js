(function(){
  'use strict';

  const VERSION='12.15.0';
  const ADMIN_EMAIL='io.catrinoiu@gmail.com';
  const badge=()=>document.getElementById('cloudSyncBadge');
  const setBadge=(text,state='idle')=>{
    const el=badge(); if(!el)return;
    el.textContent=text;
    const map={ok:['#ecfdf3','#027a48','#abefc6'],error:['#fef3f2','#b42318','#fecdca'],work:['#eff8ff','#175cd3','#b2ddff'],idle:['#fff','#667085','#e4e7ec']};
    const c=map[state]||map.idle; el.style.background=c[0];el.style.color=c[1];el.style.borderColor=c[2];
  };
  const emailForUsername=(username)=>{
    const u=String(username||'').trim().toLowerCase();
    if(u==='administrator')return ADMIN_EMAIL;
    return u.replace(/[^a-z0-9._-]/g,'.')+'@avvero-sphera.ro';
  };
  const safeId=(v)=>String(v||'').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,180)||('item_'+Date.now());
  const clone=(v)=>JSON.parse(JSON.stringify(v));

  let fb={};
  let app,auth,db,secondaryApp,secondaryAuth;
  let remoteOrderIds=new Set();
  let cloudReady=false;
  let applyingRemote=false;
  let listeners=[];
  let syncTimer=null;
  let ordersLoaded=false,nomenLoaded=false,clientsLoaded=false;
  let lastOrdersSignature='',lastNomenSignature='',lastClientsSignature='';
  let ordersSaveTimer=null,nomenSaveTimer=null,clientsSaveTimer=null;

  async function loadFirebase(){
    const [appMod,authMod,fsMod]=await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${VERSION}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${VERSION}/firebase-auth.js`),
      import(`https://www.gstatic.com/firebasejs/${VERSION}/firebase-firestore.js`)
    ]);
    fb={...appMod,...authMod,...fsMod};
    app=fb.initializeApp(window.SPHERA_FIREBASE_CONFIG);
    auth=fb.getAuth(app);
    db=fb.getFirestore(app);
    secondaryApp=fb.initializeApp(window.SPHERA_FIREBASE_CONFIG,'sphera-user-admin');
    secondaryAuth=fb.getAuth(secondaryApp);
  }

  function showApp(){
    const loginScreen=document.getElementById('loginScreen');
    const appScreen=document.getElementById('appScreen');
    document.body.classList.remove('login-active');
    if(loginScreen){loginScreen.classList.add('hide');loginScreen.hidden=true;loginScreen.style.setProperty('display','none','important');}
    if(appScreen){appScreen.hidden=false;appScreen.classList.remove('hide');appScreen.style.setProperty('display','block','important');}
    if(typeof applyPermissions==='function')applyPermissions();
    if(typeof render==='function')render();
    if(typeof showPage==='function')showPage('dashboard');
  }

  function showLogin(){
    const loginScreen=document.getElementById('loginScreen');
    const appScreen=document.getElementById('appScreen');
    document.body.classList.add('login-active');
    if(appScreen){appScreen.hidden=true;appScreen.classList.add('hide');appScreen.style.setProperty('display','none','important');}
    if(loginScreen){loginScreen.hidden=false;loginScreen.classList.remove('hide');loginScreen.style.setProperty('display','grid','important');}
  }

  async function profileForUser(user){
    const ref=fb.doc(db,'users',user.uid);
    const snap=await fb.getDoc(ref);
    if(snap.exists())return {uid:user.uid,...snap.data()};
    if(user.email===ADMIN_EMAIL){
      const profile={name:'Administrator SPHERA',username:'administrator',email:user.email,role:'admin',center:'',active:true,operatorCode:'00',createdAt:fb.serverTimestamp()};
      await fb.setDoc(ref,profile,{merge:true});
      return {uid:user.uid,...profile};
    }
    throw new Error('Profilul utilizatorului nu există în Firestore.');
  }

  async function signIn(){
    const userEl=document.getElementById('user'),passEl=document.getElementById('pass'),err=document.getElementById('loginErr');
    const username=String(userEl?.value||'').trim().toLowerCase();
    const password=String(passEl?.value||'');
    if(!username||!password){if(err)err.textContent='Completează utilizatorul și parola.';return false;}
    try{
      setBadge('Cloud: autentificare','work');
      const remember=!!document.getElementById('rememberMe')?.checked;
      await fb.setPersistence(auth,remember?fb.browserLocalPersistence:fb.browserSessionPersistence);
      const credential=await fb.signInWithEmailAndPassword(auth,emailForUsername(username),password);
      const profile=await profileForUser(credential.user);
      if(profile.active===false)throw new Error('Contul este dezactivat.');
      currentUser=profile;
      if(err)err.textContent='';
      localStorage.setItem('sphera_remembered_user',profile.username||username);
      localStorage.removeItem('sphera_remembered_pass');
      await startCloud(profile);
      showApp();
      setBadge('Cloud: conectat','ok');
      return false;
    }catch(error){
      console.error(error);
      if(err)err.textContent=error.code==='auth/invalid-credential'?'Utilizator sau parolă incorectă.':(error.message||'Autentificarea a eșuat.');
      setBadge('Cloud: eroare autentificare','error');
      return false;
    }
  }

  async function startCloud(profile){
    stopListeners();
    ordersLoaded=nomenLoaded=clientsLoaded=false;
    await migrateIfNeeded(profile);

    listeners.push(fb.onSnapshot(fb.collection(db,'orders'),snap=>{
      applyingRemote=true;
      remoteOrderIds=new Set();
      orders=snap.docs.map(d=>{remoteOrderIds.add(d.id);return d.data();}).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
      localStorage.setItem('rx_orders',JSON.stringify(orders));
      lastOrdersSignature=stableStringify(orders);
      ordersLoaded=true;
      applyingRemote=false;
      if(typeof render==='function')render();
      if(typeof renderProcessingOrders==='function')renderProcessingOrders();
    },cloudError));

    listeners.push(fb.onSnapshot(fb.doc(db,'shared','nomenclators'),snap=>{
      if(!snap.exists())return;
      applyingRemote=true;
      const d=snap.data();
      if(Array.isArray(d.centers))CENTERS.splice(0,CENTERS.length,...d.centers);
      if(Array.isArray(d.products))PRODUCTS.splice(0,PRODUCTS.length,...d.products);
      if(Array.isArray(d.materials))MATERIALS.splice(0,MATERIALS.length,...d.materials);
      if(Array.isArray(d.indices))INDICES.splice(0,INDICES.length,...d.indices);
      if(Array.isArray(d.treatments))TREATMENTS.splice(0,TREATMENTS.length,...d.treatments);
      lastNomenSignature=nomenSignature();
      nomenLoaded=true;
      applyingRemote=false;
      if(typeof render==='function')render();
    },cloudError));

    listeners.push(fb.onSnapshot(fb.doc(db,'shared','userClients'),snap=>{
      if(!snap.exists())return;
      applyingRemote=true;
      USER_CLIENTS.splice(0,USER_CLIENTS.length,...(snap.data().items||[]));
      lastClientsSignature=stableStringify(USER_CLIENTS);
      clientsLoaded=true;
      applyingRemote=false;
      if(typeof renderClients==='function')renderClients();
    },cloudError));

    listeners.push(fb.onSnapshot(fb.collection(db,'users'),snap=>{
      applyingRemote=true;
      USERS=snap.docs.map(d=>({uid:d.id,...d.data()})).sort((a,b)=>Number(b.createdAt?.seconds||b.createdAt||0)-Number(a.createdAt?.seconds||a.createdAt||0));
      localStorage.setItem('sphera_users_v1',JSON.stringify(USERS));
      const mine=USERS.find(u=>u.uid===auth.currentUser?.uid);
      if(mine)currentUser={...mine};
      applyingRemote=false;
      if(typeof applyPermissions==='function')applyPermissions();
      if(typeof renderUsersAdmin==='function')renderUsersAdmin();
    },cloudError));

    cloudReady=true;
    startChangeWatcher();
  }

  function stopListeners(){listeners.forEach(fn=>{try{fn();}catch(e){}});listeners=[];cloudReady=false;if(syncTimer){clearInterval(syncTimer);syncTimer=null;}[ordersSaveTimer,nomenSaveTimer,clientsSaveTimer].forEach(t=>t&&clearTimeout(t));ordersSaveTimer=nomenSaveTimer=clientsSaveTimer=null;}
  function cloudError(error){console.error(error);setBadge('Cloud: conexiune întreruptă','error');}

  function stableStringify(value){
    try{return JSON.stringify(value,function(key,val){
      if(val&&typeof val==='object'&&!Array.isArray(val)){
        const out={};Object.keys(val).sort().forEach(k=>{if(val[k]!==undefined)out[k]=val[k];});return out;
      }
      return val;
    });}catch(e){return '';}
  }

  function nomenSignature(){
    return stableStringify({centers:CENTERS,products:PRODUCTS,materials:MATERIALS,indices:INDICES,treatments:TREATMENTS});
  }

  function scheduleOrdersSave(){
    if(ordersSaveTimer)clearTimeout(ordersSaveTimer);
    ordersSaveTimer=setTimeout(()=>saveOrdersCloud().catch(cloudError),250);
  }
  function scheduleNomenSave(){
    if(nomenSaveTimer)clearTimeout(nomenSaveTimer);
    nomenSaveTimer=setTimeout(()=>saveNomenCloud().catch(cloudError),350);
  }
  function scheduleClientsSave(){
    if(clientsSaveTimer)clearTimeout(clientsSaveTimer);
    clientsSaveTimer=setTimeout(()=>saveClientsCloud().catch(cloudError),350);
  }

  function startChangeWatcher(){
    if(syncTimer)clearInterval(syncTimer);
    syncTimer=setInterval(()=>{
      if(!cloudReady||applyingRemote||!auth.currentUser)return;
      if(ordersLoaded){
        const sig=stableStringify(orders||[]);
        if(sig!==lastOrdersSignature){lastOrdersSignature=sig;scheduleOrdersSave();}
      }
      if(nomenLoaded){
        const sig=nomenSignature();
        if(sig!==lastNomenSignature){lastNomenSignature=sig;scheduleNomenSave();}
      }
      if(clientsLoaded){
        const sig=stableStringify(USER_CLIENTS||[]);
        if(sig!==lastClientsSignature){lastClientsSignature=sig;scheduleClientsSave();}
      }
    },500);
  }

  async function migrateIfNeeded(profile){
    const marker=fb.doc(db,'meta','migration');
    const markerSnap=await fb.getDoc(marker);
    if(markerSnap.exists())return;
    setBadge('Cloud: migrare inițială','work');

    const batch=fb.writeBatch(db);
    batch.set(fb.doc(db,'users',auth.currentUser.uid),{
      name:profile.name||'Administrator SPHERA',username:'administrator',email:ADMIN_EMAIL,role:'admin',center:'',active:true,operatorCode:'00',createdAt:fb.serverTimestamp()
    },{merge:true});
    batch.set(fb.doc(db,'shared','nomenclators'),{centers:clone(CENTERS),products:clone(PRODUCTS),materials:clone(MATERIALS),indices:clone(INDICES),treatments:clone(TREATMENTS),updatedAt:fb.serverTimestamp()});
    batch.set(fb.doc(db,'shared','userClients'),{items:clone(USER_CLIENTS),updatedAt:fb.serverTimestamp()});
    (orders||[]).forEach(o=>batch.set(fb.doc(db,'orders',safeId(o.id)),clone(o)));
    batch.set(marker,{completed:true,completedAt:fb.serverTimestamp(),by:auth.currentUser.uid});
    await batch.commit();

    for(const u of (USERS||[])){
      if(String(u.username||'').toLowerCase()==='administrator')continue;
      await ensureAuthAndProfile(u).catch(e=>console.warn('Import utilizator',u.username,e.code||e.message));
    }
  }

  async function ensureAuthAndProfile(u){
    const email=emailForUsername(u.username);
    let credential;
    try{credential=await fb.createUserWithEmailAndPassword(secondaryAuth,email,String(u.pass||'Schimba123!'));}
    catch(e){
      if(e.code!=='auth/email-already-in-use')throw e;
      credential=await fb.signInWithEmailAndPassword(secondaryAuth,email,String(u.pass||''));
    }
    const uid=credential.user.uid;
    await fb.setDoc(fb.doc(db,'users',uid),{
      name:u.name||u.username,username:u.username,email,role:u.role||'operator',center:u.center||'',active:u.active!==false,operatorCode:u.operatorCode||u.code||'',createdAt:u.createdAt||Date.now(),pass:u.pass||''
    },{merge:true});
    await fb.signOut(secondaryAuth);
    return uid;
  }

  async function saveOrdersCloud(){
    if(!cloudReady||applyingRemote)return;
    setBadge('Cloud: se salvează','work');
    const batch=fb.writeBatch(db);
    const current=new Set();
    for(const o of (orders||[])){
      const id=safeId(o.id);current.add(id);batch.set(fb.doc(db,'orders',id),clone(o));
    }
    remoteOrderIds.forEach(id=>{if(!current.has(id))batch.delete(fb.doc(db,'orders',id));});
    await batch.commit();
    remoteOrderIds=current;
    lastOrdersSignature=stableStringify(orders||[]);
    setBadge('Cloud: sincronizat','ok');
  }

  async function saveNomenCloud(){
    if(!cloudReady||applyingRemote)return;
    setBadge('Cloud: se salvează','work');
    await fb.setDoc(fb.doc(db,'shared','nomenclators'),{centers:clone(CENTERS),products:clone(PRODUCTS),materials:clone(MATERIALS),indices:clone(INDICES),treatments:clone(TREATMENTS),updatedAt:fb.serverTimestamp()},{merge:true});
    lastNomenSignature=nomenSignature();setBadge('Cloud: sincronizat','ok');
  }
  async function saveClientsCloud(){
    if(!cloudReady||applyingRemote)return;
    setBadge('Cloud: se salvează','work');
    await fb.setDoc(fb.doc(db,'shared','userClients'),{items:clone(USER_CLIENTS),updatedAt:fb.serverTimestamp()},{merge:true});
    lastClientsSignature=stableStringify(USER_CLIENTS||[]);setBadge('Cloud: sincronizat','ok');
  }

  async function addUserCloud(){
    if(!isAdmin())return;
    const name=capWords(cleanVal('newUserFullName'));
    const parts=String(name||'').trim().split(/\s+/).filter(Boolean);
    const username=parts.length>=2?slug(parts[0])+'.'+slug(parts[1]):slug(cleanVal('newUsername'));
    const role=document.getElementById('newUserRole')?.value||'operator';
    const center=cleanVal('newUserCenter');
    const pass=cleanVal('newUserPassword')||generateUserPassword(username);
    if(!name||parts.length<2||!username||(role!=='admin'&&!center)){showAppConfirm({title:'Date incomplete',text:'Completează numele, tipul utilizatorului și centrul de procesare.',confirmText:'OK'});return;}
    if(USERS.some(x=>slug(x.username)===username)){showAppConfirm({title:'Utilizator existent',text:'Există deja contul '+username+'.',confirmText:'OK'});return;}
    try{
      setBadge('Cloud: creare utilizator','work');
      await ensureAuthAndProfile({name,username,pass,role,center:role==='admin'?'':center,createdAt:Date.now()});
      ['newUserFullName','newUsername','newUserPassword'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
      document.getElementById('newUserRole').value='operator';syncUserCenterField();closeUserDialog();
      showAppConfirm({title:'Utilizator creat',text:'Utilizator: '+username+'\nParolă: '+pass,confirmText:'OK'});
      setBadge('Cloud: sincronizat','ok');
    }catch(e){console.error(e);showAppConfirm({title:'Eroare',text:e.message||'Utilizatorul nu a putut fi creat.',confirmText:'OK'});setBadge('Cloud: eroare','error');}
  }

  async function updateUserCloud(index,field,value){
    if(!isAdmin())return;
    const u=USERS[index];if(!u?.uid)return;
    let patch={};
    if(field==='username'){
      const next=slug(value);if(!next||USERS.some((x,i)=>i!==index&&slug(x.username)===next)){renderUsersAdmin();return;}patch.username=next;
    }else{patch[field]=value;if(field==='role'&&value==='admin')patch.center='';}
    await fb.updateDoc(fb.doc(db,'users',u.uid),patch);
  }

  async function deleteUserCloud(index){
    if(!isAdmin())return;
    const u=USERS[index];if(!u?.uid)return;
    if(u.uid===auth.currentUser?.uid){showAppConfirm({title:'Cont protejat',text:'Nu poți șterge contul conectat.',confirmText:'OK'});return;}
    showAppConfirm({title:'Ștergere utilizator',text:'Dezactivezi contul '+u.username+'?',confirmText:'Dezactivează',danger:true,onConfirm:async()=>{await fb.updateDoc(fb.doc(db,'users',u.uid),{active:false});}});
  }

  function installOverrides(){
    window.doLogin=signIn;
    doLogin=signIn;
    window.logout=async function(){stopListeners();await fb.signOut(auth);currentUser=null;showLogin();setBadge('Cloud: deconectat','idle');};
    logout=window.logout;

    const localSave=save;
    save=function(){localSave();if(ordersLoaded){lastOrdersSignature=stableStringify(orders||[]);scheduleOrdersSave();}};window.save=save;
    const localNomen=saveNomenclators;
    saveNomenclators=function(){localNomen();if(nomenLoaded){lastNomenSignature=nomenSignature();scheduleNomenSave();}};window.saveNomenclators=saveNomenclators;
    const localClients=saveUserClients;
    saveUserClients=function(){localClients();if(clientsLoaded){lastClientsSignature=stableStringify(USER_CLIENTS||[]);scheduleClientsSave();}};window.saveUserClients=saveUserClients;

    window.addUserAccount=addUserCloud;addUserAccount=addUserCloud;
    window.updateUserAccount=updateUserCloud;updateUserAccount=updateUserCloud;
    window.deleteUserAccount=deleteUserCloud;deleteUserAccount=deleteUserCloud;

    const oldBtn=document.getElementById('loginBtn');
    if(oldBtn){const fresh=oldBtn.cloneNode(true);oldBtn.parentNode.replaceChild(fresh,oldBtn);fresh.addEventListener('click',signIn);}
    ['user','pass'].forEach(id=>{const el=document.getElementById(id);if(el){const fresh=el.cloneNode(true);el.parentNode.replaceChild(fresh,el);fresh.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();signIn();}});}});
  }

  async function boot(){
    try{
      setBadge('Cloud: inițializare','work');
      await loadFirebase();
      installOverrides();
      fb.onAuthStateChanged(auth,async user=>{
        if(!user){showLogin();setBadge('Cloud: neautentificat','idle');return;}
        try{
          const profile=await profileForUser(user);
          if(profile.active===false){await fb.signOut(auth);throw new Error('Contul este dezactivat.');}
          currentUser=profile;await startCloud(profile);showApp();setBadge('Cloud: conectat','ok');
        }catch(e){console.error(e);showLogin();setBadge('Cloud: eroare profil','error');}
      });
    }catch(e){console.error(e);setBadge('Cloud: Firebase indisponibil','error');}
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
