// Local stand-in for claude.ai's `db` and `user` capabilities, used only by local/server.py.
// It implements the subset trivialRANKS calls, with the same semantics:
//   set() replaces the whole document; update() deep-merges nested objects
//   and rejects {code:'invalid_argument'} when the document doesn't exist.
// Each browser gets its own player id (kept in localStorage). Add ?as=<name>
// to the address to act as a different player, e.g. to test with two tabs.
(function(){
  const POLL_MS = 2000;
  const params = new URLSearchParams(location.search);
  function localId(){
    const as = (params.get('as') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
    if(as) return 'local-' + as;
    let id = null;
    try{ id = localStorage.getItem('local-uid'); }catch(e){}
    if(!id){
      id = 'local-' + Math.random().toString(36).slice(2, 10);
      try{ localStorage.setItem('local-uid', id); }catch(e){}
    }
    return id;
  }
  const uid = localId();

  async function api(method, url, body){
    const res = await fetch(url, {method, headers: body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
    const json = await res.json().catch(() => ({}));
    if(!res.ok){ const err = new Error(json.error || res.statusText); err.code = json.code || 'unavailable'; throw err; }
    return json;
  }
  const docSnap = (id, exists, data) => ({id, exists, data: () => exists ? JSON.parse(JSON.stringify(data)) : undefined});

  function docRef(path){
    const id = path.split('/').pop();
    const write = (op, data) => api('POST', '/api/doc', {op, path, data}).then(() => { poke(); });
    return {
      id, path,
      async get(){ const r = await api('GET', '/api/doc?path=' + encodeURIComponent(path)); return docSnap(id, r.exists, r.data); },
      set: data => write('set', data),
      update: data => write('update', data),
      delete: () => write('delete'),
    };
  }

  const listeners = new Set();
  function poke(){ listeners.forEach(l => l.tick(true)); }

  function collectionRef(path){
    return {
      id: path.split('/').pop(), path,
      doc: id => docRef(path + '/' + id),
      async get(){ const r = await api('GET', '/api/collection?path=' + encodeURIComponent(path)); return snap(r.docs); },
      onSnapshot(onNext, onError){
        let since = '', stopped = false, timer = null, busy = false;
        const l = {
          async tick(force){
            if(stopped || busy) return;
            busy = true;
            try{
              const r = await api('GET', '/api/collection?path=' + encodeURIComponent(path) + (since && !force ? '&since=' + since : ''));
              since = String(r.version);
              if(!r.unchanged) onNext(snap(r.docs));
            }catch(e){ if(onError) onError(e); }
            finally{ busy = false; }
          }
        };
        listeners.add(l);
        l.tick(true);
        timer = setInterval(() => { if(!document.hidden) l.tick(false); }, POLL_MS);
        return () => { stopped = true; clearInterval(timer); listeners.delete(l); };
      },
    };
  }
  function snap(docs){
    const list = docs.map(d => docSnap(d.id, true, d.data));
    return {docs: list, size: list.length, empty: !list.length, metadata: {fromCache: false}};
  }

  const db = Object.freeze({
    doc: path => docRef(path.replace(/^\/|\/$/g, '')),
    collection: path => collectionRef(path.replace(/^\/|\/$/g, '')),
  });

  const user = Object.freeze({
    id: async () => uid,
    me: async () => ({id: uid, name: '', isMe: true}),
    isOwner: () => true,
    canEdit: () => true,
    can: () => true,
    // Names come from each player's own document, so profiles only need to resolve.
    profiles: async ids => Object.fromEntries((ids || []).map(id => [id, {id, name: '', isMe: id === uid}])),
    search: async () => [],
  });

  window.claude = Object.freeze({
    use: async name => name === 'db' ? db : name === 'user' ? user : null,
  });
  console.info('[trivialRANKS local] player id', uid);
})();
