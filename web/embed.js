/* ===========================================================================
 * embed.js — the Arkansas crash map as a drop-in embed for another site.
 *
 * On a page on arkansasonline.com (or anywhere else):
 *
 *   <div id="ar-crash-map"></div>
 *   <script src="https://maps.arkansasonline.com/crashes/embed.js"></script>
 *
 * That is the whole integration. The script loads MapLibre, injects its own
 * styles, builds the control panel, and renders into the container.
 *
 * This is a port of web/index.html, with the three things that only work on the
 * map's own origin made portable:
 *
 *   1. tiles and GeoJSON assets are fetched from absolute URLs on this origin
 *      (derived from this script's own src, so moving the file just works),
 *   2. every DOM lookup is scoped to the container instead of document-global
 *      ids, and all CSS is namespaced under .arcm-* so it cannot collide with
 *      the host page's styles (or be restyled by them),
 *   3. the layout is container-relative rather than a full-viewport overlay.
 *
 * Options — as data-attributes on the container, or window.AR_CRASH_MAP_CONFIG:
 *   data-height="70vh"    container height (default 640px if the page sets none)
 *   data-center="-92.3,34.9"
 *   data-zoom="6.4"
 *   data-measure="crash_count"   initial "Filter by" selection
 *   data-year="0"                initial year (0 = all years)
 * =========================================================================== */
(function () {
  'use strict';

  if (window.ARCrashMap) return;   // already loaded

  // ---- where we live --------------------------------------------------------
  // Derive the base from this script's own URL so the embed keeps working if the
  // files are moved or served from a CDN in front of this origin.
  var SELF = (document.currentScript && document.currentScript.src) ||
             'https://maps.arkansasonline.com/crashes/embed.js';
  var ASSET_BASE = SELF.replace(/[^/]*$/, '');            // .../crashes/
  var ORIGIN = ASSET_BASE.replace(/\/[^/]*\/$/, '');      // https://maps.arkansasonline.com
  var TILE_BASE = ORIGIN + '/tiles';
  var LIB_JS = ASSET_BASE + 'vendor/maplibre-gl.js';
  var LIB_CSS = ASSET_BASE + 'vendor/maplibre-gl.css';
  var BASEMAP = 'https://tiles.openfreemap.org/styles/positron';

  // ---- map constants (identical to the standalone page) ---------------------
  var RAMP = ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026', '#7a0177'];

  var MEASURES = {
    crash_count:    { label: 'Crash count',        breaks: [1, 10, 50, 250, 1500, 8000], pointFilter: null },
    fatalities:     { label: 'Fatalities',         breaks: [1, 2, 5, 15, 40, 120],       pointFilter: ['>', ['get', 'numfatalities'], 0] },
    injuries:       { label: 'Serious injuries',   breaks: [1, 3, 10, 40, 150, 600],     pointFilter: ['>', ['get', 'numserinj'], 0] },
    ped_count:      { label: 'Pedestrian',         breaks: [1, 3, 10, 30, 100, 400],     pointFilter: ['get', 'nonmotoristrelated'] },
    cmv_count:      { label: 'Commercial vehicle', breaks: [1, 5, 20, 75, 250, 1000],    pointFilter: ['get', 'cmvrelated'] },
    impaired_count: { label: 'Impaired / DUI',     breaks: [1, 4, 15, 50, 150, 600],     pointFilter: ['get', 'impairedrelated'] },
  };
  var MEASURE_ORDER = ['crash_count', 'fatalities', 'injuries', 'ped_count', 'cmv_count', 'impaired_count'];
  var YEARS = [['0', 'All years'], ['2021', '2021'], ['2022', '2022'], ['2023', '2023'], ['2024', '2024'], ['2025', '2025']];

  var SEVERITY = [
    { value: 'Fatal Injury (K)',             label: 'Fatal (K)',           color: '#7a0177' },
    { value: 'Suspected Serious Injury (A)', label: 'Serious injury (A)',  color: '#bd0026' },
    { value: 'Suspected Minor Injury (B)',   label: 'Minor injury (B)',    color: '#f03b20' },
    { value: 'Possible Injury (C)',          label: 'Possible injury (C)', color: '#fd8d3c' },
  ];
  var SEVERITY_DEFAULT = { label: 'No apparent injury (O)', color: '#4575b4' };
  var POINT_ZOOM = 13;

  var MASK_COLOR = '#ffffff';
  var WORLD_RING = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];

  var HEX_LAYERS = ['lyr-hex-8km', 'lyr-hex-3km', 'lyr-hex-1km', 'lyr-hex-400m'];
  var CATEGORY_LABELS = { ped_count: 'pedestrian', cmv_count: 'commercial-vehicle', impaired_count: 'impaired' };

  // ---- styles ---------------------------------------------------------------
  // Namespaced and defensive: the host page's global rules (font-size on select,
  // box-sizing resets, `img{max-width}`, etc.) must not reach inside.
  //
  // Every rule is scoped under .arcm-root — not for tidiness, but for specificity.
  // MapLibre's own stylesheet is injected AFTER this one and contains
  // `.maplibregl-map{position:relative}`, which at equal specificity would win on
  // source order and collapse the absolutely-positioned map container to zero
  // height. Two classes (0,2,0) beats it regardless of load order.
  var CSS = [
    '.arcm-root{position:relative;width:100%;min-height:240px;overflow:hidden;',
      'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:13px;line-height:1.4;color:#111;background:#fff;box-sizing:border-box}',
    '.arcm-root *,.arcm-root *:before,.arcm-root *:after{box-sizing:border-box}',
    '.arcm-root .arcm-map{position:absolute;top:0;right:0;bottom:0;left:0;width:auto;height:auto}',
    '.arcm-root .arcm-panel{position:absolute;top:12px;left:12px;z-index:2;background:rgba(255,255,255,.94);',
      'padding:12px 14px;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.3);font-size:13px;max-width:240px;',
      'max-height:calc(100% - 24px);overflow-y:auto}',
    '.arcm-root .arcm-panel h2{font-size:14px;margin:0 0 8px;font-weight:700;line-height:1.25;color:#111;letter-spacing:0}',
    '.arcm-root .arcm-panel label{font-weight:600;display:block;margin-bottom:4px;font-size:13px;color:#111;text-transform:none}',
    '.arcm-root .arcm-panel select{width:100%;padding:4px;font-size:13px;font-family:inherit;color:#111;background:#fff;',
      'border:1px solid #bbb;border-radius:3px;height:auto;margin:0;max-width:none;appearance:auto}',
    '.arcm-root .arcm-panel select+label{margin-top:10px}',
    '.arcm-root .arcm-legend{margin-top:10px}',
    '.arcm-root .arcm-legend .arcm-row{display:flex;align-items:center;gap:6px;margin:2px 0}',
    '.arcm-root .arcm-swatch{width:16px;height:12px;flex:0 0 auto;border:1px solid rgba(0,0,0,.2)}',
    '.arcm-root .arcm-swatch.arcm-dot{width:12px;height:12px;border-radius:50%}',
    '.arcm-root .arcm-meta{margin-top:10px;color:#444;font-size:11px;line-height:1.5}',
    '.arcm-root .maplibregl-popup-content{font-size:12px;font-family:inherit;color:#111;line-height:1.45}',
    '.arcm-root .maplibregl-popup-content b{font-weight:700}',
    '.arcm-root .arcm-note{position:absolute;left:12px;bottom:34px;z-index:2;max-width:280px;padding:8px 10px;',
      'background:rgba(255,255,255,.94);border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.3);font-size:12px;color:#900}',
  ].join('');

  function injectCSS() {
    if (document.getElementById('arcm-styles')) return;
    var s = document.createElement('style');
    s.id = 'arcm-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ---- MapLibre loader (once per page, however many maps) -------------------
  var libPromise = null;
  function loadMapLibre() {
    if (libPromise) return libPromise;
    libPromise = new Promise(function (resolve, reject) {
      if (window.maplibregl) return resolve(window.maplibregl);

      if (!document.querySelector('link[data-arcm-lib]')) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = LIB_CSS;
        link.setAttribute('data-arcm-lib', '');
        document.head.appendChild(link);
      }
      var script = document.createElement('script');
      script.src = LIB_JS;
      script.async = true;
      script.onload = function () {
        window.maplibregl ? resolve(window.maplibregl)
                          : reject(new Error('MapLibre loaded but maplibregl is undefined'));
      };
      script.onerror = function () { reject(new Error('Could not load MapLibre from ' + LIB_JS)); };
      document.head.appendChild(script);
    });
    return libPromise;
  }

  // ---- small helpers --------------------------------------------------------
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; });
  }
  function num(v) { return (+v).toLocaleString(); }

  function readOptions(root) {
    var g = window.AR_CRASH_MAP_CONFIG || {};
    var d = root.dataset || {};
    var center = d.center ? d.center.split(',').map(Number) : (g.center || [-92.3, 34.9]);
    return {
      height:  d.height  || g.height  || null,
      center:  center,
      zoom:    d.zoom    != null ? +d.zoom : (g.zoom != null ? g.zoom : 6.4),
      measure: d.measure || g.measure || 'crash_count',
      year:    d.year    != null ? String(d.year) : String(g.year != null ? g.year : 0),
      title:   d.title   || g.title   || 'Arkansas Crashes (2021–2025)',
    };
  }

  // ---- one embedded map -----------------------------------------------------
  function build(root, opts, maplibregl) {
    root.classList.add('arcm-root');
    root.innerHTML = '';

    // Only impose a height if the host page hasn't given the container one.
    if (opts.height) root.style.height = opts.height;
    else if (root.getBoundingClientRect().height < 50) root.style.height = '640px';

    var mapEl = el('div', 'arcm-map');
    root.appendChild(mapEl);

    // Unique ids so <label for> stays correct with several maps on one page.
    var uid = 'arcm-' + Math.random().toString(36).slice(2, 8);
    var panel = el('div', 'arcm-panel');
    panel.appendChild(el('h2', null, esc(opts.title)));

    var measureLabel = el('label', null, 'Filter by');
    measureLabel.htmlFor = uid + '-measure';
    var measureSel = document.createElement('select');
    measureSel.id = uid + '-measure';
    MEASURE_ORDER.forEach(function (k) {
      var o = document.createElement('option');
      o.value = k; o.textContent = MEASURES[k].label;
      measureSel.appendChild(o);
    });
    measureSel.value = MEASURES[opts.measure] ? opts.measure : 'crash_count';

    var yearLabel = el('label', null, 'Year');
    yearLabel.htmlFor = uid + '-year';
    var yearSel = document.createElement('select');
    yearSel.id = uid + '-year';
    YEARS.forEach(function (y) {
      var o = document.createElement('option');
      o.value = y[0]; o.textContent = y[1];
      yearSel.appendChild(o);
    });
    yearSel.value = YEARS.some(function (y) { return y[0] === opts.year; }) ? opts.year : '0';

    var legend = el('div', 'arcm-legend');
    var meta = el('div', 'arcm-meta');
    var layerinfo = el('div', null, '—');
    meta.appendChild(layerinfo);
    meta.appendChild(el('div', null, 'Hex bins &lt; z13, individual crashes at z13+.'));

    panel.appendChild(measureLabel);
    panel.appendChild(measureSel);
    panel.appendChild(yearLabel);
    panel.appendChild(yearSel);
    panel.appendChild(legend);
    panel.appendChild(meta);
    root.appendChild(panel);

    var map = new maplibregl.Map({
      container: mapEl,
      style: BASEMAP,
      center: opts.center,
      zoom: opts.zoom,
      maxBounds: [[-97.0, 31.5], [-87.5, 38.0]],
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'imperial' }), 'bottom-left');

    var currentMeasure = measureSel.value;

    function fillColorExpr(measure) {
      var b = MEASURES[measure].breaks;
      return ['interpolate', ['linear'], ['get', measure],
        b[0], RAMP[0], b[1], RAMP[1], b[2], RAMP[2],
        b[3], RAMP[3], b[4], RAMP[4], b[5], RAMP[5]];
    }

    function buildLegend(measure) {
      var b = MEASURES[measure].breaks;
      var rows = RAMP.map(function (c, i) {
        var lo = b[i], hi = b[i + 1];
        var label = hi ? num(lo) + '–' + num(hi) : num(lo) + '+';
        return '<div class="arcm-row"><span class="arcm-swatch" style="background:' + c + '"></span>' + label + '</div>';
      }).join('');
      legend.innerHTML = '<label>' + MEASURES[measure].label + '</label>' + rows;
    }

    function buildSeverityLegend() {
      var rows = SEVERITY.concat([SEVERITY_DEFAULT]).map(function (s) {
        return '<div class="arcm-row"><span class="arcm-swatch arcm-dot" style="background:' + s.color + '"></span>' + s.label + '</div>';
      }).join('');
      legend.innerHTML = '<label>Crash severity</label>' + rows;
    }

    var legendMode = null;
    function refreshLegend(force) {
      var mode = map.getZoom() >= POINT_ZOOM ? 'severity' : 'measure';
      if (!force && mode === legendMode) return;
      legendMode = mode;
      if (mode === 'severity') buildSeverityLegend();
      else buildLegend(measureSel.value);
    }

    function applyState() {
      var measure = measureSel.value;
      var year = parseInt(yearSel.value, 10);
      currentMeasure = measure;

      var expr = fillColorExpr(measure);
      var hexFilter = ['all', ['==', ['get', 'year'], year], ['>', ['get', measure], 0]];
      HEX_LAYERS.forEach(function (id) {
        map.setPaintProperty(id, 'fill-color', expr);
        map.setFilter(id, hexFilter);
      });

      var clauses = [];
      var pf = MEASURES[measure].pointFilter;
      if (pf) clauses.push(pf);
      if (year !== 0) clauses.push(['==', ['get', 'year'], year]);
      map.setFilter('lyr-points', clauses.length ? ['all'].concat(clauses) : null);

      refreshLegend(true);
    }

    function addHexLayer(id, source, sourceLayer, minzoom, maxzoom) {
      map.addLayer({
        id: id, type: 'fill', source: source, 'source-layer': sourceLayer,
        minzoom: minzoom, maxzoom: maxzoom,
        paint: {
          'fill-color': fillColorExpr('crash_count'),
          'fill-opacity': 0.65,
          'fill-outline-color': 'rgba(0,0,0,0.15)',
        },
      });
    }

    function updateLayerInfo() {
      var z = map.getZoom();
      var active = z < 8 ? '8 km hexes' : z < 10 ? '3 km hexes' : z < 12 ? '1 km hexes'
                 : z < 13 ? '400 m hexes' : 'individual crashes';
      layerinfo.textContent = 'z' + z.toFixed(1) + ' · ' + active;
    }

    map.on('load', function () {
      map.addSource('hex_8km',      { type: 'vector', tiles: [TILE_BASE + '/hex_8km/{z}/{x}/{y}'],      minzoom: 0,  maxzoom: 8 });
      map.addSource('hex_3km',      { type: 'vector', tiles: [TILE_BASE + '/hex_3km/{z}/{x}/{y}'],      minzoom: 6,  maxzoom: 10 });
      map.addSource('hex_1km',      { type: 'vector', tiles: [TILE_BASE + '/hex_1km/{z}/{x}/{y}'],      minzoom: 9,  maxzoom: 13 });
      map.addSource('hex_400m',     { type: 'vector', tiles: [TILE_BASE + '/hex_400m/{z}/{x}/{y}'],     minzoom: 11, maxzoom: 14 });
      map.addSource('crash_points', { type: 'vector', tiles: [TILE_BASE + '/crash_points/{z}/{x}/{y}'], minzoom: 11, maxzoom: 16 });

      addHexLayer('lyr-hex-8km',  'hex_8km',  'hex_8km',  0,  8);
      addHexLayer('lyr-hex-3km',  'hex_3km',  'hex_3km',  8,  10);
      addHexLayer('lyr-hex-1km',  'hex_1km',  'hex_1km',  10, 12);
      addHexLayer('lyr-hex-400m', 'hex_400m', 'hex_400m', 12, 13);

      var severityMatch = ['match', ['get', 'crashseverity']];
      SEVERITY.forEach(function (s) { severityMatch.push(s.value, s.color); });
      severityMatch.push(SEVERITY_DEFAULT.color);

      map.addLayer({
        id: 'lyr-points', type: 'circle', source: 'crash_points', 'source-layer': 'crash_points',
        minzoom: 13,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 18, 6],
          'circle-color': severityMatch,
          'circle-opacity': 0.8,
          'circle-stroke-width': 0.5,
          'circle-stroke-color': 'rgba(0,0,0,0.4)',
        },
      });

      applyState();
      updateLayerInfo();

      // Hex hover popup.
      var popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      HEX_LAYERS.forEach(function (id) {
        map.on('mousemove', id, function (e) {
          map.getCanvas().style.cursor = 'pointer';
          var p = e.features[0].properties;
          var html = '<b>' + num(p.crash_count) + '</b> crashes<br>' +
                     p.fatalities + ' fatalities · ' + p.injuries + ' serious injuries';
          if (CATEGORY_LABELS[currentMeasure]) {
            html += '<br>' + num(p[currentMeasure]) + ' ' + CATEGORY_LABELS[currentMeasure];
          }
          popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
        });
        map.on('mouseleave', id, function () { map.getCanvas().style.cursor = ''; popup.remove(); });
      });

      // Point click popup.
      function row(label, val) {
        return (val === null || val === undefined || val === '') ? ''
          : '<br><b>' + label + ':</b> ' + esc(val);
      }
      map.on('click', 'lyr-points', function (e) {
        var p = e.features[0].properties;
        var when = [p.crashdate, p.crashtime].filter(Boolean).join(' · ');
        var place = [p.city, p.county ? p.county + ' County' : null].filter(Boolean).join(', ');
        var html = '<b>' + esc(p.crashseverity) + '</b>' +
          (when ? '<br>' + esc(when) : '') +
          (place ? '<br>' + esc(place) : '') +
          row('Description', p.crashmanner) +
          row('Conditions', p.roadwaysurfaceconidtion) +
          row('Lighting', p.lightingconditions) +
          row('Agency', p.agencyname) +
          '<br><b>Fatalities:</b> ' + p.numfatalities + ' · <b>Serious inj:</b> ' + p.numserinj;
        new maplibregl.Popup().setLngLat(e.lngLat).setHTML(html).addTo(map);
      });
      map.on('mouseenter', 'lyr-points', function () { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'lyr-points', function () { map.getCanvas().style.cursor = ''; });

      // Arkansas cutout mask, boundary outline and city labels. Cross-origin
      // fetch — the /crashes/ location sends Access-Control-Allow-Origin.
      fetch(ASSET_BASE + 'arkansas.geojson').then(function (r) { return r.json(); }).then(function (gj) {
        var geom = gj.geometry || gj;
        var holes = geom.type === 'MultiPolygon'
          ? geom.coordinates.map(function (poly) { return poly[0]; })
          : [geom.coordinates[0]];

        map.addSource('ar-mask', {
          type: 'geojson',
          data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [WORLD_RING].concat(holes) } },
        });
        map.addLayer({
          id: 'ar-mask-fill', type: 'fill', source: 'ar-mask',
          paint: { 'fill-color': MASK_COLOR, 'fill-opacity': 1 },
        });
        map.addSource('ar-outline', { type: 'geojson', data: gj });
        map.addLayer({
          id: 'ar-outline-line', type: 'line', source: 'ar-outline',
          paint: {
            'line-color': '#333333',
            'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.2, 12, 2],
          },
        });

        var fonts = map.getStyle().layers
          .filter(function (l) { return l.type === 'symbol'; })
          .map(function (l) { return map.getLayoutProperty(l.id, 'text-font'); })
          .filter(Boolean);
        var cityFont = fonts.find(function (f) { return f.some(function (n) { return /Regular/i.test(n); }); })
                    || fonts.find(function (f) { return f.some(function (n) { return /Medium/i.test(n); }); })
                    || fonts[0] || ['Noto Sans Regular'];

        map.addSource('ar-cities', { type: 'geojson', data: ASSET_BASE + 'ar_cities.geojson' });
        map.addLayer({
          id: 'lyr-cities', type: 'symbol', source: 'ar-cities',
          maxzoom: POINT_ZOOM,
          layout: {
            'text-field': ['get', 'name'],
            'text-font': cityFont,
            'text-size': ['interpolate', ['linear'], ['get', 'pop'],
                          1000, 10, 10000, 12.5, 50000, 15, 100000, 17, 200000, 20],
            'text-max-width': 8,
            'text-padding': 10,
            'symbol-sort-key': ['-', 0, ['get', 'pop']],
            'text-allow-overlap': false,
            'icon-allow-overlap': false,
          },
          paint: {
            'text-color': '#000000',
            'text-halo-color': '#ffffff',
            'text-halo-width': 1.4,
            'text-halo-blur': 0.4,
          },
        });
      }).catch(function (err) {
        // The map is still usable without the mask/labels, so don't tear it down.
        if (window.console) console.error('[ar-crash-map] boundary/city layer failed:', err);
      });
    });

    map.on('zoom', function () { updateLayerInfo(); refreshLegend(false); });
    measureSel.addEventListener('change', applyState);
    yearSel.addEventListener('change', applyState);

    // Containers often get their real size after the embed renders (tabs,
    // accordions, responsive columns); MapLibre needs telling.
    if (window.ResizeObserver) {
      new ResizeObserver(function () { map.resize(); }).observe(root);
    }

    return map;
  }

  function fail(root, message) {
    root.classList.add('arcm-root');
    root.appendChild(el('div', 'arcm-note', esc(message)));
    if (window.console) console.error('[ar-crash-map] ' + message);
  }

  function init(root, overrides) {
    if (typeof root === 'string') root = document.querySelector(root);
    if (!root || root.getAttribute('data-arcm-ready')) return;
    root.setAttribute('data-arcm-ready', '1');

    var opts = readOptions(root);
    if (overrides) for (var k in overrides) opts[k] = overrides[k];

    injectCSS();
    return loadMapLibre().then(function (maplibregl) {
      if (!maplibregl.supported || maplibregl.supported()) return build(root, opts, maplibregl);
      fail(root, 'This browser does not support WebGL, which this map requires.');
    }).catch(function (err) {
      fail(root, 'The crash map could not be loaded. ' + err.message);
    });
  }

  function autoInit() {
    var nodes = document.querySelectorAll('#ar-crash-map, .ar-crash-map, [data-ar-crash-map]');
    for (var i = 0; i < nodes.length; i++) init(nodes[i]);
  }

  window.ARCrashMap = { init: init, version: '1.0.0' };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoInit);
  else autoInit();
})();
