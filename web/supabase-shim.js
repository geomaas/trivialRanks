// Supabase stand-in for claude.ai's `db` and `user` capabilities, used by the Vercel build.
// build.mjs loads supabase-js and sets window.TRIVIAL_CONFIG = {url, key} before this file.
//
// Same semantics as on claude.ai, for the calls trivialRANKS makes:
//   db.collection('players').onSnapshot(cb, err)   live list of players (Supabase Realtime)
//   db.doc('players/<id>').get() / set(data) / update(patch) / delete()
//     set() replaces the row; update() deep-merges nested objects and rejects
//     {code:'invalid_argument'} when the row doesn't exist.
//   user.id()  the signed-in Supabase user id, or null when signed out
// Plus `groups`, which claude.ai doesn't have (the page hides groups when use('groups') is null).
// It also adds a small sign-in bar (emailed code, or the email's link) at the bottom of the page.
(function(){
  const cfg = window.TRIVIAL_CONFIG || {};
  // A sign-in link that failed comes back with the reason in the address (#error_description=…);
  // capture it before supabase-js tidies the address, so the sign-in bar can show it.
  const linkError = (() => {
    const p = new URLSearchParams(location.hash.slice(1) + '&' + location.search.slice(1));
    const d = p.get('error_description') || p.get('error');
    return d ? {text: d.replace(/\+/g, ' '), code: p.get('error_code') || ''} : null;
  })();
  const sb = window.supabase && cfg.url && cfg.key
    ? window.supabase.createClient(cfg.url, cfg.key, {auth: {flowType: 'implicit', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true}})
    : null;
  const TABLE = 'players';

  // Resolves once any sign-in link in the address has been read.
  const sessionReady = sb
    ? sb.auth.getSession().then(r => (r.data && r.data.session) || null).catch(() => null)
    : Promise.resolve(null);

  const fail = (err, fallback) => { const e = new Error((err && err.message) || fallback || 'request failed'); e.code = (err && err.code) || 'unavailable'; return e; };
  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
  const docSnap = (id, exists, data) => ({id, exists, data: () => exists ? clone(data) : undefined});
  function onlyPlayers(path){
    const parts = String(path).replace(/^\/|\/$/g, '').split('/');
    if(parts[0] !== TABLE) throw fail({code: 'invalid_argument', message: 'only the players collection exists here'});
    return parts;
  }

  const refreshers = new Set();
  const refreshAll = () => refreshers.forEach(f => f());

  function docRef(path){
    const parts = onlyPlayers(path);
    if(parts.length !== 2) throw fail({code: 'invalid_argument', message: 'bad document path'});
    const id = parts[1];
    return {
      id, path: parts.join('/'),
      async get(){
        const {data, error} = await sb.from(TABLE).select('data').eq('id', id).maybeSingle();
        if(error) throw fail(error);
        return docSnap(id, !!data, data && data.data);
      },
      async set(value){
        const {error} = await sb.from(TABLE).upsert({id, data: value, updated_at: new Date().toISOString()});
        if(error) throw fail(error);
        refreshAll();
      },
      async update(patch){
        const {error} = await sb.rpc('update_player', {patch});
        if(error) throw fail(error.code === 'P0002' ? {code: 'invalid_argument', message: error.message} : error);
        refreshAll();
      },
      async delete(){
        const {error} = await sb.from(TABLE).delete().eq('id', id);
        if(error) throw fail(error);
        refreshAll();
      },
    };
  }

  async function fetchAll(){
    const {data, error} = await sb.from(TABLE).select('id, data').order('id');
    if(error) throw fail(error);
    const docs = (data || []).map(r => docSnap(r.id, true, r.data));
    return {docs, size: docs.length, empty: !docs.length, metadata: {fromCache: false}};
  }

  function collectionRef(path){
    onlyPlayers(path);
    return {
      id: TABLE, path: TABLE,
      doc: id => docRef(TABLE + '/' + id),
      get: fetchAll,
      onSnapshot(onNext, onError){
        let stopped = false, busy = false, again = false;
        const pull = async () => {
          if(stopped) return;
          if(busy){ again = true; return; }
          busy = true;
          try{ const s = await fetchAll(); if(!stopped) onNext(s); }
          catch(e){ if(onError) onError(e); }
          finally{ busy = false; if(again){ again = false; pull(); } }
        };
        let t = null;
        const soon = () => { clearTimeout(t); t = setTimeout(pull, 250); };  // coalesce bursts of changes
        refreshers.add(soon);
        const channel = sb.channel('players-' + Math.random().toString(36).slice(2))
          .on('postgres_changes', {event: '*', schema: 'public', table: TABLE}, soon)
          .subscribe();
        const backup = setInterval(() => { if(!document.hidden) pull(); }, 60000);  // in case a live update is missed
        const onVisible = () => { if(!document.hidden) pull(); };
        document.addEventListener('visibilitychange', onVisible);
        pull();
        return () => {
          stopped = true; clearTimeout(t); clearInterval(backup);
          refreshers.delete(soon); sb.removeChannel(channel);
          document.removeEventListener('visibilitychange', onVisible);
        };
      },
    };
  }

  const db = sb && Object.freeze({doc: docRef, collection: collectionRef});
  const user = sb && Object.freeze({
    id: async () => { const s = await sessionReady; return s ? s.user.id : null; },
    me: async () => { const s = await sessionReady; return {id: s ? s.user.id : null, name: '', isMe: true}; },
    isOwner: () => false,
    canEdit: () => false,
    can: name => name === 'data.write' ? null : false,
    // Names come from each player's own row, so profiles only need to resolve.
    profiles: async ids => { const s = await sessionReady; return Object.fromEntries((ids || []).map(id => [id, {id, name: '', isMe: !!s && id === s.user.id}])); },
    search: async () => [],
  });

  // Groups (supabase/groups.sql). Every change goes through a database function, which checks
  // membership and ownership; errors come back with a message fit to show.
  const rpc = async (fn, args) => { const {data, error} = await sb.rpc(fn, args); if(error) throw fail(error); return data; };
  const groups = sb && Object.freeze({
    // The signed-in player's groups: [{id, name, code, role, members: [{id, role, joinedAt}]}]
    async list(){
      const s = await sessionReady; if(!s) return [];
      const {data, error} = await sb.from('groups').select('id, name, invite_code, listed, created_at, group_members(player_id, role, joined_at)').order('created_at');
      if(error) throw fail(error);
      return (data || []).map(g => {
        const members = (g.group_members || []).map(m => ({id: m.player_id, role: m.role, joinedAt: m.joined_at}))
          .sort((a,b) => a.joinedAt < b.joinedAt ? -1 : 1);
        return {id: g.id, name: g.name, code: g.invite_code, listed: g.listed !== false, members, role: (members.find(m => m.id === s.user.id) || {}).role || 'member'};
      });
    },
    preview: code => rpc('preview_group', {p_code: code}),       // {id, name, members, member} or null
    create: name => rpc('create_group', {p_name: name}),         // {id, name, code}
    join: code => rpc('join_group', {p_code: code}),             // {id, name}
    leave: id => rpc('leave_group', {p_group: id}),
    rename: (id, name) => rpc('rename_group', {p_group: id, p_name: name}),
    resetCode: id => rpc('reset_invite', {p_group: id}),         // the new code
    remove: (id, playerId) => rpc('remove_member', {p_group: id, p_player: playerId}),
    // Search and join requests (supabase/group-requests.sql).
    // Waiting requests you can see: your own, plus those for groups you run. [{groupId, playerId, at}]
    async requests(){
      const s = await sessionReady; if(!s) return [];
      const {data, error} = await sb.from('group_join_requests').select('group_id, player_id, created_at').order('created_at');
      if(error) throw fail(error);
      const mine = await rpc('my_join_requests', {}).catch(() => []), names = Object.fromEntries((mine || []).map(r => [r.groupId, r.name]));
      return (data || []).map(r => ({groupId: r.group_id, playerId: r.player_id, at: r.created_at, groupName: names[r.group_id] || ''}));
    },
    search: q => rpc('search_groups', {p_query: q}),             // [{id, name, members, member, requested}]
    request: id => rpc('request_join', {p_group: id}),           // 'requested' or 'member'
    cancelRequest: id => rpc('cancel_join_request', {p_group: id}),
    approve: (id, playerId) => rpc('approve_join_request', {p_group: id, p_player: playerId}),
    decline: (id, playerId) => rpc('decline_join_request', {p_group: id, p_player: playerId}),
    setListed: (id, listed) => rpc('set_group_listed', {p_group: id, p_listed: listed}),
  });

  window.claude = Object.freeze({
    use: async name => {
      if(!sb) return null;
      await sessionReady;
      return name === 'db' ? db : name === 'user' ? user : name === 'groups' ? groups : null;
    },
  });

  /* ---------- Sign-in bar ---------- */
  function bar(){
    const el = document.createElement('div');
    el.id = 'authBar';
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:50;background:var(--card,#fff);border-top:1px solid var(--line,#ddd);padding:10px 16px calc(10px + env(safe-area-inset-bottom));font:14px Inter,system-ui,sans-serif;color:var(--ink,#222)';
    document.body.appendChild(el);
    document.body.style.paddingBottom = '96px';
    return el;
  }
  // Sign-in is two steps on the same page: enter your email, then the code from the email.
  // The email's link still works too, for anyone who taps it instead.
  // (The code only appears if the Supabase email templates include {{ .Token }}; see the README.)
  const PENDING = 'authPending', PENDING_MS = 15 * 60 * 1000;
  const pendingEmail = () => { try{ const p = JSON.parse(sessionStorage.getItem(PENDING)); return p && Date.now() - p.at < PENDING_MS ? p.email : null; }catch(e){ return null; } };
  const setPending = email => { try{ email ? sessionStorage.setItem(PENDING, JSON.stringify({email, at: Date.now()})) : sessionStorage.removeItem(PENDING); }catch(e){} };
  const FIELD = 'padding:8px 10px;border:1px solid var(--line,#ccc);border-radius:8px;background:var(--field,#fff);color:inherit;font:inherit';
  const BUTTON = 'padding:8px 14px;border:0;border-radius:8px;background:var(--accent,#2f5d50);color:#fff;font-weight:600;font-size:14px;font-family:inherit;cursor:pointer';
  const LINK = 'border:0;background:none;padding:0;color:var(--accent,#2f5d50);font:inherit;font-weight:600;cursor:pointer;text-decoration:underline';
  const sendError = error => error.status === 429 ? 'Too many sign-in emails right now. Try again in a little while.' : "Couldn't send the email: " + error.message;
  const send = email => sb.auth.signInWithOtp({email, options: {emailRedirectTo: location.origin + location.pathname}});

  function signedOutBar(){
    const el = bar();
    if(!sb){ el.textContent = 'Saving is unavailable: this copy of the site is missing its database settings.'; return; }
    el.innerHTML = `<form id="authForm" style="max-width:560px;margin:0 auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap"></form>`;
    const form = el.querySelector('#authForm');
    const warn = (msg, text) => { msg.style.color = 'var(--warm,#b4532a)'; msg.textContent = text; };

    function emailStep(note){
      form.innerHTML = `<span style="font-weight:600">Sign in to post scores</span>
        <input id="authEmail" type="email" required autocomplete="email" placeholder="you@example.com" style="flex:1;min-width:160px;${FIELD}">
        <button type="submit" style="${BUTTON}">Email me a code</button>
        <div id="authMsg" style="flex-basis:100%;font-size:12.5px;color:var(--muted,#666)"></div>`;
      const msg = form.querySelector('#authMsg'), btn = form.querySelector('button');
      if(note) warn(msg, note);
      form.onsubmit = async ev => {
        ev.preventDefault();
        const email = form.querySelector('#authEmail').value.trim();
        if(!email) return;
        btn.disabled = true; msg.style.color = ''; msg.textContent = 'Sending…';
        const {error} = await send(email);
        if(error){ btn.disabled = false; warn(msg, sendError(error)); return; }
        setPending(email); codeStep(email);
      };
    }

    function codeStep(email){
      form.innerHTML = `<span style="font-weight:600">Enter the code from your email</span>
        <input id="authCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="12" placeholder="123456" style="width:120px;letter-spacing:2px;${FIELD}">
        <button type="submit" style="${BUTTON}">Sign in</button>
        <div style="flex-basis:100%;font-size:12.5px;color:var(--muted,#666)"><span id="authMsg"></span>
          <button type="button" id="authAgain" style="${LINK}">Send a new code</button> · <button type="button" id="authBack" style="${LINK}">Use a different email</button></div>`;
      const msg = form.querySelector('#authMsg'), code = form.querySelector('#authCode'), btn = form.querySelector('button[type=submit]');
      const sentTo = () => { msg.style.color = ''; msg.textContent = `Sent to ${email}. Tapping the link in the email works too. `; };
      sentTo(); code.focus();
      form.onsubmit = async ev => {
        ev.preventDefault();
        const token = code.value.replace(/\D/g, '');
        if(token.length < 6){ warn(msg, 'Enter the whole code from the email. '); return; }
        btn.disabled = true; msg.style.color = ''; msg.textContent = 'Checking… ';
        const {error} = await sb.auth.verifyOtp({email, token, type: 'email'});
        if(error){ btn.disabled = false; code.select(); warn(msg, "That code didn't work or has expired. Check it, or send a new one. "); return; }
        setPending(null);   // signed in: the page reloads itself as this player (see start())
      };
      form.querySelector('#authAgain').onclick = async ev => {
        ev.target.disabled = true; msg.style.color = ''; msg.textContent = 'Sending… ';
        const {error} = await send(email);
        ev.target.disabled = false;
        if(error) warn(msg, sendError(error) + ' '); else { setPending(email); sentTo(); }
      };
      form.querySelector('#authBack').onclick = () => { setPending(null); emailStep(); };
    }

    let note = '';
    if(linkError){
      note = linkError.code === 'otp_expired'
        ? 'That sign-in link has expired or was already used. Send yourself a new code.'
        : 'Sign-in failed: ' + linkError.text;
      history.replaceState(null, '', location.pathname);
    }
    // Coming back from the mail app after a reload: go straight to the code box.
    const waiting = !note && pendingEmail();
    waiting ? codeStep(waiting) : emailStep(note);
  }
  function signedInBar(session){
    const el = bar();
    setPending(null);
    el.style.padding = '6px 16px calc(6px + env(safe-area-inset-bottom))';
    document.body.style.paddingBottom = '44px';
    el.innerHTML = `<div style="max-width:560px;margin:0 auto;display:flex;justify-content:space-between;gap:8px;font-size:12.5px;color:var(--muted,#666)">
        <span>Signed in as ${String(session.user.email || '').replace(/[&<>"']/g, '')}</span>
        <button id="authOut" style="border:0;background:none;color:var(--accent,#2f5d50);font-weight:600;font-size:12.5px;font-family:inherit;cursor:pointer;padding:0">Sign out</button></div>`;
    el.querySelector('#authOut').onclick = async () => { await sb.auth.signOut(); location.reload(); };
  }
  function start(){
    sessionReady.then(s => {
      if(s && location.hash.includes('access_token')) history.replaceState(null, '', location.pathname + location.search);
      s ? signedInBar(s) : signedOutBar();
    });
    // Signing in or out in another tab: reload so the page reconnects as the right player.
    if(sb) sessionReady.then(first => sb.auth.onAuthStateChange((event, s) => {
      const was = first ? first.user.id : null, now = s ? s.user.id : null;
      if(was !== now && (event === 'SIGNED_IN' || event === 'SIGNED_OUT')) location.reload();
    }));
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start) : start();
})();
