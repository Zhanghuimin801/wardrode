/* smart.js — 电子衣橱 v4 智能工作台
   全部在本机浏览器里运算：颜色识别、去背景、裁剪、搭配推荐、购入判断。
   不调用任何 AI 接口、不依赖任何 CDN，因此永久免费、断网可用、不上传你的照片。 */
(function () {
  'use strict';

  var App = window.WardrobeApp;
  if (!App) return;

  var $ = App.$;
  var esc = App.esc;
  var COLORS = App.COLORS;
  var NEUTRAL = ['黑色', '白色', '灰色', '米杏', '棕色'];
  var WARM = ['红色', '粉色', '橙色', '黄色', '米杏', '棕色'];
  var COOL = ['蓝色', '绿色', '紫色', '灰色'];
  var WX = { 0: '晴', 1: '多云', 2: '多云', 3: '阴', 45: '有雾', 48: '有雾',
    51: '小雨', 53: '小雨', 55: '小雨', 61: '小雨', 63: '中雨', 65: '大雨',
    71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '阵雨', 82: '阵雨',
    95: '雷雨', 96: '雷雨', 99: '雷雨' };
  var BAND_LABEL = { cold: '很冷', cool: '偏凉', mild: '舒适', hot: '炎热' };

  var weather = { temp: null, code: null, label: '', band: '' };
  var buyPhoto = '';
  var crop = { img: null, zoom: 1, ox: 0, oy: 0, dragging: false, sx: 0, sy: 0, base: 1 };
  var pendingNewPhoto = false;

  /* ---------------- 基础工具 ---------------- */

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('图片读取失败')); };
      img.src = src;
    });
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    var d = max - min;
    if (d > 0.0001) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = ((b - r) / d + 2);
      else h = ((r - g) / d + 4);
      h *= 60;
    }
    return { h: h, s: s, l: l };
  }

  function nearestColor(r, g, b) {
    var src = rgbToHsl(r, g, b), best = '黑色', bestD = Infinity;
    COLORS.forEach(function (c) {
      if (c.hex === 'multi') return;
      var cr = parseInt(c.hex.slice(1, 3), 16),
          cg = parseInt(c.hex.slice(3, 5), 16),
          cb = parseInt(c.hex.slice(5, 7), 16);
      var t = rgbToHsl(cr, cg, cb);
      var dh = Math.min(Math.abs(src.h - t.h), 360 - Math.abs(src.h - t.h)) / 180;
      var hw = Math.min(src.s, t.s) * 1.7;
      var d = dh * hw + Math.abs(src.s - t.s) * 0.6 + Math.abs(src.l - t.l) * 1.3;
      if (d < bestD) { bestD = d; best = c.name; }
    });
    return best;
  }

  /* 取图片中心区域的主色：量化分桶，跳过近白背景 */
  function detectDominant(dataUrl) {
    return loadImage(dataUrl).then(function (img) {
      var S = 64, c = document.createElement('canvas');
      c.width = S; c.height = S;
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, S, S);
      var d = ctx.getImageData(0, 0, S, S).data;
      var buckets = {}, found = false;

      function scan(lo, hi, skipWhite) {
        var bk = {};
        for (var y = lo; y < hi; y++) {
          for (var x = lo; x < hi; x++) {
            var i = (y * S + x) * 4;
            var r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
            if (a < 128) continue;
            var lum = (r + g + b) / 3, sat = Math.max(r, g, b) - Math.min(r, g, b);
            if (skipWhite && lum > 236 && sat < 20) continue;
            if (skipWhite && lum > 248) continue;
            var key = (r >> 5) + ',' + (g >> 5) + ',' + (b >> 5);
            if (!bk[key]) bk[key] = { r: 0, g: 0, b: 0, n: 0 };
            bk[key].r += r; bk[key].g += g; bk[key].b += b; bk[key].n++;
          }
        }
        return bk;
      }

      buckets = scan(10, 54, true);
      Object.keys(buckets).forEach(function (k) { if (buckets[k].n > 6) found = true; });
      if (!found) buckets = scan(8, 56, false);
      var best = null;
      Object.keys(buckets).forEach(function (k) {
        if (!best || buckets[k].n > best.n) best = buckets[k];
      });
      if (!best) throw new Error('没认出颜色');
      return nearestColor(best.r / best.n, best.g / best.n, best.b / best.n);
    });
  }

  /* 轻量去背景：四角同色且偏浅时，把接近背景的像素变透明。
     不是 AI 抠图，但对电商白底图效果很好，且完全不卡。 */
  function removeBackground(dataUrl) {
    return loadImage(dataUrl).then(function (img) {
      var max = 800;
      var scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      var w = Math.max(1, Math.round(img.naturalWidth * scale));
      var h = Math.max(1, Math.round(img.naturalHeight * scale));
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      var id = ctx.getImageData(0, 0, w, h), d = id.data;

      function avg(x0, y0, n) {
        var r = 0, g = 0, b = 0, k = 0;
        for (var y = y0; y < Math.min(h, y0 + n); y++) {
          for (var x = x0; x < Math.min(w, x0 + n); x++) {
            var i = (y * w + x) * 4;
            r += d[i]; g += d[i + 1]; b += d[i + 2]; k++;
          }
        }
        return k ? [r / k, g / k, b / k] : [255, 255, 255];
      }
      var corners = [avg(0, 0, 8), avg(w - 8, 0, 8), avg(0, h - 8, 8), avg(w - 8, h - 8, 8)];
      var bg = [0, 0, 0];
      corners.forEach(function (p) { bg[0] += p[0] / 4; bg[1] += p[1] / 4; bg[2] += p[2] / 4; });
      var lum = (bg[0] + bg[1] + bg[2]) / 3;
      var consistent = corners.every(function (p) {
        return Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) < 90;
      });
      if (!consistent || lum < 185) return null;

      for (var p = 0; p < d.length; p += 4) {
        var dist = Math.abs(d[p] - bg[0]) + Math.abs(d[p + 1] - bg[1]) + Math.abs(d[p + 2] - bg[2]);
        if (dist < 46) d[p + 3] = 0;
        else if (dist < 100) d[p + 3] = Math.round(d[p + 3] * (dist - 46) / 54);
      }
      ctx.putImageData(id, 0, 0);
      try {
        var webp = c.toDataURL('image/webp', .82);
        if (webp.indexOf('data:image/webp') === 0) return webp;
      } catch (e) {}
      return c.toDataURL('image/png');
    });
  }

  function showHint(text, kind) {
    var el = $('detectHint');
    el.textContent = text;
    el.className = 'detect-hint' + (kind ? ' is-' + kind : '');
  }

  function syncPhotoTools() {
    var has = !!App.getState().photoData;
    ['btnCrop', 'btnCutout', 'btnDetectColor'].forEach(function (id) { $(id).disabled = !has; });
    if (!has) showHint('上传照片后，颜色会自动识别并预填；识别错了点一下色块就能改。');
  }

  function autoDetectColor(manual) {
    var data = App.getState().photoData;
    if (!data) { App.toast('请先上传一张照片'); return; }
    showHint('正在识别…');
    detectDominant(data).then(function (name) {
      App.setFormColor(name);
      showHint('已识别为「' + name + '」，不对的话点下面的色块改一下。', 'ok');
    }).catch(function () {
      showHint('这张图没认出颜色，请手动点色块选一下。', 'fail');
    });
  }

  /* ---------------- 手动裁剪 ---------------- */

  function drawCrop() {
    var stage = $('cropStage'), canvas = $('cropCanvas');
    if (!crop.img) return;
    var W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#F0EDE8';
    ctx.fillRect(0, 0, W, H);

    var iw = crop.img.naturalWidth, ih = crop.img.naturalHeight;
    var fw = W * .76, fh = H * .76;
    crop.base = Math.max(fw / iw, fh / ih);
    var dw = iw * crop.base * crop.zoom, dh = ih * crop.base * crop.zoom;
    var maxOx = Math.max(0, (dw - fw) / 2), maxOy = Math.max(0, (dh - fh) / 2);
    crop.ox = Math.max(-maxOx, Math.min(maxOx, crop.ox));
    crop.oy = Math.max(-maxOy, Math.min(maxOy, crop.oy));
    var x = (W - dw) / 2 + crop.ox, y = (H - dh) / 2 + crop.oy;
    ctx.drawImage(crop.img, x, y, dw, dh);
    crop._draw = { x: x, y: y, dw: dw, dh: dh, iw: iw, ih: ih, W: W, H: H };
  }

  function openCrop() {
    var data = App.getState().photoData;
    if (!data) { App.toast('请先上传一张照片'); return; }
    loadImage(data).then(function (img) {
      crop.img = img; crop.zoom = 1; crop.ox = 0; crop.oy = 0;
      $('cropZoom').value = 100;
      $('cropModal').hidden = false;
      document.body.style.overflow = 'hidden';
      drawCrop();
      requestAnimationFrame(drawCrop);
    }).catch(function () { App.toast('图片读取失败'); });
  }

  function closeCrop() {
    $('cropModal').hidden = true;
    document.body.style.overflow = '';
    crop.img = null;
  }

  function applyCrop() {
    if (!crop.img || !crop._draw) return;
    var g = crop._draw;
    var fx = g.W * .12, fy = g.H * .12, fw = g.W * .76, fh = g.H * .76;
    var rx = g.iw / g.dw, ry = g.ih / g.dh;
    var sx = Math.max(0, (fx - g.x) * rx), sy = Math.max(0, (fy - g.y) * ry);
    var sw = Math.min(g.iw - sx, fw * rx), sh = Math.min(g.ih - sy, fh * ry);
    if (sw < 10 || sh < 10) { App.toast('裁剪区域太小，请缩小后重试'); return; }

    var outSide = 900;
    var oscale = Math.min(1, outSide / Math.max(sw, sh));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * oscale));
    c.height = Math.max(1, Math.round(sh * oscale));
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(crop.img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    App.setPhoto(c.toDataURL('image/jpeg', .78));
    closeCrop();
    App.toast('裁剪好了，颜色要不要重新识别一下？');
  }

  function bindCrop() {
    var stage = $('cropStage');
    stage.addEventListener('pointerdown', function (e) {
      if (!crop.img) return;
      crop.dragging = true; crop.sx = e.clientX; crop.sy = e.clientY;
      try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    });
    stage.addEventListener('pointermove', function (e) {
      if (!crop.dragging) return;
      crop.ox += e.clientX - crop.sx;
      crop.oy += e.clientY - crop.sy;
      crop.sx = e.clientX; crop.sy = e.clientY;
      drawCrop();
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      stage.addEventListener(ev, function () { crop.dragging = false; });
    });
    $('cropZoom').addEventListener('input', function (e) {
      crop.zoom = Number(e.target.value) / 100;
      drawCrop();
    });
    $('cropCancel').addEventListener('click', closeCrop);
    $('cropApply').addEventListener('click', applyCrop);
    $('cropModal').addEventListener('click', function (e) {
      if (e.target === $('cropModal')) closeCrop();
    });
  }

  /* ---------------- 天气 ---------------- */

  function fetchWithTimeout(url, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; reject(new Error('timeout')); } }, ms);
      fetch(url).then(function (r) {
        if (done) return; done = true; clearTimeout(t); resolve(r);
      }, function (e) {
        if (done) return; done = true; clearTimeout(t); reject(e);
      });
    });
  }

  function bandOfTemp(t) {
    if (t == null) return 'mild';
    if (t < 5) return 'cold';
    if (t < 15) return 'cool';
    if (t < 25) return 'mild';
    return 'hot';
  }

  function currentBand() {
    var m = $('weatherManual').value;
    if (m !== 'auto') return m;
    return weather.band || bandOfTemp(weather.temp);
  }

  function seasonForBand(band) {
    if (band === 'cold') return ['冬'];
    if (band === 'cool') return ['秋', '冬'];
    if (band === 'hot') return ['夏'];
    return ['春', '秋'];
  }

  function renderWeather() {
    var el = $('weatherNow');
    var band = currentBand();
    var bits = [];
    if (weather.temp != null) {
      bits.push('<b>' + Math.round(weather.temp) + '℃</b> ' + (weather.label || '当前天气'));
    } else {
      bits.push('天气没读到（可能网络限制），可在下面手动选「体感」，不影响搭配推荐。');
    }
    bits.push(' · 按<b>' + BAND_LABEL[band] + '</b>推荐');
    el.innerHTML = bits.join('');
  }

  function loadWeather() {
    var sel = $('weatherCity').value;
    var coordsP;
    if (sel === 'auto') {
      coordsP = new Promise(function (resolve) {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(function (p) {
          resolve({ lat: p.coords.latitude, lon: p.coords.longitude });
        }, function () { resolve(null); }, { timeout: 7000, maximumAge: 3600000 });
      });
    } else {
      var parts = sel.split(',');
      coordsP = Promise.resolve({ lat: Number(parts[0]), lon: Number(parts[1]) });
    }

    return coordsP.then(function (loc) {
      if (!loc) throw new Error('no location');
      var cacheKey = 'wardrobe-weather-' + Math.round(loc.lat) + '-' + Math.round(loc.lon);
      try {
        var cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
        if (cached && Date.now() - cached.t < 3600000) return cached;
      } catch (e) {}
      var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat.toFixed(2) +
        '&longitude=' + loc.lon.toFixed(2) + '&current=temperature_2m,weather_code&timezone=auto';
      return fetchWithTimeout(url, 7000).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      }).then(function (j) {
        var cur = j.current || {};
        var out = { temp: cur.temperature_2m, code: cur.weather_code, t: Date.now() };
        try { localStorage.setItem(cacheKey, JSON.stringify(out)); } catch (e) {}
        return out;
      });
    }).then(function (w) {
      weather.temp = (typeof w.temp === 'number') ? w.temp : null;
      weather.code = w.code;
      weather.label = WX[w.code] || '';
      weather.band = bandOfTemp(weather.temp);
      renderWeather();
    }).catch(function () {
      /* 定位失败 / 接口不通：按月份给个兜底温度带，功能照常可用 */
      var m = new Date().getMonth() + 1;
      weather.temp = null;
      weather.band = (m >= 6 && m <= 8) ? 'hot' : (m >= 3 && m <= 5 || m >= 9 && m <= 10) ? 'mild' :
        (m === 11) ? 'cool' : 'cold';
      renderWeather();
    });
  }

  /* ---------------- 搭配推荐引擎 ---------------- */

  function isNeutral(name) { return NEUTRAL.indexOf(name) >= 0; }

  function harmony(a, b) {
    if (isNeutral(a) || isNeutral(b)) return 2;
    if (a === b) return 1.6;
    if ((WARM.indexOf(a) >= 0 && WARM.indexOf(b) >= 0) ||
        (COOL.indexOf(a) >= 0 && COOL.indexOf(b) >= 0)) return 1.2;
    return .3;
  }

  function groupOf(cat) {
    if (cat === '上衣') return 'top';
    if (cat === '下装') return 'bottom';
    if (cat === '连衣裙') return 'dress';
    if (cat === '外套') return 'outer';
    if (cat === '鞋履') return 'shoes';
    if (cat === '包袋') return 'bag';
    if (cat === '配饰') return 'acc';
    return 'other';
  }

  function seasonOk(it, band) {
    return !it.season || it.season === '四季' || seasonForBand(band).indexOf(it.season) >= 0;
  }

  function pickAt(list, offset) {
    if (!list.length) return null;
    return list[offset % list.length];
  }

  function ranked(list) {
    return list.slice().sort(function (a, b) {
      var sa = 3 / (1 + (Number(a.wearCount) || 0)) + (isNeutral(a.color) ? 1.1 : 0);
      var sb = 3 / (1 + (Number(b.wearCount) || 0)) + (isNeutral(b.color) ? 1.1 : 0);
      return sb - sa;
    });
  }

  function buildSuggestions() {
    var band = currentBand();
    var all = App.getItems().filter(function (it) { return seasonOk(it, band); });
    var pool = all.length >= 3 ? all : App.getItems();
    if (pool.length < 2) {
      $('suggestList').innerHTML = '<p class="smart-note">衣橱里至少要有 2 件单品才能推荐。先去「添加」录几件，或点「统计」里的「载入示例数据」试试。</p>';
      return;
    }

    var G = { top: [], bottom: [], dress: [], outer: [], shoes: [], bag: [], acc: [] };
    pool.forEach(function (it) {
      var g = groupOf(it.category);
      if (G[g]) G[g].push(it);
    });
    Object.keys(G).forEach(function (k) { G[k] = ranked(G[k]); });

    var sets = [];
    for (var n = 0; n < 3; n++) {
      var chosen = [], base = [];
      var top = null, bottom = null;
      if (G.dress.length && (n === 1 || !G.top.length || !G.bottom.length)) {
        top = pickAt(G.dress, n);
        base.push('连衣裙');
      } else {
        top = pickAt(G.top, n);
        bottom = pickAt(G.bottom, n);
        base.push('上装', '下装');
      }
      if (top) chosen.push(top);
      if (bottom) chosen.push(bottom);
      if ((band === 'cold' || band === 'cool') && G.outer.length) chosen.push(pickAt(G.outer, n));
      if (G.shoes.length) chosen.push(pickAt(G.shoes, n));
      if (n < 2 && G.bag.length) chosen.push(pickAt(G.bag, n));
      if (n === 0 && G.acc.length) chosen.push(G.acc[0]);
      if (!chosen.length) continue;

      var score = 0, pairs = 0;
      for (var i = 0; i < chosen.length; i++) {
        for (var j = i + 1; j < chosen.length; j++) { score += harmony(chosen[i].color, chosen[j].color); pairs++; }
      }
      score = pairs ? score / pairs : 0;
      var idle = chosen.filter(function (it) { return (Number(it.wearCount) || 0) === 0; });
      var colors = chosen.map(function (it) { return it.color; });
      var uniq = colors.filter(function (v, i) { return colors.indexOf(v) === i; });

      var reasons = ['按' + BAND_LABEL[band] + '的体感挑的，只从当季单品里选。'];
      if (chosen.some(function (it) { return it.category === '外套'; })) reasons.push('天凉，配了件外套。');
      reasons.push('配色 ' + uniq.slice(0, 4).join(' · ') + (uniq.length > 3 ? '（颜色偏多，可自己减一件）' : '，比较协调。'));
      if (idle.length) reasons.push('特意挑了 ' + idle.length + ' 件还没穿过的，别让它压箱底。');

      sets.push({ items: chosen, score: score, reasons: reasons, label: '方案 ' + (n + 1) });
    }

    if (!sets.length) {
      $('suggestList').innerHTML = '<p class="smart-note">现有单品还凑不出一套，先补几件上衣 / 下装吧。</p>';
      return;
    }

    $('suggestList').innerHTML = sets.map(function (s, idx) {
      var thumbs = s.items.map(function (it) {
        var inner = (it.photo && it.photo.indexOf('data:image') === 0)
          ? '<img src="' + it.photo + '" alt="" loading="lazy" decoding="async">'
          : '<span class="mini-ph">' + esc(it.category) + '</span>';
        return '<div class="suggest-thumb"><span class="ph">' + inner + '</span>' + esc(it.name) + '</div>';
      }).join('');
      return '<div class="suggest-row">' +
        '<div class="suggest-title"><strong>' + s.label + '</strong>' +
        '<span class="suggest-score">协调度 ' + Math.round(s.score / 2 * 100) + '%</span></div>' +
        '<div class="suggest-thumbs">' + thumbs + '</div>' +
        '<p class="suggest-reason">' + s.reasons.map(esc).join(' ') + '</p>' +
        '<button class="btn btn-primary suggest-use" data-set="' + idx + '">用这一套</button>' +
        '</div>';
    }).join('');

    $('suggestList')._sets = sets;
    $('suggestList').onclick = function (e) {
      var b = e.target.closest('.suggest-use');
      if (!b) return;
      var s = $('suggestList')._sets[Number(b.dataset.set)];
      if (!s) return;
      App.pickItems(s.items.map(function (it) { return it.id; }));
      App.toast('已选中 ' + s.items.length + ' 件，往下点「保存这套穿搭」即可');
      document.querySelector('.outfit-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }

  /* ---------------- 想买：分享文字解析 ---------------- */

  var PLATFORMS = [
    ['tb.cn', '淘宝'], ['taobao.com', '淘宝'], ['tmall.com', '天猫'],
    ['jd.com', '京东'], ['3.cn', '京东'], ['pinduoduo.com', '拼多多'], ['yangkeduo.com', '拼多多'],
    ['vip.com', '唯品会'], ['dewu.com', '得物'], ['xiaohongshu.com', '小红书'],
    ['xhslink.com', '小红书'], ['douyin.com', '抖音'], ['weidian.com', '微店']
  ];
  var CAT_KW = [
    ['连衣裙', ['连衣裙', '长裙', '衬衫裙']],
    ['外套', ['大衣', '羽绒服', '风衣', '夹克', '外套', '西装', '开衫', '棉服', '皮衣']],
    ['下装', ['牛仔裤', '阔腿裤', '休闲裤', '半身裙', '短裤', '长裤', '裤子', '裙', '打底裤']],
    ['鞋履', ['运动鞋', '球鞋', '靴', '单鞋', '凉鞋', '高跟鞋', '拖鞋', '鞋']],
    ['包袋', ['双肩包', '斜挎包', '手提包', '托特包', '钱包', '包包', '背包']],
    ['配饰', ['项链', '耳环', '耳饰', '帽子', '围巾', '腰带', '手表', '眼镜', '发夹']],
    ['上衣', ['衬衫', 'T恤', 't恤', '卫衣', '针织', '毛衣', '背心', 'Polo', 'polo', '上衣', '打底衫']]
  ];
  var COLOR_KW = [
    ['黑色', ['黑色', '黑', '曜石', '墨色']],
    ['米杏', ['米白', '米色', '杏色', '奶油', '燕麦']],
    ['白色', ['白色', '纯白', '奶白']],
    ['灰色', ['灰色', '灰', '烟灰']],
    ['棕色', ['棕色', '咖色', '咖啡', '驼色', '焦糖', '巧克力']],
    ['红色', ['红色', '酒红', '正红', '砖红']], ['粉色', ['粉色', '粉', '藕粉', '樱花粉']],
    ['橙色', ['橙色', '橘色', '橘']], ['黄色', ['黄色', '姜黄', '鹅黄']],
    ['绿色', ['绿色', '墨绿', '军绿', '牛油果', '橄榄']],
    ['蓝色', ['蓝色', '藏青', '牛仔蓝', '雾霾蓝', '宝蓝']],
    ['紫色', ['紫色', '香芋紫', '薰衣草']], ['多色', ['印花', '碎花', '格纹', '条纹', '拼色', '花色']]
  ];

  function guessByKeyword(text, table, fallback) {
    for (var i = 0; i < table.length; i++) {
      for (var j = 0; j < table[i][1].length; j++) {
        if (text.indexOf(table[i][1][j]) >= 0) return table[i][0];
      }
    }
    return fallback;
  }

  function parseShare(raw) {
    var text = String(raw || '').trim();
    var out = { name: '', price: 0, platform: '', link: '', category: '上衣', color: '黑色', season: '' };
    if (!text) return out;

    var urlM = text.match(/https?:\/\/[^\s，,。、\]】）)】]+/);
    out.link = urlM ? urlM[0] : '';
    var body = out.link ? text.replace(out.link, ' ') : text;

    for (var i = 0; i < PLATFORMS.length; i++) {
      if (text.toLowerCase().indexOf(PLATFORMS[i][0]) >= 0) { out.platform = PLATFORMS[i][1]; break; }
    }
    if (!out.platform) {
      if (/淘宝|天猫/.test(text)) out.platform = '淘宝';
      else if (/京东/.test(text)) out.platform = '京东';
      else if (/拼多多/.test(text)) out.platform = '拼多多';
      else if (/唯品会/.test(text)) out.platform = '唯品会';
    }

    var pm = body.match(/[¥￥]\s*(\d+(?:\.\d{1,2})?)/) ||
             body.match(/(?:到手价|券后|价格|售价|原价)\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/) ||
             body.match(/(\d+(?:\.\d{1,2})?)\s*元/);
    if (pm) out.price = Number(pm[1]) || 0;

    var bracket = body.match(/[【\[]([^】\]]{2,50})[】\]]/) || body.match(/[「『]([^」』]{2,50})[」』]/);
    if (bracket) out.name = bracket[1].trim();
    if (!out.name) {
      var segs = body.split(/[\n\r。；;|]+/).map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length >= 3 && !/复制|打开|长按|口令|淘宝|京东|APP|app|下载|领取|点击|链接|¥|￥/.test(s); });
      segs.sort(function (a, b) { return b.length - a.length; });
      out.name = (segs[0] || body.replace(/[¥￥]\d+(\.\d+)?/g, '').trim()).slice(0, 40);
    }
    out.name = out.name.replace(/^\s*[\d.、\-]+\s*/, '').slice(0, 40);

    out.category = guessByKeyword(out.name + ' ' + body, CAT_KW, '上衣');
    out.color = guessByKeyword(out.name + ' ' + body, COLOR_KW, '');
    var m = new Date().getMonth() + 1;
    out.season = (m >= 3 && m <= 5) ? '春' : (m >= 6 && m <= 8) ? '夏' : (m >= 9 && m <= 11) ? '秋' : '冬';
    return out;
  }

  function fillBuyForm(p) {
    $('bName').value = p.name || '';
    $('bCategory').value = p.category || '上衣';
    $('bColor').value = p.color || '黑色';
    $('bPrice').value = p.price || '';
    $('bSeason').value = p.season || '四季';
    $('bLink').value = p.link || p.platform || '';
  }

  function readBuyForm() {
    return {
      name: $('bName').value.trim(), category: $('bCategory').value,
      color: $('bColor').value, season: $('bSeason').value,
      price: Number($('bPrice').value) || 0, link: $('bLink').value.trim()
    };
  }

  function fillBuySelects() {
    var opts = function (arr) {
      return arr.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
    };
    $('bCategory').innerHTML = opts(App.CATEGORIES);
    $('bColor').innerHTML = opts(COLORS.map(function (c) { return c.name; }));
    $('bSeason').innerHTML = opts(App.SEASONS);
    $('bSeason').value = '四季';
  }

  /* ---------------- 想买：购入判断 ---------------- */

  function judge(c) {
    var all = App.getItems();
    var dup = all.filter(function (it) { return it.category === c.category && it.color === c.color; });
    var sameCat = all.filter(function (it) { return it.category === c.category; });
    var targetGroup = groupOf(c.category);
    var partnerCats;
    if (targetGroup === 'top') partnerCats = ['下装', '连衣裙'];
    else if (targetGroup === 'bottom' || targetGroup === 'dress') partnerCats = ['上衣', '外套'];
    else partnerCats = ['上衣', '下装', '连衣裙', '外套'];
    var partners = all.filter(function (it) { return partnerCats.indexOf(it.category) >= 0; });
    var good = partners.filter(function (it) { return harmony(c.color, it.color) >= 1.2; });
    var ok = partners.filter(function (it) { return harmony(c.color, it.color) < 1.2; });

    var level, title, lines = [];
    if (dup.length >= 3) {
      level = 'bad';
      title = '建议先别买：衣橱里已经有 ' + dup.length + ' 件同色同类了';
      lines.push('同类别「' + c.category + '」一共 ' + sameCat.length + ' 件，其中「' + c.color + '」就有 ' + dup.length + ' 件，重复度偏高。');
    } else if (partners.length === 0) {
      level = 'warn';
      title = '先缓缓：目前没有能搭它的单品';
      lines.push('衣橱里还缺可以跟它配的' + (targetGroup === 'top' ? '下装' : '上装') + '，买回来大概率只能单摆着。');
    } else if (good.length >= 3 && dup.length <= 1) {
      level = 'good';
      title = '可以买：有 ' + good.length + ' 件现成单品能搭';
      lines.push('这件能跟你衣橱里 ' + good.length + ' 件单品组成搭配，颜色也协调，买回来马上能穿。');
    } else if (good.length >= 1) {
      level = 'warn';
      title = '可以买，但搭配面偏窄';
      lines.push('有 ' + good.length + ' 件颜色协调的能搭，另外 ' + ok.length + ' 件颜色要斟酌。');
    } else {
      level = 'bad';
      title = '建议再想想：颜色不太好搭';
      lines.push('衣橱里有 ' + partners.length + ' 件能配的类别，但颜色跟这件都不太协调。');
    }
    if (dup.length && dup.length < 3) lines.push('注意：已有 ' + dup.length + ' 件同色同类单品，看看是不是撞款了。');
    if (c.price > 0 && good.length > 0) {
      lines.push('按可搭配件数算，约 ' + App.fmtMoney(c.price / good.length) + ' / 套。');
    }
    if (all.length < 5) lines.push('衣橱目前只有 ' + all.length + ' 件，样本还少，判断仅供参考。');
    return { level: level, title: title, lines: lines, good: good.slice(0, 8), dup: dup.slice(0, 4) };
  }

  function renderVerdict(r) {
    $('buyResultCard').hidden = false;
    $('buyVerdict').innerHTML = '<div class="verdict ' + r.level + '"><h3>' + esc(r.title) + '</h3>' +
      '<ul>' + r.lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></div>';

    var html = '';
    if (r.good.length) {
      html += '<p class="result-sub">能搭上的现成单品</p><div class="match-grid">' + r.good.map(function (it) {
        var inner = (it.photo && it.photo.indexOf('data:image') === 0)
          ? '<img src="' + it.photo + '" alt="" loading="lazy" decoding="async">'
          : '<span class="mini-ph">' + esc(it.category) + '</span>';
        return '<div class="match-item"><span class="ph">' + inner + '</span>' + esc(it.name) + '</div>';
      }).join('') + '</div>';
    }
    if (r.dup.length) {
      html += '<p class="result-sub">衣橱里类似的</p><div class="match-grid">' + r.dup.map(function (it) {
        var inner = (it.photo && it.photo.indexOf('data:image') === 0)
          ? '<img src="' + it.photo + '" alt="" loading="lazy" decoding="async">'
          : '<span class="mini-ph">' + esc(it.category) + '</span>';
        return '<div class="match-item"><span class="ph">' + inner + '</span>' + esc(it.name) + '</div>';
      }).join('') + '</div>';
    }
    $('buyMatches').innerHTML = html || '<p class="smart-note">还没有可展示的单品。</p>';
    $('buyResultCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function addToWardrobe() {
    var c = readBuyForm();
    if (!c.name) { App.toast('先填一下商品名'); return; }
    var item = {
      id: App.uid(), name: c.name, category: c.category, subCategory: '',
      season: c.season, color: c.color, brand: '', source: c.link,
      price: c.price, purchaseDate: App.todayISO(), wearCount: 0,
      tags: ['想买清单加入'], photo: buyPhoto, lastWornAt: '', createdAt: Date.now()
    };
    App.saveItem(item).then(function () {
      App.renderAll();
      App.switchPage('closet');
      App.toast('已加入衣橱');
      $('buyResultCard').hidden = true;
      $('buyText').value = '';
      ['bName', 'bPrice', 'bLink'].forEach(function (id) { $(id).value = ''; });
      buyPhoto = '';
      $('buyImagePreview').hidden = true;
      $('buyImagePreview').removeAttribute('src');
      $('buyImageRemove').hidden = true;
    });
  }

  function compressBuyPhoto(file) {
    return loadImage(URL.createObjectURL(file)).then(function (img) {
      var max = 800, s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      var c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      return c.toDataURL('image/jpeg', .76);
    });
  }

  /* ---------------- 绑定 ---------------- */

  function bindSmart() {
    $('btnCrop').addEventListener('click', openCrop);
    $('btnDetectColor').addEventListener('click', function () { autoDetectColor(true); });
    $('btnCutout').addEventListener('click', function () {
      var data = App.getState().photoData;
      if (!data) return;
      showHint('正在处理背景…');
      removeBackground(data).then(function (out) {
        if (!out) { showHint('这张图背景不规律，自动去背景不适用，建议用「手动裁剪」把多余部分裁掉。', 'fail'); return; }
        App.setPhoto(out);
        showHint('背景已去掉（适合白底商品图）。效果不满意就点「手动裁剪」自己框。', 'ok');
      }).catch(function () { showHint('处理失败，请改用手动裁剪。', 'fail'); });
    });

    /* 新上传的照片才自动识别，编辑旧单品时不覆盖用户已保存的颜色 */
    $('photoInput').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) pendingNewPhoto = true;
    });
    window.addEventListener('wardrobe:photo', function () {
      syncPhotoTools();
      if (pendingNewPhoto) { pendingNewPhoto = false; autoDetectColor(false); }
    });
    /* 兜底：图片真正解码完成后再同步一次状态 */
    $('photoPreview').addEventListener('load', syncPhotoTools);
    $('photoRemove').addEventListener('click', syncPhotoTools);

    bindCrop();

    $('btnWeatherRefresh').addEventListener('click', loadWeather);
    $('weatherCity').addEventListener('change', loadWeather);
    $('weatherManual').addEventListener('change', renderWeather);
    $('btnSuggest').addEventListener('click', buildSuggestions);

    fillBuySelects();
    $('btnBuyParse').addEventListener('click', function () {
      var p = parseShare($('buyText').value);
      fillBuyForm(p);
      var got = [];
      if (p.name) got.push('名称');
      if (p.price) got.push('价格 ' + App.fmtMoney(p.price));
      if (p.platform) got.push('平台 ' + p.platform);
      if (p.link) got.push('链接');
      App.toast(got.length ? '已识别：' + got.join(' / ') : '没提取到信息，请手动填一下');
    });
    $('btnBuyClear').addEventListener('click', function () {
      $('buyText').value = '';
      ['bName', 'bPrice', 'bLink'].forEach(function (id) { $(id).value = ''; });
      $('buyResultCard').hidden = true;
      buyPhoto = '';
      $('buyImagePreview').hidden = true;
      $('buyImageRemove').hidden = true;
    });
    $('btnBuyJudge').addEventListener('click', function () {
      var c = readBuyForm();
      if (!c.name) { App.toast('先填一下商品名'); return; }
      renderVerdict(judge(c));
    });
    $('btnBuyAdd').addEventListener('click', addToWardrobe);
    $('buyImage').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      compressBuyPhoto(f).then(function (data) {
        buyPhoto = data;
        $('buyImagePreview').src = data;
        $('buyImagePreview').hidden = false;
        $('buyImageRemove').hidden = false;
        return detectDominant(data);
      }).then(function (name) {
        $('bColor').value = name;
        App.toast('截图颜色识别为「' + name + '」，不对可以改');
      }).catch(function () { App.toast('截图已加入，颜色识别失败，手动选一下'); });
    });
    $('buyImageRemove').addEventListener('click', function () {
      buyPhoto = '';
      $('buyImagePreview').hidden = true;
      $('buyImagePreview').removeAttribute('src');
      $('buyImageRemove').hidden = true;
      $('buyImage').value = '';
    });
  }

  /* app.js 在切页 / 数据变化时会调用这两个钩子 */
  window.WardrobeSmart = {
    onDataChange: function () {
      syncPhotoTools();
      if ($('suggestList').innerHTML) $('suggestList').innerHTML = '';
    },
    onPage: function (name) {
      if (name === 'outfit') renderWeather();
      if (name === 'add') syncPhotoTools();
    }
  };

  bindSmart();
  syncPhotoTools();
  App.ready.then(function () {
    renderWeather();
    loadWeather();
  });
})();
