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
 * Layout is page-integrated rather than a floating overlay: title, then the two
 * filters side by side (stacking when the container is narrow), a centered note,
 * the map, and a horizontal legend beneath it.
 *
 * Options — as data-attributes on the container, or window.AR_CRASH_MAP_CONFIG:
 *   data-height="460px"   height of the MAP (default 640px). The controls and
 *                         legend sit outside it, so the widget is taller than this.
 *   data-center="-92.3,34.9"
 *   data-zoom="6.4"
 *   data-measure="crash_count"   initial "Filter by" selection
 *   data-year="0"                initial year (0 = all years)
 *   data-title="..."             heading above the filters; "" removes it
 *   data-hint="..."              centered note above the map at hex zooms
 *   data-hint-points="..."       the same note at z13+, where crashes are drawn
 *                                individually; "" blanks either state
 *   data-source="..."            credit line under the legend; "" removes it
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
    '.arcm-root{width:100%;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
      'font-size:14px;line-height:1.4;color:#111;box-sizing:border-box}',
    '.arcm-root *,.arcm-root *:before,.arcm-root *:after{box-sizing:border-box}',
    '.arcm-root .arcm-title{font-size:17px;font-weight:700;line-height:1.25;margin:0 0 10px;color:#111;letter-spacing:0}',

    // Filters: side by side while each can hold ~220px, stacked below that.
    '.arcm-root .arcm-controls{display:flex;flex-wrap:wrap;gap:10px 16px;margin:0 0 10px}',
    // Grow to share the row, but stop before the selects look absurdly wide.
    '.arcm-root .arcm-field{flex:1 1 220px;min-width:0;max-width:340px}',
    '.arcm-root .arcm-field label{display:block;font-weight:600;font-size:13px;margin:0 0 4px;color:#111;text-transform:none}',
    '.arcm-root .arcm-field select{display:block;width:100%;max-width:none;margin:0;padding:6px 8px;',
      'font-family:inherit;font-size:14px;line-height:1.3;color:#111;background:#fff;border:1px solid #bbb;',
      'border-radius:4px;height:auto;appearance:auto}',

    '.arcm-root .arcm-hint{text-align:center;font-size:13px;color:#555;margin:0 0 8px}',
    '.arcm-root .arcm-map{position:relative;width:100%;height:640px}',

    // Bin-size badge, then the legend as one horizontal run, wrapping when narrow.
    '.arcm-root .arcm-legendwrap{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:10px 0 0}',
    '.arcm-root .arcm-hexbadge svg{display:block}',
    '.arcm-root .arcm-hexbadge polygon{fill:#f2f2f2;stroke:#555;stroke-width:1.5}',
    '.arcm-root .arcm-hexbadge text{font-family:inherit;font-size:13px;font-weight:600;fill:#111}',
    '.arcm-root .arcm-legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin:0;font-size:13px}',
    '.arcm-root .arcm-legend-title{font-weight:600}',
    '.arcm-root .arcm-item{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}',
    '.arcm-root .arcm-swatch{width:18px;height:12px;flex:0 0 auto;border:1px solid rgba(0,0,0,.25)}',
    '.arcm-root .arcm-swatch.arcm-dot{width:12px;height:12px;border-radius:50%}',
    '.arcm-root .arcm-meta{margin:8px 0 0;color:#666;font-size:12px;line-height:1.5}',

    '.arcm-root .maplibregl-popup-content{font-size:12px;font-family:inherit;color:#111;line-height:1.45}',
    '.arcm-root .maplibregl-popup-content b{font-weight:700}',
    '.arcm-root .arcm-note{margin:10px 0 0;padding:8px 10px;background:#fff3f3;border:1px solid #f0c0c0;',
      'border-radius:6px;font-size:13px;color:#900}',
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
      zoom:    d.zoom    != null ? +d.zoom : (g.zoom != null ? g.zoom : 7.8),
      measure: d.measure || g.measure || 'crash_count',
      year:    d.year    != null ? String(d.year) : String(g.year != null ? g.year : 0),
      // Pass data-title="" (or data-hint="", data-source="") to omit a line entirely.
      title:   d.title   != null ? d.title : (g.title != null ? g.title : 'Arkansas Crashes (2021–2025)'),
      hint:    d.hint    != null ? d.hint  : (g.hint  != null ? g.hint  : 'Zoom in for details on individual crashes'),
      hintPoints: d.hintPoints != null ? d.hintPoints
                 : (g.hintPoints != null ? g.hintPoints : 'Click a dot for crash details'),
      source:  d.source  != null ? d.source : (g.source != null ? g.source : 'Source: Arkansas State Patrol via ARDOT'),
    };
  }

  // ---- one embedded map -----------------------------------------------------
  function build(root, opts, maplibregl) {
    root.classList.add('arcm-root');
    root.innerHTML = '';

    // Unique ids so <label for> stays correct with several maps on one page.
    var uid = 'arcm-' + Math.random().toString(36).slice(2, 8);

    // A labelled <select> in its own flex cell.
    function field(id, labelText, options, value) {
      var wrap = el('div', 'arcm-field');
      var label = el('label', null, labelText);
      label.htmlFor = id;
      var sel = document.createElement('select');
      sel.id = id;
      options.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o[0]; opt.textContent = o[1];
        sel.appendChild(opt);
      });
      sel.value = value;
      wrap.appendChild(label);
      wrap.appendChild(sel);
      return { wrap: wrap, select: sel };
    }

    if (opts.title) root.appendChild(el('h2', 'arcm-title', esc(opts.title)));

    var controls = el('div', 'arcm-controls');
    var measure = field(uid + '-measure', 'Filter by',
      MEASURE_ORDER.map(function (k) { return [k, MEASURES[k].label]; }),
      MEASURES[opts.measure] ? opts.measure : 'crash_count');
    var year = field(uid + '-year', 'Year', YEARS,
      YEARS.some(function (y) { return y[0] === opts.year; }) ? opts.year : '0');
    controls.appendChild(measure.wrap);
    controls.appendChild(year.wrap);
    root.appendChild(controls);
    var measureSel = measure.select, yearSel = year.select;

    // The note swaps at POINT_ZOOM (see updateLayerInfo) — telling the reader to
    // zoom in is wrong once they are already looking at individual crashes.
    var hintEl = null;
    if (opts.hint || opts.hintPoints) {
      hintEl = el('div', 'arcm-hint', esc(opts.hint));
      root.appendChild(hintEl);
    }

    // data-height sizes the MAP, not the whole widget — the controls and legend
    // now sit outside it, so sizing the widget would squeeze the map instead.
    var mapEl = el('div', 'arcm-map');
    if (opts.height) mapEl.style.height = opts.height;
    root.appendChild(mapEl);

    // Bin-size badge beside the legend: a pointy-top hexagon matching the map's
    // bins, with the current edge length inside it.
    var legendWrap = el('div', 'arcm-legendwrap');
    var badge = el('span', 'arcm-hexbadge');
    badge.title = 'Current hexagon size';
    badge.innerHTML =
      '<svg viewBox="0 0 46 52" width="46" height="52" role="img" aria-label="Hexagon bin size">' +
      '<polygon points="23,1 45,13.75 45,38.25 23,51 1,38.25 1,13.75"></polygon>' +
      '<text x="23" y="26" dy="0.35em" text-anchor="middle">8 km</text></svg>';
    var hexText = badge.querySelector('text');
    var legend = el('div', 'arcm-legend');
    legendWrap.appendChild(badge);
    legendWrap.appendChild(legend);
    root.appendChild(legendWrap);

    if (opts.source) root.appendChild(el('div', 'arcm-meta', esc(opts.source)));

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
      var items = RAMP.map(function (c, i) {
        var lo = b[i], hi = b[i + 1];
        var label = hi ? num(lo) + '–' + num(hi) : num(lo) + '+';
        return '<span class="arcm-item"><span class="arcm-swatch" style="background:' + c + '"></span>' + label + '</span>';
      }).join('');
      legend.innerHTML = '<span class="arcm-legend-title">' + MEASURES[measure].label + '</span>' + items;
    }

    function buildSeverityLegend() {
      var items = SEVERITY.concat([SEVERITY_DEFAULT]).map(function (s) {
        return '<span class="arcm-item"><span class="arcm-swatch arcm-dot" style="background:' + s.color + '"></span>' + s.label + '</span>';
      }).join('');
      legend.innerHTML = '<span class="arcm-legend-title">Crash severity</span>' + items;
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

    // Edge length of the hex layer currently in view; null at point zoom, where
    // nothing is binned and the badge is hidden (severity legend takes over).
    function updateLayerInfo() {
      var z = map.getZoom();
      var label = z < 8 ? '8 km' : z < 10 ? '3 km' : z < 12 ? '1 km' : z < POINT_ZOOM ? '400 m' : null;
      badge.style.display = label ? '' : 'none';
      if (label) hexText.textContent = label;

      if (hintEl) {
        var text = z >= POINT_ZOOM ? opts.hintPoints : opts.hint;
        hintEl.textContent = text;
        hintEl.style.display = text ? '' : 'none';   // either line may be blanked
      }
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
