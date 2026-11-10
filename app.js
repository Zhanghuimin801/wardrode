(function () {
  'use strict';

  var CATEGORIES = ['上衣', '下装', '外套', '连衣裙', '鞋履', '包袋', '配饰', '其他'];
  var SEASONS = ['四季', '春', '夏', '秋', '冬'];
  var COLORS = [
    { name: '黑色', hex: '#2B2B2B' }, { name: '白色', hex: '#F7F6F2' },
    { name: '灰色', hex: '#9A9A96' }, { name: '米杏', hex: '#E3D3BC' },
    { name: '棕色', hex: '#8B6247' }, { name: '红色', hex: '#C04A43' },
    { name: '粉色', hex: '#E7B6C0' }, { name: '橙色', hex: '#DF9152' },
    { name: '黄色', hex: '#E3C45E' }, { name: '绿色', hex: '#6E8E6B' },
    { name: '蓝色', hex: '#5B7FA6' }, { name: '紫色', hex: '#8C7BA8' },
    { name: '多色', hex: 'multi' }
  ];

  var Cloud = window.WardrobeCloud || null;

  var state = {
    items: [], outfits: [],
    editingId: null, photoData: '', formColor: '黑色',
    pickedIds: [], detailId: null,
    filters: { q: '', category: '全部', color: '全部', season: '全部', sort: 'recent' },
    storageMode: 'idb'
  };

  var db = null;
  var toastTimer = null;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var uid = function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); };
  var colorHex = function (name) { var c = COLORS.find(function (x) { return x.name === name; }); return c ? c.hex : '#D8D4CC'; };
  var fmtMoney = function (n) { n = Number(n) || 0; return '¥' + (Math.round(n * 100) / 100).toLocaleString('zh-CN'); };
  var todayISO = function () { var d = new Date(); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); };
  var fmtDate = function (s) { return s ? String(s).replace(/-/g, '/') : '未记录'; };

  /* ---------- storage ---------- */

  function openDB() {
    return new Promise(function (resolve) {
      if (!('indexedDB' in window)) return resolve(null);
      var req;
      try { req = indexedDB.open('wardrobe-db', 1); } catch (e) { return resolve(null); }
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('outfits')) d.createObjectStore('outfits', { keyPath: 'id' });
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
  }

  function idbGetAll(store) {
    return new Promise(function (resolve) {
      try {
        var t = db.transaction(store, 'readonly');
        var r = t.objectStore(store).getAll();
        r.onsuccess = function () { resolve(r.result || []); };
        r.onerror = function () { resolve([]); };
      } catch (e) { resolve([]); }
    });
  }

  function idbPut(store, obj) {
    return new Promise(function (resolve) {
      try {
        var t = db.transaction(store, 'readwrite');
        t.objectStore(store).put(obj);
        t.oncomplete = function () { resolve(true); };
        t.onerror = function () { resolve(false); };
      } catch (e) { resolve(false); }
    });
  }

  function idbDelete(store, id) {
    return new Promise(function (resolve) {
      try {
        var t = db.transaction(store, 'readwrite');
        t.objectStore(store).delete(id);
        t.oncomplete = function () { resolve(true); };
        t.onerror = function () { resolve(false); };
      } catch (e) { resolve(false); }
    });
  }

  function idbClear(store) {
    return new Promise(function (resolve) {
      try {
        var t = db.transaction(store, 'readwrite');
        t.objectStore(store).clear();
        t.oncomplete = function () { resolve(true); };
        t.onerror = function () { resolve(false); };
      } catch (e) { resolve(false); }
    });
  }

  function persistLocal() {
    try {
      localStorage.setItem('wardrobe-data-v1', JSON.stringify({ items: state.items, outfits: state.outfits }));
      return true;
    } catch (e) {
      toast('本地空间不足，建议导出备份后清理旧照片');
      return false;
    }
  }

  async function loadAll() {
    db = await openDB();
    if (db) {
      state.storageMode = 'idb';
      state.items = await idbGetAll('items');
      state.outfits = await idbGetAll('outfits');
    } else {
      state.storageMode = 'local';
      try {
        var raw = JSON.parse(localStorage.getItem('wardrobe-data-v1') || '{}');
        state.items = Array.isArray(raw.items) ? raw.items : [];
        state.outfits = Array.isArray(raw.outfits) ? raw.outfits : [];
      } catch (e) { state.items = []; state.outfits = []; }
    }
  }

  /* 云端失败不影响本地使用：改动会进待上传队列，联网后自动补传 */
  function cloudPush(kind, type, payload) {
    if (!Cloud || !Cloud.configured() || !Cloud.status().signedIn) return Promise.resolve();
    return Cloud.push(kind, type, payload).catch(function () {});
  }

  function saveItem(item) {
    var i = state.items.findIndex(function (x) { return x.id === item.id; });
    if (i >= 0) state.items[i] = item; else state.items.push(item);
    var p = state.storageMode === 'idb' ? idbPut('items', item) : Promise.resolve(persistLocal());
    return p.then(function () { return cloudPush('items', 'upsert', item); });
  }

  function removeItem(id) {
    state.items = state.items.filter(function (x) { return x.id !== id; });
    var p = state.storageMode === 'idb' ? idbDelete('items', id) : Promise.resolve(persistLocal());
    return p.then(function () { return cloudPush('items', 'delete', id); });
  }

  function saveOutfit(o) {
    var i = state.outfits.findIndex(function (x) { return x.id === o.id; });
    if (i >= 0) state.outfits[i] = o; else state.outfits.push(o);
    var p = state.storageMode === 'idb' ? idbPut('outfits', o) : Promise.resolve(persistLocal());
    return p.then(function () { return cloudPush('outfits', 'upsert', o); });
  }

  function removeOutfit(id) {
    state.outfits = state.outfits.filter(function (x) { return x.id !== id; });
    var p = state.storageMode === 'idb' ? idbDelete('outfits', id) : Promise.resolve(persistLocal());
    return p.then(function () { return cloudPush('outfits', 'delete', id); });
  }

  /* ---------- image helpers ---------- */

  function compressImage(file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('读取失败')); };
      reader.onload = function (e) {
        var img = new Image();
        img.onerror = function () { reject(new Error('图片解析失败')); };
        img.onload = function () {
          var w = img.naturalWidth, h = img.naturalHeight;
          var scale = Math.min(1, maxSide / Math.max(w, h));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * scale));
          c.height = Math.max(1, Math.round(h * scale));
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', quality));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = Math.max(0, Math.min(255, (n >> 16) + amt));
    var g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
    var b = Math.max(0, Math.min(255, (n & 255) + amt));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function drawGarment(ctx, cat, fill, line) {
    ctx.fillStyle = fill; ctx.strokeStyle = line; ctx.lineWidth = 3;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    var p = new Path2D();
    if (cat === '下装') {
      p.moveTo(118, 110); p.lineTo(242, 110); p.lineTo(250, 375); p.lineTo(192, 375);
      p.lineTo(180, 240); p.lineTo(168, 375); p.lineTo(110, 375); p.closePath();
    } else if (cat === '连衣裙') {
      p.moveTo(132, 112); p.lineTo(160, 100); p.quadraticCurveTo(180, 124, 200, 100); p.lineTo(228, 112);
      p.lineTo(254, 168); p.lineTo(232, 188); p.lineTo(276, 366); p.lineTo(84, 366);
      p.lineTo(128, 188); p.lineTo(106, 168); p.closePath();
    } else if (cat === '鞋履') {
      p.moveTo(70, 300); p.quadraticCurveTo(80, 230, 145, 232); p.lineTo(170, 285);
      p.quadraticCurveTo(220, 300, 285, 305); p.quadraticCurveTo(300, 310, 298, 328);
      p.lineTo(72, 328); p.quadraticCurveTo(64, 316, 70, 300); p.closePath();
    } else if (cat === '包袋') {
      p.rect(95, 175, 170, 175);
      ctx.fill(p); ctx.stroke(p);
      ctx.beginPath(); ctx.moveTo(135, 180); ctx.quadraticCurveTo(135, 105, 180, 105);
      ctx.quadraticCurveTo(225, 105, 225, 180); ctx.stroke(); return;
    } else if (cat === '配饰') {
      ctx.beginPath(); ctx.arc(180, 240, 78, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(180, 240, 44, 0, Math.PI * 2); ctx.stroke(); return;
    } else if (cat === '外套') {
      p.moveTo(108, 118); p.lineTo(146, 102); p.quadraticCurveTo(180, 126, 214, 102); p.lineTo(252, 118);
      p.lineTo(288, 172); p.lineTo(256, 198); p.lineTo(242, 180); p.lineTo(242, 388);
      p.lineTo(118, 388); p.lineTo(118, 180); p.lineTo(104, 198); p.lineTo(72, 172); p.closePath();
      ctx.fill(p); ctx.stroke(p);
      ctx.beginPath(); ctx.moveTo(180, 122); ctx.lineTo(180, 388); ctx.stroke(); return;
    } else {
      p.moveTo(110, 122); p.lineTo(146, 106); p.quadraticCurveTo(180, 130, 214, 106); p.lineTo(250, 122);
      p.lineTo(284, 172); p.lineTo(254, 196); p.lineTo(240, 178); p.lineTo(240, 366);
      p.lineTo(120, 366); p.lineTo(120, 178); p.lineTo(106, 196); p.lineTo(76, 172); p.closePath();
    }
    ctx.fill(p); ctx.stroke(p);
    if (cat === '上衣' || cat === '其他') {
      ctx.beginPath(); ctx.moveTo(160, 108); ctx.quadraticCurveTo(180, 132, 200, 108); ctx.stroke();
    }
  }

  function makeDemoImage(cat, hex) {
    var c = document.createElement('canvas');
    c.width = 360; c.height = 480;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#F0EDE8'; ctx.fillRect(0, 0, 360, 480);
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.beginPath(); ctx.arc(180, 215, 145, 0, Math.PI * 2); ctx.fill();
    var fill = hex === 'multi' ? '#A98FA0' : hex;
    drawGarment(ctx, cat, fill, hex === 'multi' ? '#7C6373' : shade(hex, -28));
    return c.toDataURL('image/jpeg', .82);
  }

  /* ---------- demo data ---------- */

  function demoItems() {
    var seed = [
      ['米白色亚麻衬衫', '上衣', '米杏', '春', 'MUJI', 299, '2026-03-12', 24, '通勤,常穿'],
      ['黑色直筒西裤', '下装', '黑色', '四季', 'UNIQLO', 249, '2025-11-02', 31, '通勤'],
      ['燕麦色针织开衫', '外套', '米杏', '秋', 'COS', 690, '2025-09-20', 12, '温柔'],
      ['藏蓝色风衣', '外套', '蓝色', '春', 'Burberry', 3200, '2025-04-08', 6, '贵价,换季'],
      ['白色基础 T 恤', '上衣', '白色', '夏', 'UNIQLO', 99, '2026-05-18', 42, '百搭'],
      ['深灰阔腿牛仔裤', '下装', '灰色', '四季', 'Levi’s', 599, '2026-01-15', 18, '百搭'],
      ['碎花中长连衣裙', '连衣裙', '多色', '夏', '& Other Stories', 890, '2026-06-01', 3, '度假'],
      ['棕色乐福鞋', '鞋履', '棕色', '四季', 'Clarks', 780, '2025-10-11', 27, '通勤'],
      ['白色运动鞋', '鞋履', '白色', '四季', 'Nike', 649, '2026-02-22', 35, '常穿'],
      ['黑色通勤托特包', '包袋', '黑色', '四季', 'Longchamp', 1250, '2025-08-30', 22, '通勤'],
      ['酒红色羊绒围巾', '配饰', '红色', '冬', 'Uniqlo', 199, '2024-12-05', 1, '压箱底'],
      ['墨绿色棒球帽', '配饰', '绿色', '夏', 'New Era', 320, '2026-07-03', 0, '还没穿过']
    ];
    return seed.map(function (s, i) {
      var d = new Date(); d.setDate(d.getDate() - (i * 17 + 3));
      return {
        id: uid(), name: s[0], category: s[1], color: s[2], season: s[3], brand: s[4],
        price: s[5], purchaseDate: s[6], wearCount: s[7], tags: s[8].split(','),
        photo: makeDemoImage(s[1], colorHex(s[2])),
        lastWornAt: s[7] > 0 ? d.toISOString().slice(0, 10) : '',
        createdAt: Date.now() - i * 86400000
      };
    });
  }

  async function loadDemo() {
    if (state.items.length && !confirm('衣橱里已有 ' + state.items.length + ' 件单品，仍要追加示例数据吗？')) return;
    var list = demoItems();
    if (state.storageMode === 'idb') {
      for (var i = 0; i < list.length; i++) await idbPut('items', list[i]);
      state.items = state.items.concat(list);
    } else {
      state.items = state.items.concat(list);
      if (!persistLocal()) return;
    }
    if (Cloud && Cloud.status().signedIn) {
      try { await Cloud.upsertMany('items', list); } catch (e) { toast('云端上传失败，已暂存待补传'); }
    }
    renderAll();
    toast('已载入 ' + list.length + ' 件示例单品');
  }

  /* ---------- rendering ---------- */

  function photoMarkup(item, cls) {
    if (!item.photo || String(item.photo).indexOf('data:image') !== 0) {
      return '<span class="' + (cls || 'placeholder') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7.5a2 2 0 1 1 2-2c0 1.2-1 2-2 2v3.2"/><path d="M12 10.7 3.6 16a1 1 0 0 0 .5 1.8h15.8a1 1 0 0 0 .5-1.8L12 10.7Z"/></svg></span>';
    }
    return '<img src="' + esc(item.photo) + '" alt="' + esc(item.name) + '">';
  }

  function itemCard(item) {
    var hex = colorHex(item.color);
    var dot = hex === 'multi' ? 'conic-gradient(#D4537E,#EF9F27,#639922,#378ADD,#7F77DD,#D4537E)' : hex;
    return '<button class="item-card" data-id="' + esc(item.id) + '">' +
      '<div class="item-photo">' + photoMarkup(item) +
      '<span class="color-dot" style="background:' + dot + '"></span></div>' +
      '<div class="item-info"><div class="item-name">' + esc(item.name) + '</div>' +
      '<div class="item-sub">' + esc(item.category) + ' · ' + esc(item.color) + ' · ' + esc(item.season) + '</div>' +
      '<div class="item-foot"><span class="item-price">' + (item.price ? fmtMoney(item.price) : '—') + '</span>' +
      '<span class="wear-badge">穿过 ' + (Number(item.wearCount) || 0) + ' 次</span></div></div></button>';
  }

  function filteredItems() {
    var f = state.filters;
    var q = f.q.trim().toLowerCase();
    var list = state.items.filter(function (it) {
      if (f.category !== '全部' && it.category !== f.category) return false;
      if (f.color !== '全部' && it.color !== f.color) return false;
      if (f.season !== '全部' && it.season !== f.season && it.season !== '四季') return false;
      if (q) {
        var hay = [it.name, it.brand, it.category, it.color].concat(it.tags || []).join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    var idleKey = function (it) { return it.lastWornAt || new Date(it.createdAt || 0).toISOString().slice(0, 10); };
    list.sort(function (a, b) {
      if (f.sort === 'wear') return (b.wearCount || 0) - (a.wearCount || 0);
      if (f.sort === 'idle') return idleKey(a).localeCompare(idleKey(b));
      if (f.sort === 'priceHigh') return (b.price || 0) - (a.price || 0);
      if (f.sort === 'priceLow') return (a.price || 0) - (b.price || 0);
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    return list;
  }

  function renderCloset() {
    var list = filteredItems();
    $('itemGrid').innerHTML = list.map(itemCard).join('');
    $('closetSummary').textContent = '共 ' + state.items.length + ' 件单品' +
      (list.length !== state.items.length ? ' · 当前显示 ' + list.length + ' 件' : '');
    var empty = $('closetEmpty');
    if (state.items.length === 0) {
      empty.hidden = false;
      $('emptyTitle').textContent = '衣橱还是空的';
      $('emptyDesc').textContent = '添加第一件衣服，或者先载入示例数据看看效果';
      $('btnEmptyDemo').hidden = false;
    } else if (list.length === 0) {
      empty.hidden = false;
      $('emptyTitle').textContent = '没有符合条件的单品';
      $('emptyDesc').textContent = '试试换个关键词，或把筛选条件清空';
      $('btnEmptyDemo').hidden = true;
    } else {
      empty.hidden = true;
    }
  }

  function renderPicker() {
    var html = state.items.map(function (it) {
      var sel = state.pickedIds.indexOf(it.id) >= 0;
      var inner = it.photo && String(it.photo).indexOf('data:image') === 0
        ? '<img src="' + esc(it.photo) + '" alt="' + esc(it.name) + '">'
        : '<span class="ph"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M12 7.5a2 2 0 1 1 2-2c0 1.2-1 2-2 2v3.2"/><path d="M12 10.7 3.6 16a1 1 0 0 0 .5 1.8h15.8a1 1 0 0 0 .5-1.8L12 10.7Z"/></svg></span>';
      return '<button class="pick-card' + (sel ? ' is-selected' : '') + '" data-id="' + esc(it.id) + '">' +
        inner + '<span class="pick-check">✓</span><span class="pick-label">' + esc(it.name) + '</span></button>';
    }).join('');
    $('pickGrid').innerHTML = html || '<p class="rank-empty">衣橱还是空的，先去「添加」页录入几件吧</p>';
    $('pickCount').textContent = '已选 ' + state.pickedIds.length + ' 件';
  }

  function renderOutfits() {
    var list = state.outfits.slice().sort(function (a, b) { return (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0); });
    $('outfitCount').textContent = list.length ? '共 ' + list.length + ' 套' : '';
    $('outfitEmpty').hidden = list.length > 0;
    $('outfitList').innerHTML = list.map(function (o) {
      var names = (o.itemIds || []).map(function (id) {
        var it = state.items.find(function (x) { return x.id === id; });
        return it ? it.name : '已删除的单品';
      });
      var thumbs = (o.itemIds || []).slice(0, 4).map(function (id) {
        var it = state.items.find(function (x) { return x.id === id; });
        if (!it) return '<span class="thumb">?</span>';
        return '<span class="thumb">' + (it.photo && String(it.photo).indexOf('data:image') === 0 ? '<img src="' + esc(it.photo) + '" alt="">' : '') + '</span>';
      }).join('');
      return '<div class="outfit-row"><div class="outfit-thumbs">' + thumbs + '</div>' +
        '<div class="outfit-text"><strong>' + fmtDate(o.date) + (o.note ? ' · ' + esc(o.note) : '') + '</strong>' +
        '<span>' + esc(names.join(' + ')) + '</span></div>' +
        '<button class="row-del" data-id="' + esc(o.id) + '">删除</button></div>';
    }).join('');
  }

  function barRows(entries, total) {
    if (!entries.length) return '<p class="rank-empty">暂无数据</p>';
    var max = Math.max.apply(null, entries.map(function (e) { return e[1]; })) || 1;
    return entries.map(function (e) {
      return '<div class="bar-row"><span class="bar-label">' + esc(e[0]) + '</span>' +
        '<span class="bar-track"><span class="bar-fill" style="width:' + Math.round(e[1] / max * 100) + '%"></span></span>' +
        '<span class="bar-num">' + e[1] + (total ? ' 件' : '') + '</span></div>';
    }).join('');
  }

  function renderStats() {
    var items = state.items;
    var spend = items.reduce(function (s, it) { return s + (Number(it.price) || 0); }, 0);
    $('kpiCount').textContent = items.length;
    $('kpiSpend').textContent = fmtMoney(spend);
    $('kpiAvg').textContent = fmtMoney(items.length ? spend / items.length : 0);
    $('kpiOutfits').textContent = state.outfits.length;

    var byCat = {}, byColor = {};
    items.forEach(function (it) {
      byCat[it.category || '其他'] = (byCat[it.category || '其他'] || 0) + 1;
      byColor[it.color || '其他'] = (byColor[it.color || '其他'] || 0) + 1;
    });
    var sortEntries = function (o) { return Object.keys(o).map(function (k) { return [k, o[k]]; }).sort(function (a, b) { return b[1] - a[1]; }); };
    $('categoryBars').innerHTML = barRows(sortEntries(byCat), true);
    $('colorBars').innerHTML = barRows(sortEntries(byColor), true);

    var top = items.filter(function (it) { return (it.wearCount || 0) > 0; })
      .sort(function (a, b) { return b.wearCount - a.wearCount; }).slice(0, 5);
    $('topWorn').innerHTML = top.length ? top.map(function (it, i) {
      return '<div class="rank-row"><span class="rank-no">' + (i + 1) + '</span><span class="rank-name">' + esc(it.name) + '</span><span class="rank-val">' + it.wearCount + ' 次</span></div>';
    }).join('') : '<p class="rank-empty">还没有穿着记录，去「穿搭」页记一套吧</p>';

    var today = new Date();
    var idle = items.map(function (it) {
      var d = it.lastWornAt || (it.createdAt ? new Date(it.createdAt).toISOString().slice(0, 10) : todayISO());
      var days = Math.max(0, Math.floor((today - new Date(d + 'T00:00:00')) / 86400000));
      return { it: it, days: (it.wearCount || 0) === 0 ? Infinity : days, never: (it.wearCount || 0) === 0 };
    }).sort(function (a, b) { return b.days - a.days; }).slice(0, 5);
    $('leastWorn').innerHTML = idle.length ? idle.map(function (o) {
      return '<div class="rank-row"><span class="rank-no">·</span><span class="rank-name">' + esc(o.it.name) + '</span>' +
        '<span class="rank-val">' + (o.never ? '从未穿过' : o.days + ' 天没穿') + '</span></div>';
    }).join('') : '<p class="rank-empty">暂无数据</p>';

    renderStorageInfo();
    renderBackupRemind();
  }

  function fmtSize(bytes) {
    if (typeof bytes !== 'number') return '无法获取';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function renderStorageInfo() {
    var mode = state.storageMode === 'idb'
      ? 'IndexedDB · wardrobe-db'
      : 'localStorage · wardrobe-data-v1';
    var origin = location.origin || '本地文件';
    var isLan = /^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(origin);
    var isFile = origin === 'null' || /^file:/.test(origin);
    var cs = Cloud ? Cloud.status() : { configured: false, signedIn: false, email: '', pending: 0 };
    var cloudText = !cs.configured ? '未启用（仅本机）'
      : (!cs.signedIn ? '已配置，未登录'
        : '已登录 · ' + (cs.email || '') + (cs.pending ? ' · ' + cs.pending + ' 条待传' : ''));
    var rows = [
      ['存储位置', mode],
      ['归属地址', origin],
      ['当前数据', state.items.length + ' 件单品 / ' + state.outfits.length + ' 套穿搭'],
      ['云端同步', cloudText],
      ['占用空间', '正在计算…']
    ];
    $('storageList').innerHTML = rows.map(function (r, i) {
      return '<div><dt>' + esc(r[0]) + '</dt><dd' + (i === 4 ? ' data-key="usage"' : '') + '>' + esc(r[1]) + '</dd></div>';
    }).join('');

    var warn;
    if (isLan) {
      warn = '当前是局域网地址。数据按「地址」隔离保存：电脑 IP 一变，主屏幕图标就打不开，用新地址打开看到的也是另一份空衣橱。换网络本身不会删数据，但建议改用固定域名的 HTTPS 链接。';
    } else if (isFile) {
      warn = '当前以本地文件方式打开，可用容量较小且离线缓存不可用，建议通过 http(s) 地址访问。';
    } else if (/^http:/.test(origin)) {
      warn = '当前是 HTTP 地址，离线缓存不可用；数据按此地址隔离保存。';
    } else {
      warn = '当前是 HTTPS 地址，数据按此域名隔离保存。只要域名不变，换 WiFi、换蜂窝网络都不会丢。';
    }
    if (cs.signedIn) warn += ' 已启用云端同步，数据同时保存在你的账号下，换设备登录后会自动取回。';
    $('storageWarn').textContent = warn;
    $('storageWarn').hidden = false;

    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) {
        var el = $('storageList').querySelector('[data-key="usage"]');
        if (el) el.textContent = fmtSize(est.usage) + '（可用配额 ' + fmtSize(est.quota) + '）';
      }).catch(function () { setUsageText(localEstimate()); });
    } else {
      setUsageText(localEstimate());
    }
  }

  function localEstimate() {
    try {
      var raw = JSON.stringify({ items: state.items, outfits: state.outfits });
      var bytes = (window.Blob ? new Blob([raw]).size : raw.length * 2);
      return '约 ' + fmtSize(bytes) + '（按数据内容估算）';
    } catch (e) { return '暂无法估算'; }
  }

  function setUsageText(text) {
    var el = $('storageList').querySelector('[data-key="usage"]');
    if (el) el.textContent = text;
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('地址已复制'); }
    catch (e) { toast('复制失败，请手动查看地址'); }
    document.body.removeChild(ta);
  }

  function renderAll() { renderCloset(); renderPicker(); renderOutfits(); renderStats(); }

  /* ---------- form ---------- */

  function fillSelects() {
    var opts = function (arr) { return arr.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join(''); };
    $('fCategory').innerHTML = opts(CATEGORIES);
    $('fSeason').innerHTML = opts(SEASONS);
    $('filterCategory').innerHTML = opts(['全部'].concat(CATEGORIES));
    $('filterColor').innerHTML = opts(['全部'].concat(COLORS.map(function (c) { return c.name; })));
    $('filterSeason').innerHTML = opts(['全部'].concat(SEASONS));
    $('colorPicker').innerHTML = COLORS.map(function (c) {
      var bg = c.hex === 'multi' ? '' : 'background:' + c.hex + ';';
      return '<button type="button" class="color-option' + (c.hex === 'multi' ? ' is-multi' : '') + '" data-color="' + esc(c.name) + '" title="' + esc(c.name) + '" style="' + bg + '"></button>';
    }).join('');
    setFormColor('黑色');
  }

  function setFormColor(name) {
    state.formColor = name;
    Array.prototype.forEach.call($('colorPicker').children, function (b) {
      b.classList.toggle('is-active', b.dataset.color === name);
    });
  }

  function setPhoto(data) {
    state.photoData = data || '';
    var img = $('photoPreview'), hint = $('photoHint');
    if (state.photoData) {
      img.src = state.photoData; img.hidden = false; hint.hidden = true; $('photoRemove').hidden = false;
    } else {
      img.removeAttribute('src'); img.hidden = true; hint.hidden = false; $('photoRemove').hidden = true;
    }
  }

  function resetForm() {
    state.editingId = null;
    $('itemForm').reset();
    $('fDate').value = todayISO();
    $('fWear').value = 0;
    setFormColor('黑色');
    setPhoto('');
    $('photoInput').value = '';
    $('formTitle').textContent = '添加单品';
    $('btnSave').textContent = '保存到衣橱';
    $('btnDelete').hidden = true;
  }

  function startEdit(id) {
    var it = state.items.find(function (x) { return x.id === id; });
    if (!it) return;
    state.editingId = id;
    $('fName').value = it.name || '';
    $('fCategory').value = it.category || '上衣';
    $('fSeason').value = it.season || '四季';
    $('fBrand').value = it.brand || '';
    $('fPrice').value = it.price || '';
    $('fDate').value = it.purchaseDate || '';
    $('fWear').value = it.wearCount || 0;
    $('fTags').value = (it.tags || []).join(', ');
    setFormColor(it.color || '黑色');
    setPhoto(it.photo || '');
    $('formTitle').textContent = '编辑单品';
    $('btnSave').textContent = '保存修改';
    $('btnDelete').hidden = false;
    closeDetail();
    switchPage('add');
  }

  function collectForm() {
    return {
      id: state.editingId || uid(),
      name: $('fName').value.trim(),
      category: $('fCategory').value,
      season: $('fSeason').value,
      color: state.formColor,
      brand: $('fBrand').value.trim(),
      price: Number($('fPrice').value) || 0,
      purchaseDate: $('fDate').value,
      wearCount: Math.max(0, Number($('fWear').value) || 0),
      tags: $('fTags').value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean),
      photo: state.photoData,
      lastWornAt: (state.editingId && (state.items.find(function (x) { return x.id === state.editingId; }) || {}).lastWornAt) || '',
      createdAt: (state.editingId && (state.items.find(function (x) { return x.id === state.editingId; }) || {}).createdAt) || Date.now()
    };
  }

  /* ---------- detail ---------- */

  function openDetail(id) {
    var it = state.items.find(function (x) { return x.id === id; });
    if (!it) return;
    state.detailId = id;
    $('detailPhoto').innerHTML = photoMarkup(it);
    $('detailName').textContent = it.name;
    var pills = ['<span class="pill accent">' + esc(it.category) + '</span>',
      '<span class="pill">' + esc(it.color) + '</span>', '<span class="pill">' + esc(it.season) + '</span>']
      .concat((it.tags || []).map(function (t) { return '<span class="pill">' + esc(t) + '</span>'; }));
    $('detailTags').innerHTML = pills.join('');
    var rows = [
      ['品牌', it.brand || '未填写'], ['购入价', it.price ? fmtMoney(it.price) : '未填写'],
      ['购入日期', fmtDate(it.purchaseDate)], ['已穿次数', (it.wearCount || 0) + ' 次'],
      ['最近穿着', fmtDate(it.lastWornAt)], ['加入时间', fmtDate(new Date(it.createdAt || Date.now()).toISOString().slice(0, 10))]
    ];
    $('detailList').innerHTML = rows.map(function (r) { return '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>'; }).join('');
    $('detailModal').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeDetail() {
    $('detailModal').hidden = true;
    document.body.style.overflow = '';
    state.detailId = null;
  }

  /* ---------- ui helpers ---------- */

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2400);
  }

  function switchPage(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.page'), function (p) {
      p.classList.toggle('is-active', p.id === 'page-' + name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('is-active', b.dataset.page === name);
    });
    if (name === 'closet') renderCloset();
    if (name === 'outfit') { renderPicker(); renderOutfits(); }
    if (name === 'stats') renderStats();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------- data management ---------- */

  function exportData() {
    var payload = { app: '我的衣橱', version: 1, exportedAt: new Date().toISOString(), items: state.items, outfits: state.outfits };
    var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '我的衣橱备份-' + todayISO() + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    try { localStorage.setItem('wardrobe-last-backup', todayISO()); } catch (e) {}
    renderBackupRemind();
    toast('备份已导出');
  }

  function renderBackupRemind() {
    var el = $('backupRemind');
    if (!el) return;
    var count = state.items.length + state.outfits.length;
    if (!count) { el.hidden = true; return; }
    var last = '';
    try { last = localStorage.getItem('wardrobe-last-backup') || ''; } catch (e) {}
    if (!last) {
      el.textContent = '⚠️ 你还没有导出过备份。数据只存在本机，建议现在点「导出备份」，并把文件微信发送给自己保存一份。';
    } else {
      var days = Math.max(0, Math.floor((new Date(todayISO() + 'T00:00:00') - new Date(last + 'T00:00:00')) / 86400000));
      if (days >= 7) {
        el.textContent = '⚠️ 距上次备份已 ' + days + ' 天（' + fmtDate(last) + '）。建议点「导出备份」，微信发给自己留存。';
      } else {
        el.textContent = '✅ 上次备份：' + fmtDate(last) + '（' + days + ' 天前），保持这个习惯就好。';
      }
    }
    el.hidden = false;
  }

  async function importData(file) {
    try {
      var text = await file.text();
      var data = JSON.parse(text);
      if (!data || !Array.isArray(data.items)) throw new Error('格式不对');
      if (!confirm('导入将覆盖当前 ' + state.items.length + ' 件单品和 ' + state.outfits.length + ' 套穿搭，确定继续吗？')) return;
      if (state.storageMode === 'idb') { await idbClear('items'); await idbClear('outfits'); }
      state.items = data.items;
      state.outfits = Array.isArray(data.outfits) ? data.outfits : [];
      if (state.storageMode === 'idb') {
        for (var i = 0; i < state.items.length; i++) await idbPut('items', state.items[i]);
        for (var j = 0; j < state.outfits.length; j++) await idbPut('outfits', state.outfits[j]);
      } else persistLocal();
      if (Cloud && Cloud.status().signedIn) {
        try { await Cloud.replaceAll(state.items, state.outfits); }
        catch (e) { renderAll(); toast('已导入本机，云端同步失败：' + e.message); return; }
      }
      renderAll();
      toast('已导入 ' + state.items.length + ' 件单品');
    } catch (e) { toast('导入失败：' + e.message); }
  }

  async function clearAll() {
    var cloudOn = !!(Cloud && Cloud.status().signedIn);
    if (!confirm('这会删除全部单品和穿搭记录' + (cloudOn ? '（包括云端）' : '') + '，且无法撤销。建议先导出备份。确定清空吗？')) return;
    if (state.storageMode === 'idb') { await idbClear('items'); await idbClear('outfits'); }
    state.items = []; state.outfits = []; state.pickedIds = [];
    if (state.storageMode === 'local') persistLocal();
    if (cloudOn) {
      try { await Cloud.deleteAllRows(); } catch (e) { toast('本机已清空，云端清除失败：' + e.message); }
    }
    resetForm(); renderAll();
    toast('数据已清空');
  }

  /* ---------- cloud ui ---------- */

  function cloudMsg(text, isError) {
    var el = $('cloudMsg');
    el.textContent = text || '';
    el.hidden = !text;
    el.style.background = isError ? '#FBEDE9' : '';
    el.style.color = isError ? '#A8452F' : '';
  }

  function renderCloudUI() {
    if (!Cloud) return;
    var s = Cloud.status();
    $('cloudNoConfig').hidden = s.configured;
    $('cloudSignedOut').hidden = !s.configured || s.signedIn;
    $('cloudSignedIn').hidden = !s.configured || !s.signedIn;
    $('btnCloudResetConfig').hidden = !s.configured;
    var badge = $('cloudState');
    badge.classList.remove('on');
    if (!s.configured) badge.textContent = '未启用';
    else if (!s.signedIn) badge.textContent = '未登录';
    else {
      badge.textContent = s.pending ? s.pending + ' 条待补传' : '已连接';
      badge.classList.add('on');
    }
    $('cloudEmailText').textContent = s.email;
    var when = s.lastSync ? new Date(s.lastSync).toLocaleString('zh-CN') : '尚未同步';
    $('cloudMeta').textContent = '最后同步：' + when +
      (s.pending ? ' · ' + s.pending + ' 条改动待上传（联网后自动补传）' : '');
  }

  async function applyCloudData(items, outfits) {
    state.items = items;
    state.outfits = outfits;
    state.pickedIds = [];
    if (state.storageMode === 'idb') {
      await idbClear('items'); await idbClear('outfits');
      for (var i = 0; i < items.length; i++) await idbPut('items', items[i]);
      for (var j = 0; j < outfits.length; j++) await idbPut('outfits', outfits[j]);
    } else persistLocal();
  }

  async function afterSignIn() {
    cloudMsg('登录成功，正在与云端合并数据…');
    try {
      var r = await Cloud.initialSync(state.items, state.outfits);
      await applyCloudData(r.items, r.outfits);
      cloudMsg(r.message);
      toast(r.message);
    } catch (e) {
      cloudMsg('登录成功，但同步失败：' + e.message + '（本机数据未受影响）', true);
    }
    $('cloudPassword').value = '';
    renderCloudUI(); renderAll();
  }

  async function cloudAuth(isSignUp) {
    var email = $('cloudEmail').value.trim();
    var pw = $('cloudPassword').value;
    if (!/^\S+@\S+\.\S+$/.test(email)) { cloudMsg('请填一个有效的邮箱地址', true); return; }
    if (!pw || pw.length < 6) { cloudMsg('密码至少 6 位', true); return; }
    cloudMsg('正在处理…');
    try {
      if (isSignUp) {
        var r = await Cloud.signUp(email, pw);
        if (r.signedIn) await afterSignIn(); else cloudMsg(r.message);
      } else {
        await Cloud.signIn(email, pw);
        await afterSignIn();
      }
    } catch (e) {
      var m = e && e.message ? String(e.message) : '未知错误';
      if (/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(m)) {
        m = '连不上云端（浏览器无法完成请求）。请依次检查：① 当前网络能否访问 supabase.co —— 国内网络常见 TLS 连接被重置，这一步卡住时换网络重试；② Project URL 是否只有 https://xxx.supabase.co，不要带 /rest/v1/（现在会自动纠正）；③ Supabase 项目是否已初始化完成。若换网络仍不通，建议改用国内可直连的云服务。';
      } else if (/Invalid login|credentials|Email not confirmed/i.test(m)) {
        m = '登录被拒绝：' + m + '。若为注册后首次登录，去邮箱点确认链接，或在 Supabase 的 Authentication → Providers → Email 里关掉 Confirm email。';
      }
      cloudMsg('失败：' + m, true);
    }
    renderCloudUI();
  }

  /* ---------- events ---------- */

  function bind() {
    $('tabbar').addEventListener('click', function (e) {
      var b = e.target.closest('.tab');
      if (b) switchPage(b.dataset.page);
    });

    ['btnEmptyAdd', 'fabAdd'].forEach(function (id) {
      $(id).addEventListener('click', function () { resetForm(); switchPage('add'); });
    });
    ['btnEmptyDemo', 'btnDemo'].forEach(function (id) { $(id).addEventListener('click', loadDemo); });

    ['filterCategory', 'filterColor', 'filterSeason', 'filterSort'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        state.filters.category = $('filterCategory').value;
        state.filters.color = $('filterColor').value;
        state.filters.season = $('filterSeason').value;
        state.filters.sort = $('filterSort').value;
        renderCloset();
      });
    });
    $('searchInput').addEventListener('input', function (e) { state.filters.q = e.target.value; renderCloset(); });

    $('itemGrid').addEventListener('click', function (e) {
      var card = e.target.closest('.item-card');
      if (card) openDetail(card.dataset.id);
    });

    $('colorPicker').addEventListener('click', function (e) {
      var b = e.target.closest('.color-option');
      if (b) setFormColor(b.dataset.color);
    });
    $('photoDrop').addEventListener('click', function () { $('photoInput').click(); });
    $('photoRemove').addEventListener('click', function () { setPhoto(''); $('photoInput').value = ''; });
    $('photoInput').addEventListener('change', async function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      if (!/^image\//.test(f.type)) { toast('请选择图片文件'); return; }
      try {
        var max = state.storageMode === 'local' ? 700 : 1100;
        var q = state.storageMode === 'local' ? .72 : .82;
        setPhoto(await compressImage(f, max, q));
        toast('照片已压缩，保存后写入本机');
      } catch (err) { toast(err.message); }
    });

    $('itemForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var wasEditing = !!state.editingId;
      var item = collectForm();
      if (!item.name) { toast('请填一下名称'); return; }
      await saveItem(item);
      resetForm(); renderAll(); switchPage('closet');
      toast(wasEditing ? '已保存修改' : '已加入衣橱');
    });
    $('btnReset').addEventListener('click', function () { resetForm(); toast('已清空表单'); });
    $('btnDelete').addEventListener('click', async function () {
      if (!state.editingId || !confirm('确定删除这件单品吗？')) return;
      await removeItem(state.editingId);
      state.pickedIds = state.pickedIds.filter(function (id) { return id !== state.editingId; });
      resetForm(); renderAll(); switchPage('closet'); toast('已删除');
    });

    $('detailClose').addEventListener('click', closeDetail);
    $('detailModal').addEventListener('click', function (e) { if (e.target === $('detailModal')) closeDetail(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('detailModal').hidden) closeDetail(); });
    $('btnDetailEdit').addEventListener('click', function () { if (state.detailId) startEdit(state.detailId); });
    $('btnDetailDelete').addEventListener('click', async function () {
      if (!state.detailId || !confirm('确定删除这件单品吗？')) return;
      await removeItem(state.detailId); closeDetail(); renderAll(); toast('已删除');
    });
    $('btnDetailWear').addEventListener('click', async function () {
      var it = state.items.find(function (x) { return x.id === state.detailId; });
      if (!it) return;
      it.wearCount = (it.wearCount || 0) + 1;
      it.lastWornAt = todayISO();
      await saveItem(it);
      openDetail(it.id); renderAll(); toast('已记录一次穿着');
    });

    $('pickGrid').addEventListener('click', function (e) {
      var card = e.target.closest('.pick-card');
      if (!card) return;
      var id = card.dataset.id, i = state.pickedIds.indexOf(id);
      if (i >= 0) { state.pickedIds.splice(i, 1); card.classList.remove('is-selected'); }
      else { state.pickedIds.push(id); card.classList.add('is-selected'); }
      $('pickCount').textContent = '已选 ' + state.pickedIds.length + ' 件';
    });
    $('btnClearPick').addEventListener('click', function () { state.pickedIds = []; renderPicker(); });
    $('btnSaveOutfit').addEventListener('click', async function () {
      if (!state.pickedIds.length) { toast('先选几件单品吧'); return; }
      var date = $('outfitDate').value || todayISO();
      await saveOutfit({ id: uid(), date: date, note: $('outfitNote').value.trim(), itemIds: state.pickedIds.slice(), createdAt: Date.now() });
      for (var i = 0; i < state.pickedIds.length; i++) {
        var it = state.items.find(function (x) { return x.id === state.pickedIds[i]; });
        if (!it) continue;
        it.wearCount = (it.wearCount || 0) + 1;
        it.lastWornAt = date;
        await saveItem(it);
      }
      state.pickedIds = []; $('outfitNote').value = '';
      renderAll(); toast('这套穿搭已记下');
    });
    $('outfitList').addEventListener('click', async function (e) {
      var b = e.target.closest('.row-del');
      if (!b || !confirm('删除这条穿搭记录？对应单品的穿着次数会减 1。')) return;
      var o = state.outfits.find(function (x) { return x.id === b.dataset.id; });
      if (o) {
        for (var i = 0; i < (o.itemIds || []).length; i++) {
          var it = state.items.find(function (x) { return x.id === o.itemIds[i]; });
          if (!it) continue;
          it.wearCount = Math.max(0, (it.wearCount || 0) - 1);
          var rest = state.outfits.filter(function (x) { return x.id !== o.id && (x.itemIds || []).indexOf(it.id) >= 0; });
          it.lastWornAt = rest.length ? rest.map(function (x) { return x.date; }).sort().pop() : '';
          await saveItem(it);
        }
      }
      await removeOutfit(b.dataset.id);
      renderAll(); toast('记录已删除');
    });

    ['btnExport', 'btnExportTop'].forEach(function (id) { $(id).addEventListener('click', exportData); });
    $('btnImport').addEventListener('click', function () { $('importInput').click(); });
    $('importInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) importData(f);
      e.target.value = '';
    });
    $('btnClearAll').addEventListener('click', clearAll);
    $('btnCopyOrigin').addEventListener('click', function () {
      var text = location.href.split('#')[0].split('?')[0];
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('地址已复制'); }, function () { fallbackCopy(text); });
      } else fallbackCopy(text);
    });

    $('btnCloudSaveConfig').addEventListener('click', function () {
      var u = $('cfgUrl').value.trim();
      var k = $('cfgKey').value.trim();
      if (!/^https?:\/\//.test(u)) { cloudMsg('Project URL 要以 https:// 开头', true); return; }
      if (!k || k.length < 20) { cloudMsg('请填完整的 anon public key', true); return; }
      Cloud.setConfig(u, k);
      cloudMsg('配置已保存，现在可以注册或登录了');
      renderCloudUI(); renderAll();
    });
    $('btnCloudResetConfig').addEventListener('click', function () {
      if (!confirm('清除本机保存的云端配置并退出登录？本机衣橱数据不会删除。')) return;
      Cloud.clearConfig();
      $('cfgUrl').value = ''; $('cfgKey').value = '';
      cloudMsg('已清除配置，可重新填写');
      renderCloudUI(); renderAll();
    });
    $('btnCloudSignIn').addEventListener('click', function () { cloudAuth(false); });
    $('btnCloudSignUp').addEventListener('click', function () { cloudAuth(true); });
    $('btnCloudSignOut').addEventListener('click', function () {
      if (!confirm('退出后本机数据仍保留，但不再自动同步。确定退出吗？')) return;
      Cloud.signOut().then(function () {
        cloudMsg('已退出登录，数据仍保留在本机');
        renderCloudUI(); renderAll();
      }).catch(function (e) { cloudMsg('退出失败：' + e.message, true); });
    });
    $('btnCloudSyncNow').addEventListener('click', function () {
      if (!Cloud.status().signedIn) return;
      if (!confirm('以本机数据为准覆盖云端？云端上多出来的记录会被清掉。')) return;
      cloudMsg('正在同步…');
      Cloud.replaceAll(state.items, state.outfits).then(function () {
        cloudMsg('已把本机 ' + state.items.length + ' 件单品完整同步到云端');
        renderCloudUI();
      }).catch(function (e) { cloudMsg('同步失败：' + e.message, true); });
    });
    $('btnCloudPull').addEventListener('click', async function () {
      if (!Cloud.status().signedIn) return;
      if (!confirm('用云端数据覆盖本机？本机上未同步的改动会被替换。')) return;
      cloudMsg('正在从云端拉取…');
      try {
        var c = await Cloud.pullAll();
        await applyCloudData(c.items, c.outfits);
        renderAll(); renderCloudUI();
        cloudMsg('已从云端拉取 ' + c.items.length + ' 件单品');
      } catch (e) { cloudMsg('拉取失败：' + e.message, true); }
    });
  }

  /* ---------- boot ---------- */

  async function init() {
    fillSelects();
    bind();
    await loadAll();
    resetForm();
    $('outfitDate').value = todayISO();
    renderAll();
    var params = new URLSearchParams(location.search);
    if (params.get('demo') === '1' && state.items.length === 0) await loadDemo();
    var hashPage = (location.hash || '').replace('#', '');
    if (['closet', 'add', 'outfit', 'stats'].indexOf(hashPage) >= 0) switchPage(hashPage);

    if (Cloud) {
      Cloud.onStatus(function () { renderCloudUI(); renderStats(); });
      renderCloudUI();
      window.addEventListener('online', function () {
        Cloud.flush().then(function (n) {
          if (n) { renderCloudUI(); toast('已自动补传 ' + n + ' 条改动'); }
        }).catch(function () {});
      });
      if (Cloud.status().signedIn && navigator.onLine) Cloud.flush().catch(function () {});
    }

    if (state.storageMode === 'local') {
      console.info('[我的衣橱] 当前使用 localStorage 存储（IndexedDB 不可用），建议通过 http(s) 打开以启用更大容量。');
    }
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  init();
})();
