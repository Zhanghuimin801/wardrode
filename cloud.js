(function () {
  'use strict';

  var CFG = window.WARDROBE_CLOUD_CONFIG || {};
  var SESSION_KEY = 'wardrobe-cloud-session';
  var PENDING_KEY = 'wardrobe-cloud-pending';
  var LASTSYNC_KEY = 'wardrobe-cloud-lastsync';
  var T = { items: 'wardrobe_items', outfits: 'wardrobe_outfits' };
  var listeners = [];
  var CONFIG_KEY = 'wardrobe-cloud-config';

  /* 配置来源：config.js 优先；文件为空时读本机保存的配置，便于在手机应用里直接填写 */
  try {
    var savedCfg = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
    if (savedCfg && savedCfg.url && savedCfg.anonKey && !CFG.url) {
      CFG.url = normalizeUrl(savedCfg.url);
      CFG.anonKey = savedCfg.anonKey;
    }
  } catch (e) {}

  /* 容错：很多人会把控制台里带 /rest/v1/ 的 URL 直接粘进来，这里自动去掉尾缀 */
  function normalizeUrl(u) {
    return String(u || '').trim()
      .replace(/\/+$/, '')
      .replace(/\/rest\/v1$/, '')
      .replace(/\/auth\/v1$/, '');
  }

  function setConfig(url, anonKey) {
    CFG.url = normalizeUrl(url);
    CFG.anonKey = String(anonKey || '').trim();
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ url: CFG.url, anonKey: CFG.anonKey }));
    emit();
  }

  function clearConfig() {
    CFG.url = ''; CFG.anonKey = '';
    localStorage.removeItem(CONFIG_KEY);
    localStorage.removeItem(SESSION_KEY);
    writePending([]);
    emit();
  }

  function base() { return normalizeUrl(CFG.url); }
  function configured() { return !!(CFG.url && CFG.anonKey); }
  function readLS(k, fallback) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function readSession() { return readLS(SESSION_KEY, null); }
  function writeSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); emit(); }
  function readPending() { var p = readLS(PENDING_KEY, []); return Array.isArray(p) ? p : []; }
  function writePending(p) { localStorage.setItem(PENDING_KEY, JSON.stringify(p.slice(-800))); emit(); }

  function status() {
    var s = readSession();
    return {
      configured: configured(),
      signedIn: !!(s && s.access_token),
      email: s && s.user ? (s.user.email || '') : '',
      pending: readPending().length,
      lastSync: localStorage.getItem(LASTSYNC_KEY) || ''
    };
  }
  function onStatus(fn) { listeners.push(fn); }
  function emit() { var s = status(); listeners.forEach(function (f) { try { f(s); } catch (e) {} }); }

  function headers(token) {
    return {
      'apikey': CFG.anonKey,
      'Authorization': 'Bearer ' + (token || CFG.anonKey),
      'Content-Type': 'application/json'
    };
  }

  function authPost(path, body) {
    return fetch(base() + '/auth/v1/' + path, {
      method: 'POST', headers: headers(CFG.anonKey), body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.msg || d.error_description || d.message || ('请求失败 (' + r.status + ')'));
        return d;
      });
    });
  }

  function saveSession(d) {
    writeSession({
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: Date.now() + (d.expires_in || 3600) * 1000,
      user: d.user || { email: '' }
    });
  }

  function signUp(email, password) {
    return authPost('signup', { email: email, password: password }).then(function (d) {
      if (d.access_token) { saveSession(d); return { signedIn: true }; }
      return { signedIn: false, message: '注册成功。若开启了邮箱验证，请先去邮箱点确认链接，再回来登录。' };
    });
  }

  function signIn(email, password) {
    return authPost('token?grant_type=password', { email: email, password: password }).then(function (d) {
      saveSession(d); return d;
    });
  }

  function signOut() {
    var s = readSession();
    var p = s ? fetch(base() + '/auth/v1/logout', { method: 'POST', headers: headers(s.access_token) }).catch(function () {}) : Promise.resolve();
    return Promise.resolve(p).then(function () {
      localStorage.removeItem(SESSION_KEY);
      writePending([]);
      emit();
    });
  }

  function accessToken() {
    var s = readSession();
    if (!s || !s.access_token) return Promise.reject(new Error('尚未登录'));
    if (Date.now() < (s.expires_at || 0) - 60000) return Promise.resolve(s.access_token);
    return authPost('token?grant_type=refresh_token', { refresh_token: s.refresh_token })
      .then(function (d) {
        writeSession({
          access_token: d.access_token,
          refresh_token: d.refresh_token || s.refresh_token,
          expires_at: Date.now() + (d.expires_in || 3600) * 1000,
          user: d.user || s.user
        });
        return d.access_token;
      })
      .catch(function () {
        localStorage.removeItem(SESSION_KEY); emit();
        throw new Error('登录已过期，请重新登录');
      });
  }

  function req(method, path, body, extra) {
    return accessToken().then(function (token) {
      var h = headers(token);
      if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
      return fetch(base() + '/rest/v1/' + path, {
        method: method, headers: h, body: body == null ? undefined : JSON.stringify(body)
      }).then(function (r) {
        if (!r.ok) {
          return r.text().then(function (t) { throw new Error('云端请求失败 ' + r.status + ' ' + t.slice(0, 160)); });
        }
        return r.text().then(function (t) { return t ? JSON.parse(t) : null; });
      });
    });
  }

  function userId() { var s = readSession(); return s && s.user ? s.user.id : null; }
  function toRow(kind, obj, uid) {
    return { id: obj.id, user_id: uid, data: obj, updated_at: new Date().toISOString() };
  }
  var PREFER = { 'Prefer': 'resolution=merge-duplicates,return=minimal' };

  function upsertMany(kind, list) {
    if (!list.length) return Promise.resolve();
    var uid = userId(), chunks = [], i;
    for (i = 0; i < list.length; i += 25) chunks.push(list.slice(i, i + 25));
    return chunks.reduce(function (chain, part) {
      return chain.then(function () {
        return req('POST', T[kind], part.map(function (o) { return toRow(kind, o, uid); }), PREFER);
      });
    }, Promise.resolve());
  }

  function upsert(kind, obj) { return upsertMany(kind, [obj]); }

  function remove(kind, id) {
    return req('DELETE', T[kind] + '?id=eq.' + encodeURIComponent(id), null, { 'Prefer': 'return=minimal' });
  }

  function pullAll() {
    var u = userId();
    return Promise.all([
      req('GET', T.items + '?select=data&user_id=eq.' + u),
      req('GET', T.outfits + '?select=data&user_id=eq.' + u)
    ]).then(function (r) {
      return {
        items: (r[0] || []).map(function (x) { return x.data; }),
        outfits: (r[1] || []).map(function (x) { return x.data; })
      };
    });
  }

  function deleteAllRows() {
    var u = userId();
    return Promise.all([
      req('DELETE', T.items + '?user_id=eq.' + u, null, { 'Prefer': 'return=minimal' }),
      req('DELETE', T.outfits + '?user_id=eq.' + u, null, { 'Prefer': 'return=minimal' })
    ]);
  }

  function replaceAll(items, outfits) {
    return deleteAllRows()
      .then(function () { return upsertMany('items', items); })
      .then(function () { return upsertMany('outfits', outfits); })
      .then(function () { markSynced(); });
  }

  function enqueue(op) { var p = readPending(); p.push(op); writePending(p); }

  function flush() {
    if (!configured() || !status().signedIn) return Promise.resolve(0);
    var p = readPending();
    if (!p.length) return Promise.resolve(0);
    var done = 0;
    return p.reduce(function (chain, op, idx) {
      return chain.then(function () {
        var task = op.type === 'delete' ? remove(op.kind, op.id) : upsert(op.kind, op.obj);
        return task.then(function () { done = idx + 1; });
      });
    }, Promise.resolve()).then(function () {
      writePending([]); markSynced(); return done;
    }).catch(function (e) {
      writePending(p.slice(done));
      throw e;
    });
  }

  function markSynced() { localStorage.setItem(LASTSYNC_KEY, new Date().toISOString()); emit(); }

  function push(kind, type, payload) {
    if (!configured() || !status().signedIn) return Promise.resolve();
    var op = type === 'delete'
      ? { kind: kind, type: 'delete', id: payload }
      : { kind: kind, type: 'upsert', obj: payload };
    var task = type === 'delete' ? remove(kind, payload) : upsert(kind, payload);
    return task.then(markSynced).catch(function () { enqueue(op); throw new Error('已暂存，联网后会自动补传'); });
  }

  function mergeById(cloudList, localList) {
    var seen = {}, merged = cloudList.slice(), extra = [];
    cloudList.forEach(function (x) { seen[x.id] = 1; });
    localList.forEach(function (x) { if (!seen[x.id]) { merged.push(x); extra.push(x); } });
    return { merged: merged, extra: extra };
  }

  /* 登录后：云端为空则上传本地；云端有数据则按 id 合并，冲突以云端为准，本地独有补上云 */
  function initialSync(localItems, localOutfits) {
    return pullAll().then(function (cloud) {
      if (!cloud.items.length && !cloud.outfits.length) {
        return replaceAll(localItems, localOutfits).then(function () {
          return { items: localItems, outfits: localOutfits, message: '云端是空的，已把本机 ' + localItems.length + ' 件单品上传' };
        });
      }
      var a = mergeById(cloud.items, localItems);
      var b = mergeById(cloud.outfits, localOutfits);
      return upsertMany('items', a.extra)
        .then(function () { return upsertMany('outfits', b.extra); })
        .then(function () { return flush(); })
        .then(function () { markSynced(); })
        .then(function () {
          return {
            items: a.merged, outfits: b.merged,
            message: '已与云端合并：' + a.merged.length + ' 件单品 / ' + b.merged.length + ' 套穿搭'
          };
        });
    });
  }

  window.WardrobeCloud = {
    setConfig: setConfig, clearConfig: clearConfig,
    configured: configured, status: status, onStatus: onStatus, emit: emit,
    signUp: signUp, signIn: signIn, signOut: signOut,
    upsert: upsert, upsertMany: upsertMany, remove: remove,
    pullAll: pullAll, replaceAll: replaceAll, deleteAllRows: deleteAllRows,
    push: push, flush: flush, enqueue: enqueue,
    initialSync: initialSync, markSynced: markSynced
  };
})();
