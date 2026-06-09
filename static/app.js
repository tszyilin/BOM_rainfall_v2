/* ============================================================
   BOM Rainfall Downloader — Main Application
   ============================================================ */

"use strict";

const API = window.location.origin;

// ── Dark mode helpers ─────────────────────────────────────────────────────────
function isDark() { return document.documentElement.dataset.theme === "dark"; }

/** Returns Plotly background colours tuned for the current theme. */
function plotBg() {
  return isDark()
    ? { paper: "#1e2530", plot: "#1a2232", grid: "#2d3c52", zero: "#2d3c52", text: "#dde6f0" }
    : { paper: "#ffffff", plot: "#fafbfc", grid: "#eeeeee", zero: "#dddddd", text: "#444444" };
}

window.toggleDarkMode = function() {
  const dark = !isDark();
  document.documentElement.dataset.theme = dark ? "dark" : "";
  localStorage.setItem("rf-dark", dark ? "1" : "");

  // Update button label
  const btn = document.getElementById("dark-toggle-btn");
  if (btn) btn.textContent = dark ? "☀️ Light" : "🌙 Dark";

  // Re-colour every rendered Plotly chart instantly
  const bg = plotBg();
  ["daily-chart-area", "monthly-chart-area", "annual-chart-area", "compare-chart-area",
   "ams-chart-area", "ifd-chart-area", "cumulative-chart-area"].forEach(id => {
    const el = document.getElementById(id);
    if (el?._fullLayout) {
      Plotly.relayout(id, {
        paper_bgcolor: bg.paper,
        plot_bgcolor:  bg.plot,
        "yaxis.gridcolor": bg.grid,
        "xaxis.gridcolor": bg.grid,
        "yaxis.zerolinecolor": bg.zero,
        "font.color": bg.text,
      });
    }
  });
};

// Apply stored dark preference on page load (button label sync)
(function() {
  const btn = document.getElementById("dark-toggle-btn");
  if (btn && isDark()) btn.textContent = "☀️ Light";
})();

// IFD AEP colours (50% → 1 in 2000)
const IFD_COLORS = [
  "#1abc9c",  // 63.2%
  "#27ae60",  // 50%
  "#2ecc71",  // 20%
  "#f1c40f",  // 10%
  "#e67e22",  // 5%
  "#e74c3c",  // 2%
  "#c0392b",  // 1%
  "#922b21",  // 1 in 200
  "#8e44ad",  // 1 in 500
  "#6c3483",  // 1 in 1000
  "#4a235a",  // 1 in 2000
];
const IFD_PREFERRED = ["63.2%","50%","20%","10%","5%","2%","1%","1 in 200","1 in 500","1 in 1000","1 in 2000"];
const IFD_DEFAULTS  = new Set(["20%","10%","1%"]);

// Station comparison palette (up to 6 stations)
const COMPARE_COLORS = ["#1a6eb5","#e74c3c","#27ae60","#f39c12","#8e44ad","#16a085"];

// ── State ─────────────────────────────────────────────────────────────────────
const App = {
  allStations:  [],
  filtered:     [],
  selected:     null,    // {id, name, lat, lon, state, start_year, end_year, pct_complete}
  stationData:  null,    // {dates, values, quality, station}
  ifdData:      null,    // {aep: depth_mm, ...}
  favourites:   new Set(JSON.parse(localStorage.getItem("rf-favs") ?? "[]")),
  refLines:     JSON.parse(localStorage.getItem("rf-reflines") ?? "[]"),
  ifdChecked:   JSON.parse(localStorage.getItem("rf-ifd-checked") ?? "{}"),
  filters: { state: "", activeOnly: false, minPct: 0, radius: 100 },
  locationPin:  null,
  chartType:    "bar",   // 'bar' or 'line'
  yearRange:    [null, null],
  singleYear:   "",
  monthlyYear:  null,
  monthlyView:  "year",  // 'year' or 'allyears'
  monthlyMonth: 1,
  showFavsOnly: false,
  map:          null,
  markers:      {},
  clusterer:    null,
  locationMarker: null,
  activeTab:    "daily",
  dailyXRange:  null,    // persists pan/zoom across bar↔line toggle, reset on station/year change
  // Station comparison
  comparison:   [],      // [{id, name, data: null|{dates,values}}]
  compareView:  "annual", // 'annual' | 'monthly'
  compareMonth: 1,
  // Feature additions
  latestCache:  {},      // {stationId: {val, date}}
  amsThreshold: 30,
};

// ── Utilities ─────────────────────────────────────────────────────────────────
async function apiFetch(path, params = {}) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const r = await fetch(url);
  if (!r.ok) {
    let msg = `${r.status}: ${r.statusText}`;
    try { const j = await r.json(); msg = j.detail ?? msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2
          + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function pctBadgeClass(pct) {
  if (pct == null) return "";
  if (pct >= 90)   return "green";
  if (pct >= 70)   return "orange";
  return "red";
}

// Computed once after stations load — max end_year in the dataset
let _maxEndYear = null;
function stationColor(stn) {
  if (stn.end_year == null) return "#999";
  if (_maxEndYear === null) {
    _maxEndYear = Math.max(...App.allStations.map(s => s.end_year ?? 0));
  }
  return stn.end_year >= _maxEndYear - 1 ? "#27ae60" : "#e74c3c";
}

function saveFavs() {
  localStorage.setItem("rf-favs", JSON.stringify([...App.favourites]));
  updateBatchCounts();
}
function saveRefLines() {
  localStorage.setItem("rf-reflines", JSON.stringify(App.refLines));
}
function saveIfdChecked() {
  localStorage.setItem("rf-ifd-checked", JSON.stringify(App.ifdChecked));
}

// ── Map Init ──────────────────────────────────────────────────────────────────
function initMap() {
  App.map = L.map("map", {
    center: [-25.5, 134],
    zoom:   4,
    zoomControl: true,
    preferCanvas: true,
  });

  // OSM tiles — free, no API key, no rate-limit issues
  L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }
  ).addTo(App.map);

  // Force correct size after layout is settled (fixes 0-height init)
  setTimeout(() => {
    App.map.invalidateSize();
    App.map.setView([-25.5, 134], 4);
  }, 200);

  App.clusterer = L.markerClusterGroup({
    maxClusterRadius: 60,
    showCoverageOnHover: false,
    iconCreateFunction(cluster) {
      const n = cluster.getChildCount();
      const size = n > 50 ? 40 : n > 20 ? 34 : 28;
      return L.divIcon({
        html: `<div style="
          width:${size}px;height:${size}px;
          background:var(--primary);color:#fff;
          border-radius:50%;display:flex;align-items:center;justify-content:center;
          font-size:${size > 34 ? 13 : 11}px;font-weight:700;
          box-shadow:0 2px 8px rgba(0,0,0,.25);
          border:2px solid #fff;
        ">${n}</div>`,
        className: "",
        iconSize: [size, size],
        iconAnchor: [size/2, size/2],
      });
    },
  });
  App.map.addLayer(App.clusterer);
}

function makeMarker(stn) {
  const color = stationColor(stn);
  const icon = L.divIcon({
    html: `<div style="
      width:11px;height:11px;border-radius:50%;
      background:${color};border:2px solid #fff;
      box-shadow:0 1px 4px rgba(0,0,0,.35);
    "></div>`,
    className: "",
    iconSize: [11, 11],
    iconAnchor: [5.5, 5.5],
    popupAnchor: [0, -8],
  });

  const marker = L.marker([stn.lat, stn.lon], { icon });
  const pctStr = stn.pct_complete != null ? `${stn.pct_complete}%` : "?";
  marker.bindPopup(`
    <div class="stn-popup">
      <h4 style="color:${color}">${stn.name}</h4>
      <div class="meta">${stn.state} · ${stn.lat?.toFixed(4)}°, ${stn.lon?.toFixed(4)}°</div>
      <div class="meta">ID: ${stn.id} · ${stn.start_year ?? "?"}–${stn.end_year ?? "?"} · ${pctStr} complete</div>
      <button class="popup-btn" onclick="selectStation('${stn.id}')">🌧️ View rainfall</button>
    </div>`, { maxWidth: 230 });
  marker.on("click", () => selectStation(stn.id));
  return marker;
}

// ── Load Stations ─────────────────────────────────────────────────────────────
async function loadStations() {
  try {
    App.allStations = await apiFetch("/api/stations");
    App.filtered = [...App.allStations];
    addAllMarkers(App.allStations);
    renderFavList();
    prefetchFavLatest();   // populate latest readings in background
  } catch (e) {
    console.error("Failed to load stations:", e);
  }
}

// Silently fetch the latest reading for each saved favourite so it appears on load
async function prefetchFavLatest() {
  for (const id of App.favourites) {
    try {
      const data = await apiFetch(`/api/stations/${id}/data`);
      const dates  = data.dates  ?? [];
      const values = data.values ?? [];
      let latestVal = null, latestDate = null;
      for (let i = dates.length - 1; i >= 0; i--) {
        if (values[i] != null) { latestVal = values[i]; latestDate = dates[i]; break; }
      }
      if (latestDate) {
        App.latestCache[id] = { val: latestVal, date: latestDate };
        renderFavList();
      }
    } catch {}  // skip silently if a station fails
  }
}

function addAllMarkers(stations) {
  App.clusterer.clearLayers();
  App.markers = {};
  const batch = [];
  for (const stn of stations) {
    if (!stn.lat || !stn.lon) continue;
    const m = makeMarker(stn);
    App.markers[stn.id] = m;
    batch.push(m);
  }
  App.clusterer.addLayers(batch);
}

function updateMarkersVisibility() {
  const visibleIds = new Set(App.filtered.map(s => s.id));
  App.clusterer.clearLayers();
  const visible = [];
  for (const [id, m] of Object.entries(App.markers)) {
    if (visibleIds.has(id)) visible.push(m);
  }
  App.clusterer.addLayers(visible);
}

// ── Filtering ─────────────────────────────────────────────────────────────────
function applyFilters() {
  let stns = [...App.allStations];

  if (App.filters.state) {
    stns = stns.filter(s => (s.state ?? "").toUpperCase() === App.filters.state.toUpperCase());
  }
  if (App.filters.activeOnly) {
    const curYear = new Date().getFullYear();
    stns = stns.filter(s => s.end_year != null && s.end_year >= curYear - 1);
  }
  if (App.filters.minPct > 0) {
    stns = stns.filter(s => (s.pct_complete ?? 0) >= App.filters.minPct);
  }
  if (App.locationPin) {
    const { lat, lon } = App.locationPin;
    stns = stns.filter(s => {
      if (!s.lat || !s.lon) return false;
      return haversine(lat, lon, s.lat, s.lon) <= App.filters.radius;
    });
    stns.sort((a, b) =>
      haversine(lat, lon, a.lat, a.lon) - haversine(lat, lon, b.lat, b.lon)
    );
  }
  if (App.showFavsOnly) stns = stns.filter(s => App.favourites.has(s.id));

  App.filtered = stns;
  updateMarkersVisibility();
  updateBatchCounts();
}

function renderFavList() {
  const el    = document.getElementById("fav-list");
  const count = document.getElementById("fav-count");
  const favStns = App.allStations.filter(s => App.favourites.has(s.id));
  count.textContent = favStns.length ? `(${favStns.length})` : "";

  if (!favStns.length) {
    el.innerHTML = '<div style="font-size:.8em;color:var(--text-muted);padding:0 0 10px">No favourites yet — click ☆ on a station.</div>';
    return;
  }
  el.innerHTML = favStns.map(s => {
    const lc = App.latestCache[s.id];
    const latestHtml = lc
      ? `<span class="fav-latest">${lc.date.slice(8,10)}/${lc.date.slice(5,7)}/${lc.date.slice(0,4)}: ${lc.val} mm</span>`
      : "";
    return `
    <div class="station-card" onclick="selectStation('${s.id}')">
      <div class="station-dot" style="background:${stationColor(s)}"></div>
      <div class="station-info">
        <div class="station-name" style="display:flex;align-items:center;gap:5px">
          <span class="stn-id-tag">#${s.id}</span>${escHtml(s.name)}
        </div>
        <div class="station-meta" style="display:flex;gap:8px;align-items:center">
          ${s.state}${latestHtml}
        </div>
      </div>
      <button class="fav-star on" onclick="event.stopPropagation();toggleFav('${s.id}')">★</button>
    </div>`;
  }).join("");
}

// ── Favourites ────────────────────────────────────────────────────────────────
window.toggleFav = function(id) {
  if (App.favourites.has(id)) App.favourites.delete(id);
  else App.favourites.add(id);
  saveFavs();
  renderFavList();
  updatePanelFavBtn();
};

function updatePanelFavBtn() {
  const btn = document.getElementById("panel-fav-btn");
  if (!App.selected) return;
  const on = App.favourites.has(App.selected.id);
  btn.textContent = on ? "★ Favourited" : "☆ Favourite";
  btn.classList.toggle("on", on);
}

// ── Select Station ────────────────────────────────────────────────────────────
window.selectStation = async function(id) {
  id = String(id).padStart(6, "0");
  App.dailyXRange = null;   // new station → reset range slider position
  const stn = App.allStations.find(s => s.id === id);
  if (!stn) {
    // Might not be in list yet — try fetching data anyway
    App.selected = { id, name: id, lat: null, lon: null, state: "?", pct_complete: null };
  } else {
    App.selected = stn;
    // Highlight sidebar
    document.querySelectorAll(".station-card").forEach(el => {
      el.classList.toggle("selected", el.dataset.id === id);
    });
    // Pan map
    if (stn.lat && stn.lon) {
      App.map.setView([stn.lat, stn.lon], Math.max(App.map.getZoom(), 8), { animate: true });
    }
  }

  openPanel(App.selected);
  await loadStationData(id);
};

// ── Detail Panel ──────────────────────────────────────────────────────────────
function buildPanelMeta(lat, lon, opened, period, latest) {
  const f = (lbl, val) =>
    `<span class="mi-lbl">${lbl}</span> ${val}`;
  const s = `<span class="mi-sep">·</span>`;
  return [
    f("Lat:",    lat),
    f("Long:",   lon),
    f("Opened:", opened),
    f("Period:", period),
    f("Latest:", latest),
  ].join(s);
}

function openPanel(stn) {
  const panel = document.getElementById("detail-panel");
  panel.classList.add("open");
  document.getElementById("detail-panel-sizer")?.classList.add("open");

  document.getElementById("panel-stn-id").textContent = `#${stn.id}`;
  document.getElementById("panel-name").textContent = stn.name;
  // Preliminary meta from station list (lat/lon/open year available immediately)
  const _lat = stn.lat != null ? stn.lat.toFixed(4) + "°" : "—";
  const _lon = stn.lon != null ? stn.lon.toFixed(4) + "°" : "—";
  const _opn = stn.start_year ?? "—";
  document.getElementById("panel-meta").innerHTML = buildPanelMeta(_lat, _lon, _opn, "—", "—");

  // BOM source link — constructable from station ID alone
  const bomLink = document.getElementById("panel-bom-link");
  if (bomLink) {
    bomLink.href = `https://www.bom.gov.au/jsp/ncc/cdio/weatherData/av` +
      `?p_nccObsCode=136&p_display_type=dailyDataFile&p_startYear=&p_c=&p_stn_num=${stn.id}`;
    bomLink.style.display = "";
  }

  updatePanelFavBtn();
  updatePanelCompareBtn();

  // Enable the right-panel Add button
  const addBtn = document.getElementById("rp-add-btn");
  if (addBtn) addBtn.disabled = false;

  // IFD: reset
  document.getElementById("ifd-content").innerHTML =
    '<div style="font-size:.78em;color:var(--text-muted)">Loading IFD data…</div>';

  setTimeout(() => {
    if (App.map) App.map.invalidateSize();
  }, 320);
}

function closePanel() {
  document.getElementById("detail-panel").classList.remove("open");
  document.getElementById("detail-panel-sizer")?.classList.remove("open");
  App.selected     = null;
  App.stationData  = null;
  App.ifdData      = null;
  updatePanelCompareBtn();
  const bomLink = document.getElementById("panel-bom-link");
  if (bomLink) { bomLink.style.display = "none"; bomLink.href = "#"; }
  setTimeout(() => { if (App.map) App.map.invalidateSize(); }, 320);
}

// ── Station Comparison ────────────────────────────────────────────────────────
function updatePanelCompareBtn() {
  const btn = document.getElementById("panel-compare-btn");
  if (!btn) return;
  const inList = App.selected && App.comparison.some(c => c.id === App.selected.id);
  btn.classList.toggle("on", !!inList);
  btn.textContent = inList ? "⚖ Added" : "⚖ Compare";
}

window.addToComparison = function() {
  if (!App.selected) return;
  const { id, name } = App.selected;
  if (App.comparison.some(c => c.id === id)) {
    // Already there — toggle off (remove)
    removeFromComparison(id);
    return;
  }
  if (App.comparison.length >= 6) {
    alert("Maximum 6 stations in comparison.");
    return;
  }
  App.comparison.push({ id, name, data: null });
  updatePanelCompareBtn();
  renderCompareList();
  // Fetch data in background
  apiFetch(`/api/stations/${id}/data`)
    .then(data => {
      const item = App.comparison.find(c => c.id === id);
      if (item) { item.data = data; renderCompareList(); loadCompareChart(); }
    })
    .catch(() => {
      const item = App.comparison.find(c => c.id === id);
      if (item) { item.data = "error"; renderCompareList(); loadCompareChart(); }
    });
};

window.removeFromComparison = function(id) {
  App.comparison = App.comparison.filter(c => c.id !== id);
  if (App.selected?.id === id) updatePanelCompareBtn();
  renderCompareList();
  loadCompareChart();
};

window.clearComparison = function() {
  App.comparison = [];
  updatePanelCompareBtn();
  renderCompareList();
  const el = document.getElementById("compare-chart-area");
  if (el) {
    try { Plotly.purge("compare-chart-area"); } catch {}
    el.innerHTML = '<div class="empty-msg"><div class="big-icon">⚖️</div>Add 2+ stations</div>';
  }
};

function renderCompareList() {
  const el = document.getElementById("compare-list");
  const viewRow = document.getElementById("compare-view-row");
  if (!el) return;

  if (!App.comparison.length) {
    el.innerHTML = '<div class="rp-empty">Select a station then click Add</div>';
    if (viewRow) viewRow.style.display = "none";
    return;
  }
  if (viewRow) viewRow.style.display = "";

  el.innerHTML = App.comparison.map((c, i) => {
    const color = COMPARE_COLORS[i] ?? "#999";
    const spinner = c.data === null
      ? `<div class="compare-spinner"></div>`
      : c.data === "error"
        ? `<span title="Failed to load" style="color:#e74c3c;font-size:.9em">⚠</span>`
        : "";
    return `
      <div class="compare-item">
        <div class="compare-dot" style="background:${color}"></div>
        <div class="compare-info">
          <div class="compare-name" style="display:flex;align-items:center;gap:5px">
            <span class="stn-id-tag">#${c.id}</span>${escHtml(c.name)}
          </div>
        </div>
        ${spinner}
        <button class="compare-remove-btn" onclick="removeFromComparison('${c.id}')" title="Remove">✕</button>
      </div>`;
  }).join("");
}

window.setCompareView = function(view) {
  App.compareView = view;
  document.getElementById("cv-annual").classList.toggle("active", view === "annual");
  document.getElementById("cv-monthly").classList.toggle("active", view === "monthly");
  const mSel = document.getElementById("cv-month-sel");
  if (mSel) mSel.style.display = view === "monthly" ? "" : "none";
  loadCompareChart();
};

document.getElementById("cv-month-sel")?.addEventListener("change", e => {
  App.compareMonth = +e.target.value;
  loadCompareChart();
});

function loadCompareChart() {
  const el = document.getElementById("compare-chart-area");
  if (!el) return;

  const ready = App.comparison.filter(c => c.data && c.data !== "error");
  if (ready.length < 1) return;

  const bg = plotBg();
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  let traces;
  if (App.compareView === "annual") {
    traces = ready.map((c, i) => {
      const annual = {};
      c.data.dates.forEach((d, j) => {
        const yr = parseInt(d.slice(0, 4));
        const v  = c.data.values[j];
        annual[yr] = (annual[yr] ?? 0) + (v ?? 0);
      });
      const yrs = Object.keys(annual).map(Number).sort((a, b) => a - b);
      return {
        x: yrs,
        y: yrs.map(yr => Math.round(annual[yr] * 10) / 10),
        type: "scatter", mode: "lines",
        name: c.name,
        line: { color: COMPARE_COLORS[App.comparison.indexOf(c)] ?? "#999", width: 2 },
      };
    });
  } else {
    // Monthly view: all-years bar for selected month, one trace per station
    const mo = App.compareMonth;
    traces = ready.map((c, i) => {
      const byYear = {};
      c.data.dates.forEach((d, j) => {
        if (parseInt(d.slice(5, 7)) !== mo) return;
        const yr = parseInt(d.slice(0, 4));
        const v  = c.data.values[j];
        byYear[yr] = (byYear[yr] ?? 0) + (v ?? 0);
      });
      const yrs = Object.keys(byYear).map(Number).sort((a, b) => a - b);
      return {
        x: yrs,
        y: yrs.map(yr => Math.round(byYear[yr] * 10) / 10),
        type: "bar",
        name: c.name,
        marker: { color: COMPARE_COLORS[App.comparison.indexOf(c)] ?? "#999", opacity: 0.82 },
      };
    });
  }

  const titleText = App.compareView === "annual"
    ? "Annual Rainfall (mm)"
    : `${MONTHS[App.compareMonth - 1]} Rainfall (mm)`;

  Plotly.react("compare-chart-area", traces, {
    margin: { t: 8, r: 8, b: 40, l: 52 },
    paper_bgcolor: bg.paper,
    plot_bgcolor:  bg.plot,
    yaxis: { title: titleText, gridcolor: bg.grid, zeroline: false, titlefont: { size: 10 } },
    xaxis: { gridcolor: bg.grid },
    legend: { orientation: "h", y: -0.25, font: { size: 9 } },
    font:   { family: "Inter, sans-serif", size: 10, color: bg.text },
    barmode: "group",
  }, { responsive: true, displayModeBar: false });
}

// ── Load Station Data ─────────────────────────────────────────────────────────
async function loadStationData(id) {
  const area = document.getElementById("daily-chart-area");
  showLoading(area);
  showLoading("monthly-chart-area");
  showLoading("annual-chart-area");

  try {
    const distribute = document.getElementById("dl-distribute")?.checked ?? true;
    App.stationData = await apiFetch(`/api/stations/${id}/data`, { distribute });

    // Update panel header with full station info + data stats
    const si = App.stationData.station;
    if (si) {
      const status = si.is_open === true
        ? '<span class="status-open">Open</span>'
        : si.is_open === false
          ? '<span class="status-closed">Closed</span>'
          : "";
      document.getElementById("panel-stn-id").textContent = `#${id}`;
      document.getElementById("panel-name").innerHTML =
        `${escHtml(si.name || App.selected.name)} &nbsp;${status}`;

      const latStr = si.lat != null ? si.lat.toFixed(4) + "°" : "—";
      const lonStr = si.lon != null ? si.lon.toFixed(4) + "°" : "—";
      const openedStr = si.opened ?? "—";

      // Data period: first → last recorded date
      const allDates  = App.stationData.dates  ?? [];
      const allValues = App.stationData.values ?? [];
      const firstYear = allDates.length ? allDates[0].slice(0,4) : "—";
      const lastYear  = allDates.length ? allDates[allDates.length-1].slice(0,4) : "—";
      const period    = firstYear !== "—" ? `${firstYear}–${lastYear}` : "—";

      // Latest reading: last non-null value
      let latestVal = null, latestDate = null;
      for (let i = allDates.length - 1; i >= 0; i--) {
        if (allValues[i] != null) { latestVal = allValues[i]; latestDate = allDates[i]; break; }
      }
      const latestStr = latestDate
        ? `${latestVal} mm (${latestDate.slice(8,10)}/${latestDate.slice(5,7)}/${latestDate.slice(0,4)})`
        : "—";

      // Cache for fav list display — refresh the list so latest reading appears immediately
      if (latestDate) {
        App.latestCache[id] = { val: latestVal, date: latestDate };
        renderFavList();
      }

      document.getElementById("panel-meta").innerHTML =
        buildPanelMeta(latStr, lonStr, openedStr, period, latestStr);
    }

    // Populate year range selects
    populateYearSelects(App.stationData.dates);

    // Load IFD
    const lat = si?.lat ?? App.selected?.lat;
    const lon = si?.lon ?? App.selected?.lon;
    if (lat != null && lon != null) {
      loadIFD(lat, lon);
    }

    // Render active tab
    loadCurrentTab();
  } catch (e) {
    hideLoading(area);
    hideLoading("monthly-chart-area");
    hideLoading("annual-chart-area");
    area.innerHTML = `<div class="empty-msg"><div class="big-icon">⚠️</div>${e.message}</div>`;
    document.getElementById("monthly-chart-area").innerHTML =
      `<div class="empty-msg"><div class="big-icon">⚠️</div>${e.message}</div>`;
    document.getElementById("annual-chart-area").innerHTML =
      `<div class="empty-msg"><div class="big-icon">⚠️</div>${e.message}</div>`;
  }
}

// ── Year range selects ────────────────────────────────────────────────────────
function populateYearSelects(dates) {
  if (!dates?.length) return;
  const years = [...new Set(dates.map(d => parseInt(d.slice(0, 4))))].sort((a, b) => a - b);
  const y1 = years[0], y2 = years[years.length - 1];

  ["yr-start", "yr-end"].forEach(id => {
    const sel = document.getElementById(id);
    sel.innerHTML = "";
    for (let y = y2; y >= y1; y--) {
      const opt = document.createElement("option");
      opt.value = y; opt.textContent = y;
      sel.appendChild(opt);
    }
  });
  // Default: last 5 years
  App.yearRange = [Math.max(y1, y2 - 4), y2];
  document.getElementById("yr-start").value = App.yearRange[0];
  document.getElementById("yr-end").value   = App.yearRange[1];

  // Single year select
  const sinSel = document.getElementById("yr-single");
  sinSel.innerHTML = '<option value="">All</option>';
  for (let y = y2; y >= y1; y--) {
    const opt = document.createElement("option");
    opt.value = y; opt.textContent = y;
    sinSel.appendChild(opt);
  }
  sinSel.value = "";
  App.singleYear = "";

  // Monthly year
  const mSel = document.getElementById("monthly-yr-select");
  mSel.innerHTML = "";
  for (let y = y2; y >= y1; y--) {
    const opt = document.createElement("option");
    opt.value = y; opt.textContent = y;
    mSel.appendChild(opt);
  }
  mSel.value = y2;
  App.monthlyYear = y2;
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    if (!btn.dataset.tab) return;   // buttons without data-tab handle their own onclick
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.getElementById(`tab-${tab}`).classList.add("active");
    App.activeTab = tab;
    if (App.stationData) loadCurrentTab();
  });
});

function loadCurrentTab() {
  if (!App.stationData) return;
  if (App.activeTab === "daily")      loadDailyChart();
  if (App.activeTab === "monthly")    loadMonthlyChart();
  if (App.activeTab === "annual")     loadAnnualChart();
  if (App.activeTab === "missing")    loadMissingDaysTab();
  if (App.activeTab === "ams")        loadAMSTab();
  if (App.activeTab === "ifd-chart")  loadIFDChart();
  if (App.activeTab === "cumulative") loadCumulativeTab();
}

// ── Daily Chart ───────────────────────────────────────────────────────────────
function loadDailyChart() {
  const area = document.getElementById("daily-chart-area");
  hideLoading(area);
  const data = App.stationData;
  if (!data) return;

  // Filter by year range
  let dates  = data.dates;
  let values = data.values;
  const singleYr = App.singleYear;
  const [y1, y2] = App.yearRange;

  if (singleYr) {
    const pairs = dates.map((d, i) => [d, values[i]]).filter(([d]) => d.startsWith(singleYr));
    dates  = pairs.map(p => p[0]);
    values = pairs.map(p => p[1]);
  } else {
    const pairs = dates.map((d, i) => [d, values[i]]).filter(([d]) => {
      const yr = parseInt(d.slice(0, 4));
      return yr >= y1 && yr <= y2;
    });
    dates  = pairs.map(p => p[0]);
    values = pairs.map(p => p[1]);
  }

  if (!dates.length) {
    area.innerHTML = '<div class="empty-msg"><div class="big-icon">📭</div>No data for this period</div>';
    return;
  }

  let plotDates  = dates;
  let plotValues = values;

  if (App.chartType === "bar") {
    // For bar charts, drop null/zero days entirely — Plotly shows a warning
    // triangle when the y array contains null, and empty bars for 0mm days
    // clutter the chart. Only plot days with actual rain.
    const nonNull = dates
      .map((d, i) => [d, values[i]])
      .filter(([, v]) => v !== null && v !== undefined);
    plotDates  = nonNull.map(p => p[0]);
    plotValues = nonNull.map(p => p[1]);
  }
  // For line mode, keep nulls — Plotly uses them as gap markers (connectgaps:false)

  if (!plotDates.length) {
    area.innerHTML = '<div class="empty-msg"><div class="big-icon">📭</div>No recorded rainfall for this period</div>';
    return;
  }

  const trace = {
    x:    plotDates,
    y:    plotValues,
    type: App.chartType === "bar" ? "bar" : "scatter",
    mode: App.chartType === "bar" ? undefined : "lines",
    marker: { color: "#1a6eb5", opacity: App.chartType === "bar" ? 0.8 : 1 },
    line:   { color: "#1a6eb5", width: 1.2 },
    name: "Rainfall",
    connectgaps: false,
    hovertemplate: "<b>%{x}</b><br>%{y} mm<extra></extra>",
  };

  const dataMax = plotValues.reduce((m, v) => (v != null && v > m ? v : m), 0);
  const layout  = buildDailyLayout(dataMax);

  // Purge any stale plot state (prevents y-axis range from being cached
  // from a previous station or different year range).
  const chartEl = document.getElementById("daily-chart-area");
  if (chartEl && chartEl._fullLayout) Plotly.purge(chartEl);

  Plotly.react("daily-chart-area", [trace], layout, {
    responsive: true, displayModeBar: false,
  });

  // The panel opens with a 300 ms CSS transition; Plotly may render during the
  // animation when the container is still small.  Force a resize once the
  // animation has settled so the chart fills its proper height.
  setTimeout(() => {
    const g = document.getElementById("daily-chart-area");
    if (g?._fullLayout) Plotly.Plots.resize(g);
  }, 350);

  // Save pan/zoom state so it survives bar↔line toggles
  const gd = document.getElementById("daily-chart-area");
  gd.removeAllListeners("plotly_relayout");
  gd.on("plotly_relayout", ev => {
    // Rangeslider / user drag fires index keys; Plotly.relayout() fires array key
    if (ev["xaxis.range[0]"] !== undefined) {
      App.dailyXRange = [ev["xaxis.range[0]"], ev["xaxis.range[1]"]];
    } else if (Array.isArray(ev["xaxis.range"])) {
      App.dailyXRange = ev["xaxis.range"];
    } else if (ev["xaxis.autorange"] === true) {
      App.dailyXRange = null;
    }
  });
}

function buildDailyLayout(dataMax = 0) {
  // Collect shapes/annotations from IFD + ref lines
  const shapes = [];
  const annotations = [];

  // IFD lines
  if (App.ifdData) {
    const aepKeys = IFD_PREFERRED.filter(k => k in App.ifdData);
    aepKeys.forEach((aep, ci) => {
      const checked = App.ifdChecked[aep] ?? IFD_DEFAULTS.has(aep);
      if (!checked) return;
      const depth = App.ifdData[aep];
      const color = IFD_COLORS[ci] ?? "#999";
      shapes.push({
        type: "line", xref: "paper", x0: 0, x1: 1,
        yref: "y", y0: depth, y1: depth,
        line: { color, width: 1.5, dash: "dash" },
      });
      annotations.push({
        xref: "paper", x: 1, yref: "y", y: depth,
        text: `${aep} AEP — ${depth} mm`,
        showarrow: false, xanchor: "right", yanchor: "bottom",
        font: { color, size: 10 },
      });
    });
  }

  // Custom ref lines
  for (const ln of App.refLines) {
    if (ln.visible === false) continue;
    shapes.push({
      type: "line", xref: "paper", x0: 0, x1: 1,
      yref: "y", y0: ln.value, y1: ln.value,
      line: { color: ln.color, width: ln.width ?? 2, dash: ln.style ?? "dash" },
    });
    annotations.push({
      xref: "paper", x: 0.01, yref: "y", y: ln.value,
      text: `${escHtml(ln.label)} (${ln.value} mm)`,
      showarrow: false, xanchor: "left", yanchor: "bottom",
      font: { color: ln.color, size: 10 },
    });
  }

  // Compute y-axis ceiling: enough to show data bars AND any visible reference lines.
  // Always start at 0 so bars are never clipped at the bottom.
  const activeIFDDepths = [];
  if (App.ifdData) {
    IFD_PREFERRED.filter(k => k in App.ifdData).forEach(k => {
      if (App.ifdChecked[k] ?? IFD_DEFAULTS.has(k)) activeIFDDepths.push(App.ifdData[k]);
    });
  }
  const activeRefDepths = App.refLines
    .filter(l => l.visible !== false)
    .map(l => l.value);

  const allDepths = [...activeIFDDepths, ...activeRefDepths, dataMax];
  const yMax = Math.max(...allDepths, 10) * 1.08;  // 8% headroom, min 10 mm

  const bg = plotBg();
  return {
    margin: { t: 10, r: 10, b: 50, l: 60 },
    paper_bgcolor: bg.paper,
    plot_bgcolor:  bg.plot,
    yaxis: {
      title: "Rainfall (mm)",
      gridcolor: bg.grid,
      zeroline: true,
      zerolinecolor: bg.zero,
      range: [0, yMax],
      autorange: false,   // must be false when range is explicit
    },
    xaxis: {
      gridcolor: bg.grid,
      showgrid: false,
      // Restore saved pan/zoom (null → Plotly auto-ranges to full data span)
      ...(App.dailyXRange ? { range: App.dailyXRange } : {}),
      rangeslider: {
        visible: true,
        thickness: 0.07,
        bgcolor: bg.plot,
        bordercolor: bg.grid,
        borderwidth: 1,
      },
    },
    showlegend: false,
    font: { family: "Inter, sans-serif", size: 11, color: bg.text },
    shapes,
    annotations,
    bargap: 0,
  };
}

// ── IFD ───────────────────────────────────────────────────────────────────────
async function loadIFD(lat, lon) {
  const contentEl = document.getElementById("ifd-content");
  contentEl.innerHTML = '<div style="font-size:.78em;color:var(--text-muted)">Fetching IFD data…</div>';
  try {
    App.ifdData = await apiFetch("/api/ifd", { lat, lon });
    renderIFDPanel();
    if (App.activeTab === "ifd-chart") loadIFDChart();
    if (App.activeTab === "ams") loadAMSTab();
  } catch (e) {
    App.ifdData = null;
    const msg = e.message.startsWith("404")
      ? "Outside BOM IFD coverage area (Australian mainland only)"
      : `IFD unavailable: ${e.message}`;
    contentEl.innerHTML = `<div style="font-size:.78em;color:var(--text-muted)">${msg}</div>`;
  }
}

function renderIFDPanel() {
  const el = document.getElementById("ifd-content");
  if (!App.ifdData) {
    el.innerHTML = '<div style="font-size:.78em;color:var(--text-muted)">No IFD data.</div>';
    return;
  }

  const aepKeys = IFD_PREFERRED.filter(k => k in App.ifdData);
  const activeCount = aepKeys.filter(k => App.ifdChecked[k] ?? IFD_DEFAULTS.has(k)).length;

  // Update header
  const hdr = document.getElementById("ifd-header-text");
  hdr.textContent = `📐 IFD Reference Lines${activeCount ? ` (${activeCount} active)` : ""}`;

  el.innerHTML = `
    <div class="ifd-grid">
      ${aepKeys.map((aep, ci) => {
        const color   = IFD_COLORS[ci] ?? "#999";
        const depth   = App.ifdData[aep];
        const checked = App.ifdChecked[aep] ?? IFD_DEFAULTS.has(aep);
        return `
          <label class="ifd-chk-row">
            <input type="checkbox" ${checked ? "checked" : ""}
                   onchange="toggleIFD('${aep}', this.checked)"
                   style="accent-color:${color}">
            <span class="ifd-color-dot" style="background:${color}"></span>
            <span style="color:${color}">${aep}</span>
            <span style="color:var(--text-muted);font-size:.85em">— ${depth} mm</span>
          </label>`;
      }).join("")}
    </div>`;
}

window.toggleIFD = function(aep, checked) {
  App.ifdChecked[aep] = checked;
  saveIfdChecked();
  renderIFDPanel();
  if (App.activeTab === "daily" && App.stationData) loadDailyChart();
};

// ── Custom Reference Lines ────────────────────────────────────────────────────
const STYLE_LABELS = { solid:"—", dash:"– –", dot:"··", longdash:"—— ", dashdot:"–·" };

function renderRefLines() {
  const el  = document.getElementById("ref-line-list");
  const hdr = document.getElementById("ref-header-text");
  const active = App.refLines.filter(l => l.visible !== false).length;
  if (hdr) hdr.textContent = `📏 Custom Reference Lines${active ? ` (${active} shown)` : ""}`;

  if (!App.refLines.length) { el.innerHTML = ""; return; }
  el.innerHTML = App.refLines.map((ln, i) => {
    const vis     = ln.visible !== false;
    const styleLbl = STYLE_LABELS[ln.style ?? "dash"] ?? "– –";
    const widthPx  = ln.width  ?? 2;
    return `
    <div class="ref-line-item${vis ? "" : " ref-line-hidden"}">
      <button class="ref-line-vis" onclick="toggleRefLineVis(${i})" title="${vis ? "Hide line" : "Show line"}">
        ${vis ? "👁" : "🚫"}
      </button>
      <span class="ref-line-swatch" style="background:${ln.color}; height:${widthPx + 2}px"></span>
      <span class="ref-line-label" title="Double-click to edit"
            ondblclick="editRefField(${i},'label',this)">${escHtml(ln.label)}</span>
      <span class="ref-line-val"   title="Double-click to edit"
            ondblclick="editRefField(${i},'value',this)">${ln.value} mm</span>
      <span class="ref-line-style-badge" style="color:${ln.color}">${styleLbl} ${widthPx}px</span>
      <button class="ref-line-rm" onclick="removeRefLine(${i})" title="Remove">✕</button>
    </div>`;
  }).join("");
}

function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

window.addRefLine = function() {
  const val = parseFloat(document.getElementById("ref-val").value);
  if (!val || val <= 0) return;
  const label = document.getElementById("ref-lbl").value.trim() || `${val} mm`;
  const color = document.getElementById("ref-col").value;
  const style = document.getElementById("ref-style").value;
  const width = parseInt(document.getElementById("ref-width").value, 10);
  App.refLines.push({ value: val, label, color, style, width, visible: true });
  saveRefLines();
  renderRefLines();
  document.getElementById("ref-val").value = "";
  document.getElementById("ref-lbl").value = "";
  if (App.activeTab === "daily" && App.stationData) {
    loadDailyChart();
  } else if (!App.stationData) {
    // Show brief hint so user knows the line was saved
    const hdr = document.getElementById("ref-header-text");
    const orig = hdr.textContent;
    hdr.textContent = "📏 Line saved — select a station to display";
    setTimeout(() => renderRefLines(), 2000);
  }
};

window.removeRefLine = function(i) {
  App.refLines.splice(i, 1);
  saveRefLines();
  renderRefLines();
  if (App.activeTab === "daily" && App.stationData) loadDailyChart();
};

window.toggleRefLineVis = function(i) {
  App.refLines[i].visible = !(App.refLines[i].visible !== false);
  saveRefLines();
  renderRefLines();
  if (App.activeTab === "daily" && App.stationData) loadDailyChart();
};

window.editRefField = function(i, field, el) {
  const cur = field === "value" ? String(App.refLines[i].value) : App.refLines[i].label;
  const input = document.createElement("input");
  input.type = field === "value" ? "number" : "text";
  input.value = cur;
  input.className = "ref-inline-edit";
  input.style.width = (el.offsetWidth + 20) + "px";
  el.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    const v = input.value.trim();
    if (field === "value") {
      const n = parseFloat(v);
      if (n > 0) App.refLines[i].value = n;
    } else {
      if (v) App.refLines[i].label = v;
    }
    saveRefLines();
    renderRefLines();
    if (App.activeTab === "daily" && App.stationData) loadDailyChart();
  };
  input.addEventListener("blur",  commit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); input.blur(); }
                                           if (e.key === "Escape") { input.removeEventListener("blur", commit); renderRefLines(); } });
};

// ── Expander toggle ───────────────────────────────────────────────────────────
window.toggleExpander = function(which) {
  const hdr  = document.getElementById(`${which}-header`);
  const body = document.getElementById(`${which}-body`);
  const open = body.classList.toggle("open");
  hdr.classList.toggle("open", open);
  // Resize the daily chart after the CSS transition settles
  setTimeout(() => {
    const gd = document.getElementById("daily-chart-area");
    if (gd?._fullLayout) Plotly.Plots.resize(gd);
  }, 50);
};

// ── Monthly Chart ─────────────────────────────────────────────────────────────
function loadMonthlyChart() {
  const area = document.getElementById("monthly-chart-area");
  hideLoading(area);
  const data = App.stationData;
  if (!data?.dates?.length) return;

  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dim = (yr, mo) => new Date(yr, mo, 0).getDate();

  // Aggregate daily → monthly rainfall + count days with real values per month
  const monthly  = {};  // {year: {month: total}}
  const recorded = {};  // {year: {month: non-null day count}}
  data.dates.forEach((d, i) => {
    const yr = parseInt(d.slice(0, 4));
    const mo = parseInt(d.slice(5, 7));
    const v  = data.values[i];
    if (!monthly[yr])  monthly[yr]  = {};
    if (!recorded[yr]) recorded[yr] = {};
    monthly[yr][mo] = (monthly[yr][mo] ?? 0) + (v ?? 0);
    if (v !== null) recorded[yr][mo] = (recorded[yr][mo] ?? 0) + 1;
  });

  function missColor(missing, expected) {
    if (!expected || missing === 0) return "#1a6eb5";
    return (missing / expected) <= 0.05 ? "#f39c12" : "#e74c3c";
  }

  function missText(base, missing) {
    if (missing <= 0) return base;
    return `${base}<br>Missing: ${missing} day${missing !== 1 ? "s" : ""}`;
  }

  if (App.monthlyView === "year") {
    const yr    = App.monthlyYear;
    const mData = monthly[yr] ?? {};
    const xVals = MONTHS;

    const missingCounts = MONTHS.map((_, mi) => {
      const mo = mi + 1;
      const pres = recorded[yr]?.[mo] ?? 0;
      return Math.max(0, dim(yr, mo) - pres);
    });
    // Use 0 instead of null for absent months so Plotly still renders a bar anchor for the label
    const yVals  = MONTHS.map((_, mi) => round1(mData[mi + 1] ?? 0));
    const colors = MONTHS.map((_, mi) => {
      const mo = mi + 1;
      const pres = recorded[yr]?.[mo] ?? 0;
      if (pres === 0) return "#cccccc";
      return missColor(missingCounts[mi], dim(yr, mo));
    });
    const barLabels  = missingCounts.map(m => m > 0 ? `⚠ ${m} days` : "");
    const hoverTexts = MONTHS.map((_, mi) => {
      const pres = recorded[yr]?.[mi + 1] ?? 0;
      if (pres === 0) return `No data — ${missingCounts[mi]} days missing`;
      return missText(`${yVals[mi]} mm`, missingCounts[mi]);
    });

    const _mbg1 = plotBg();
    Plotly.react("monthly-chart-area", [{
      x: xVals, y: yVals, type: "bar",
      marker: { color: colors, opacity: 0.85 },
      text: barLabels,
      textposition: "outside",
      textfont: { size: 10, color: "#e67e22" },
      cliponaxis: false,
      customdata: hoverTexts,
      hovertemplate: "<b>%{x}</b><br>%{customdata}<extra></extra>",
    }], {
      margin: { t: 10, r: 10, b: 40, l: 60 },
      paper_bgcolor: _mbg1.paper, plot_bgcolor: _mbg1.plot,
      yaxis: { title: "Rainfall (mm)", gridcolor: _mbg1.grid, zeroline: false, autorange: true },
      xaxis: { gridcolor: _mbg1.grid },
      showlegend: false,
      font: { family: "Inter, sans-serif", size: 11, color: _mbg1.text },
      title: { text: `Monthly Rainfall — ${yr}`, font: { size: 13 } },
      uniformtext: { mode: "hide", minsize: 8 },
    }, { responsive: true, displayModeBar: false });

  } else {
    const mo   = App.monthlyMonth;
    const yrs  = Object.keys(monthly).map(Number).sort((a, b) => a - b);

    const missingCounts = yrs.map(yr => {
      const pres = recorded[yr]?.[mo] ?? 0;
      return Math.max(0, dim(yr, mo) - pres);
    });
    const yVals  = yrs.map(yr => round1(monthly[yr]?.[mo] ?? 0));
    const colors = yrs.map((yr, i) => {
      const pres = recorded[yr]?.[mo] ?? 0;
      if (pres === 0) return "#cccccc";
      return missColor(missingCounts[i], dim(yr, mo));
    });
    const barLabels  = missingCounts.map(m => m > 0 ? `⚠ ${m} days` : "");
    const hoverTexts = yrs.map((yr, i) => {
      const pres = recorded[yr]?.[mo] ?? 0;
      if (pres === 0) return `No data — ${missingCounts[i]} days missing`;
      return missText(`${yVals[i]} mm`, missingCounts[i]);
    });

    const _mbg2 = plotBg();
    Plotly.react("monthly-chart-area", [{
      x: yrs, y: yVals, type: "bar",
      marker: { color: colors, opacity: 0.85 },
      text: barLabels,
      textposition: "outside",
      textfont: { size: 10, color: "#e67e22" },
      cliponaxis: false,
      customdata: hoverTexts,
      hovertemplate: "<b>%{x}</b><br>%{customdata}<extra></extra>",
    }], {
      margin: { t: 10, r: 10, b: 40, l: 60 },
      paper_bgcolor: _mbg2.paper, plot_bgcolor: _mbg2.plot,
      yaxis: { title: "Rainfall (mm)", gridcolor: _mbg2.grid, zeroline: false, autorange: true },
      xaxis: { type: "linear", tickmode: "auto", gridcolor: _mbg2.grid },
      showlegend: false,
      font: { family: "Inter, sans-serif", size: 11, color: _mbg2.text },
      title: { text: `${MONTHS[mo - 1]} Rainfall — All Years`, font: { size: 13 } },
      uniformtext: { mode: "hide", minsize: 8 },
    }, { responsive: true, displayModeBar: false });
  }
}

// ── Annual Chart ──────────────────────────────────────────────────────────────
function loadAnnualChart() {
  const area = document.getElementById("annual-chart-area");
  hideLoading(area);
  const data = App.stationData;
  if (!data?.dates?.length) return;

  const dim = (yr, mo) => new Date(yr, mo, 0).getDate();

  // Aggregate daily → annual rainfall + count days with real values per month
  const annual   = {};
  const recorded = {};  // {year: {month: non-null day count}}
  data.dates.forEach((d, i) => {
    const yr = parseInt(d.slice(0, 4));
    const mo = parseInt(d.slice(5, 7));
    const v  = data.values[i];
    annual[yr] = (annual[yr] ?? 0) + (v ?? 0);
    if (!recorded[yr]) recorded[yr] = {};
    if (v !== null) recorded[yr][mo] = (recorded[yr][mo] ?? 0) + 1;
  });

  const allMonths  = [...new Set(data.dates.map(d => d.slice(0, 7)))].sort();
  const [firstYr, firstMo] = allMonths[0].split("-").map(Number);
  const [lastYr,  lastMo]  = allMonths[allMonths.length - 1].split("-").map(Number);

  function annualMissing(yr) {
    let missing = 0, expected = 0;
    for (let mo = 1; mo <= 12; mo++) {
      if (yr === firstYr && mo < firstMo) continue;
      if (yr === lastYr  && mo > lastMo)  continue;
      const pres = recorded[yr]?.[mo] ?? 0;
      const e = dim(yr, mo);
      expected += e;
      missing  += Math.max(0, e - pres);
    }
    return { missing, expected };
  }

  const yrs   = Object.keys(annual).map(Number).sort((a, b) => a - b);
  const yVals = yrs.map(yr => round1(annual[yr]));

  const CATS = [
    { key: "complete", label: "0 missing days",   color: "#1a6eb5" },
    { key: "minor",    label: "1–18 days missing", color: "#f39c12" },
    { key: "major",    label: ">18 days missing",  color: "#e74c3c" },
    { key: "nodata",   label: "No data",           color: "#cccccc" },
  ];

  function catKey(yr) {
    const { missing, expected } = annualMissing(yr);
    const hasData = recorded[yr] && Object.values(recorded[yr]).some(v => v > 0);
    if (!hasData) return "nodata";
    if (!expected || missing === 0) return "complete";
    return (missing / expected) <= 0.05 ? "minor" : "major";
  }

  const missCounts = yrs.map(yr => annualMissing(yr).missing);
  const hoverTexts = yrs.map((yr, i) => {
    const m = missCounts[i];
    const hasData = recorded[yr] && Object.values(recorded[yr]).some(v => v > 0);
    if (!hasData) return `No data — ${m} days missing`;
    const base = `${yVals[i]} mm`;
    return m > 0 ? `${base}<br>Missing: ${m} day${m !== 1 ? "s" : ""}` : base;
  });
  const barLabels = missCounts.map(m => m > 0 ? `⚠ ${m}` : "");

  // One trace per category so Plotly can render a legend
  const _abg = plotBg();
  const traces = CATS.map(cat => ({
    x: yrs,
    y: yrs.map((yr, i) => catKey(yr) === cat.key ? yVals[i] : null),
    type: "bar",
    name: cat.label,
    marker: { color: cat.color, opacity: 0.85 },
    text: yrs.map((yr, i) => catKey(yr) === cat.key ? barLabels[i] : ""),
    textposition: "outside",
    textfont: { size: 9, color: "#e74c3c" },
    cliponaxis: false,
    customdata: hoverTexts,
    hovertemplate: "<b>%{x}</b><br>%{customdata}<extra></extra>",
  }));

  Plotly.react("annual-chart-area", traces, {
    margin: { t: 10, r: 10, b: 40, l: 60 },
    paper_bgcolor: _abg.paper, plot_bgcolor: _abg.plot,
    yaxis: { title: "Annual Rainfall (mm)", gridcolor: _abg.grid, zeroline: false, autorange: true },
    xaxis: { type: "linear", dtick: 10, gridcolor: _abg.grid },
    barmode: "overlay",
    showlegend: true,
    legend: { orientation: "h", y: 1.08, x: 0, xanchor: "left", font: { size: 11 } },
    font: { family: "Inter, sans-serif", size: 11, color: _abg.text },
    uniformtext: { mode: "hide", minsize: 8 },
  }, { responsive: true, displayModeBar: false });
}

function round1(v) {
  if (v == null) return null;
  return Math.round(v * 10) / 10;
}

// ── Missing Days Tab ──────────────────────────────────────────────────────────
function loadMissingDaysTab() {
  const area = document.getElementById("missing-table-area");
  if (!area) return;

  const data = App.stationData;
  if (!data?.dates?.length) {
    area.innerHTML = '<div class="empty-msg"><div class="big-icon">📋</div>Select a station</div>';
    return;
  }

  const { dates } = data;
  const MO = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // Count days with actual (non-null) values per "YYYY-MM"
  const recorded = {};
  dates.forEach((d, i) => {
    if (data.values[i] !== null) {
      const k = d.slice(0, 7);
      recorded[k] = (recorded[k] ?? 0) + 1;
    }
  });

  // All years in data, newest first
  const years = [...new Set(dates.map(d => +d.slice(0, 4)))].sort((a, b) => b - a);

  // Days in a given month (1-based)
  const dim = (yr, mo) => new Date(yr, mo, 0).getDate();

  // Bound expected range to first/last month that actually appear in the data
  const allMonths  = [...new Set(dates.map(d => d.slice(0, 7)))].sort();
  const [firstYr, firstMo] = allMonths[0].split("-").map(Number);
  const [lastYr,  lastMo]  = allMonths[allMonths.length - 1].split("-").map(Number);

  let grandMissing = 0, grandExpected = 0;

  const rows = years.map(yr => {
    let yrMissing = 0, yrExpected = 0;
    const cells = [];

    for (let mo = 1; mo <= 12; mo++) {
      // Skip months outside the station's actual operating range
      if (yr === firstYr && mo < firstMo) { cells.push(`<td class="miss-none"></td>`); continue; }
      if (yr === lastYr  && mo > lastMo)  { cells.push(`<td class="miss-none"></td>`); continue; }

      const key     = `${yr}-${String(mo).padStart(2, "0")}`;
      const expected = dim(yr, mo);
      const present  = recorded[key] ?? 0;

      if (present === 0) {
        // Entire month absent — all days are missing
        yrMissing  += expected;
        yrExpected += expected;
        cells.push(`<td class="miss-gap">—</td>`);
        continue;
      }

      const missing = expected - present;
      yrMissing  += missing;
      yrExpected += expected;
      cells.push(`<td>${missing}</td>`);
    }

    grandMissing  += yrMissing;
    grandExpected += yrExpected;

    const yrTd = yrExpected === 0
      ? `<td class="miss-total miss-none">—</td>`
      : `<td class="miss-total">${yrMissing}</td>`;

    return `<tr><td class="miss-yr">${yr}</td>${cells.join("")}${yrTd}</tr>`;
  });

  const pct = grandExpected > 0
    ? Math.round((grandExpected - grandMissing) / grandExpected * 100)
    : 0;

  area.innerHTML = `
    <div class="missing-table-wrap">
      <div class="missing-summary">
        <strong>${grandMissing.toLocaleString()}</strong> days missing of
        <strong>${grandExpected.toLocaleString()}</strong> expected &nbsp;·&nbsp;
        <strong>${pct}%</strong> complete
      </div>
      <table class="missing-table">
        <thead>
          <tr>
            <th class="miss-yr">Year</th>
            ${MO.map(m => `<th>${m}</th>`).join("")}
            <th>Missing</th>
          </tr>
        </thead>
        <tbody>${rows.join("")}</tbody>
      </table>
    </div>
  `;
}

// ── AMS Tab ───────────────────────────────────────────────────────────────────
function computeAMS(maxMissing) {
  const data = App.stationData;
  if (!data?.dates?.length) return [];

  const dim = (yr, mo) => new Date(yr, mo, 0).getDate();

  const allMonths = [...new Set(data.dates.map(d => d.slice(0, 7)))].sort();
  const [firstYr, firstMo] = allMonths[0].split("-").map(Number);
  const [lastYr,  lastMo]  = allMonths[allMonths.length - 1].split("-").map(Number);

  const recorded = {};
  const byYear   = {};
  data.dates.forEach((d, i) => {
    const yr = parseInt(d.slice(0, 4));
    const mo = parseInt(d.slice(5, 7));
    const v  = data.values[i];
    if (!byYear[yr]) byYear[yr] = [];
    byYear[yr].push(v);
    if (v !== null) {
      const k = d.slice(0, 7);
      recorded[k] = (recorded[k] ?? 0) + 1;
    }
  });

  const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  const ams = [];

  for (const yr of years) {
    let missing = 0, expected = 0;
    for (let mo = 1; mo <= 12; mo++) {
      if (yr === firstYr && mo < firstMo) continue;
      if (yr === lastYr  && mo > lastMo)  continue;
      const pres = recorded[`${yr}-${String(mo).padStart(2,"0")}`] ?? 0;
      const e = dim(yr, mo);
      expected += e;
      missing  += Math.max(0, e - pres);
    }
    const vals = byYear[yr].filter(v => v !== null);
    if (!vals.length) continue;
    const maxVal = Math.max(...vals);
    ams.push({ yr, maxVal, missing, excluded: missing > maxMissing });
  }

  // Sort by value desc for plotting positions
  const included = ams.filter(r => !r.excluded).sort((a, b) => b.maxVal - a.maxVal);
  const N = included.length;
  included.forEach((r, i) => {
    r.rank = i + 1;
    r.ari  = round1((N + 1) / (i + 1));
    r.aep  = Math.round((i + 1) / (N + 1) * 1000) / 1000;
  });

  return ams; // excluded ones have no rank/ari/aep
}

function loadAMSTab() {
  const tableArea = document.getElementById("ams-table-area");
  const info      = document.getElementById("ams-info");
  if (!App.stationData?.dates?.length) return;

  const thresh   = parseInt(document.getElementById("ams-threshold")?.value ?? 30);
  App.amsThreshold = thresh;

  const ams      = computeAMS(thresh);
  const included = ams.filter(r => !r.excluded);
  const excluded = ams.filter(r => r.excluded);
  if (info) info.textContent = `${included.length} included, ${excluded.length} excluded`;

  const allRows = [...ams].sort((a, b) => a.yr - b.yr);

  if (!allRows.length) {
    tableArea.innerHTML = '<div class="empty-msg"><div class="big-icon">⚠️</div>No data</div>';
    return;
  }

  tableArea.innerHTML = `
    <table class="ams-table">
      <thead><tr>
        <th>Year</th><th>Max Daily (mm)</th>
      </tr></thead>
      <tbody>
        ${allRows.map(r => r.excluded
          ? `<tr class="ams-excl" title="${r.missing} missing days — excluded">
               <td>${r.yr}</td><td>${r.maxVal} ⚠</td>
             </tr>`
          : `<tr><td>${r.yr}</td><td>${r.maxVal}</td></tr>`
        ).join("")}
      </tbody>
    </table>`;
}

// ── IFD Chart Tab ─────────────────────────────────────────────────────────────
// Converts a BOM duration label to minutes
function _durToMins(label) {
  const s = label.trim().toLowerCase();
  const n = parseFloat(s);
  if (s.includes("min"))  return n;
  if (s.includes("hour")) return n * 60;
  if (s.includes("day"))  return n * 1440;
  return null;
}

// Colour palette for AEP curves (warm → cool, matching rarity)
const IFD_CURVE_COLORS = {
  "63.2%": "#27ae60", "50%": "#2ecc71", "20%": "#f1c40f",
  "10%":   "#e67e22", "5%": "#e74c3c", "2%": "#c0392b", "1%": "#8e44ad",
};

function loadIFDChart() {
  const area = document.getElementById("ifd-chart-area");
  if (!App.ifdData) {
    area.innerHTML = '<div class="empty-msg"><div class="big-icon">📐</div>IFD data unavailable</div>';
    return;
  }

  const ifd      = App.ifdData;
  const durations = ifd.durations  ?? [];
  const aepCols   = ifd.aep_cols   ?? [];
  const table     = ifd.table      ?? {};

  if (!durations.length) {
    area.innerHTML = '<div class="empty-msg"><div class="big-icon">📐</div>No duration data in IFD response</div>';
    return;
  }

  const bg      = plotBg();
  const durMins = durations.map(_durToMins);

  // Index-based x (even spacing per data point — avoids log-scale distortion)
  const xIdx = durations.map((_, i) => i);

  // Purge any stale chart from a previous station before rebuilding
  try { Plotly.purge("ifd-chart-area"); } catch {}

  const traces = [];
  aepCols.forEach(aep => {
    const color  = IFD_CURVE_COLORS[aep] ?? "#999";
    const yDepth = durations.map(dur => table[dur]?.[aep] ?? null);
    // Skip traces where every value is null — they trigger the Plotly ghost image
    if (yDepth.every(v => v === null)) return;
    traces.push({
      x: xIdx, y: yDepth,
      mode: "lines+markers", type: "scatter",
      name: `AEP ${aep}`,
      line:   { color, width: 1.8 },
      marker: { color, size: 4 },
      hovertemplate: `<b>AEP ${aep}</b><br>Duration: %{text}<br>Depth: %{y} mm<extra></extra>`,
      text: durations,
    });
  });

  if (!traces.length) {
    area.innerHTML = '<div class="empty-msg"><div class="big-icon">📐</div>No IFD depth values available</div>';
    return;
  }

  // Show only key tick labels with unit-relative numbers
  const showMin = new Set([1, 2, 3, 4, 5, 10, 15, 30]);
  const showHr  = new Set([60, 120, 180, 360, 720]);
  const showDay = new Set([1440, 2880, 4320, 5760, 7200, 8640, 10080]);
  const tickVals = [], tickText = [];
  durMins.forEach((m, i) => {
    if (m === null) return;
    if      (showMin.has(m))  { tickVals.push(i); tickText.push(String(m)); }
    else if (showHr.has(m))   { tickVals.push(i); tickText.push(String(m / 60)); }
    else if (showDay.has(m))  { tickVals.push(i); tickText.push(String(m / 1440)); }
  });

  // Separator indices at group boundaries
  const lastMinI  = durMins.reduce((p, m, i) => (m != null && m <  60)   ? i : p, -1);
  const firstHrI  = durMins.findIndex(m => m != null && m >=  60);
  const lastHrI   = durMins.reduce((p, m, i) => (m != null && m < 1440)  ? i : p, -1);
  const firstDayI = durMins.findIndex(m => m != null && m >= 1440);

  const shapes = [];
  [[lastMinI, firstHrI], [lastHrI, firstDayI]].forEach(([a, b]) => {
    if (a >= 0 && b >= 0) shapes.push({
      type: "line",
      xref: "x", x0: (a + b) / 2, x1: (a + b) / 2,
      yref: "paper", y0: 0, y1: 1,
      line: { color: bg.grid, width: 1.5 },
    });
  });

  // Group label annotations centred below each section
  const mid = idxs => idxs.length ? (idxs[0] + idxs[idxs.length - 1]) / 2 : null;
  const minIdxs = xIdx.filter((_, i) => durMins[i] != null && durMins[i] <   60);
  const hrIdxs  = xIdx.filter((_, i) => durMins[i] != null && durMins[i] >=  60 && durMins[i] < 1440);
  const dayIdxs = xIdx.filter((_, i) => durMins[i] != null && durMins[i] >= 1440);

  const annotations = [
    { x: mid(minIdxs), text: "minutes" },
    { x: mid(hrIdxs),  text: "hours"   },
    { x: mid(dayIdxs), text: "days"    },
  ].filter(a => a.x != null).map(({ x, text }) => ({
    xref: "x", x,
    yref: "paper", y: -0.16,
    text, showarrow: false,
    font: { size: 11, color: bg.text },
    xanchor: "center", yanchor: "top",
  }));

  Plotly.react("ifd-chart-area", traces, {
    margin: { t: 16, r: 10, b: 72, l: 62 },
    paper_bgcolor: bg.paper, plot_bgcolor: bg.plot,
    xaxis: {
      title: "Duration",
      showgrid: false,
      tickvals: tickVals, ticktext: tickText, tickangle: 0,
      ticks: "outside", ticklen: 4,
    },
    yaxis: { title: "Rainfall Depth (mm)", gridcolor: bg.grid, zeroline: false },
    legend: { orientation: "h", y: -0.26, font: { size: 9 }, tracegroupgap: 0 },
    annotations, shapes,
    font: { family: "Inter, sans-serif", size: 11, color: bg.text },
    hovermode: "closest",
  }, { responsive: true, displayModeBar: false });

  // Remove the Plotly ghost/placeholder SVG image element after render
  setTimeout(() => {
    document.querySelectorAll("#ifd-chart-area image").forEach(el => el.remove());
  }, 0);
}

// ── Cumulative Tab ─────────────────────────────────────────────────────────────
function loadCumulativeTab() {
  const area = document.getElementById("cumulative-chart-area");
  const data = App.stationData;
  if (!data?.dates?.length) return;

  // Step 1: compute mean rainfall per DOY (1–366) across the full record
  const doySum   = new Array(367).fill(0);
  const doyCount = new Array(367).fill(0);
  data.dates.forEach((d, i) => {
    const v = data.values[i];
    if (v === null) return;
    const dt  = new Date(d);
    const doy = Math.floor((dt - new Date(dt.getFullYear(), 0, 0)) / 86400000);
    if (doy >= 1 && doy <= 366) { doySum[doy] += v; doyCount[doy]++; }
  });
  const doyMean = doySum.map((s, i) => doyCount[i] > 0 ? s / doyCount[i] : 0);

  // Step 2: accumulate (actual − mean) over the full record
  const dates   = [];
  const cumVals = [];
  let cumSum = 0;

  data.dates.forEach((d, i) => {
    const v = data.values[i];
    if (v === null) return;   // skip missing days, same as mean computation
    const dt  = new Date(d);
    const doy = Math.floor((dt - new Date(dt.getFullYear(), 0, 0)) / 86400000);
    const mean = (doy >= 1 && doy <= 366) ? doyMean[doy] : 0;
    cumSum += v - mean;
    dates.push(d);
    cumVals.push(round1(cumSum));
  });

  const bg = plotBg();
  Plotly.react("cumulative-chart-area", [{
    x: dates, y: cumVals,
    mode: "lines", type: "scatter",
    line: { color: "#1a6eb5", width: 1.5 },
    hovertemplate: "%{x}<br>Anomaly: %{y} mm<extra></extra>",
  }], {
    margin: { t: 10, r: 10, b: 46, l: 60 },
    paper_bgcolor: bg.paper, plot_bgcolor: bg.plot,
    xaxis: { gridcolor: bg.grid, showgrid: false },
    yaxis: {
      title: "Cumulative Rainfall Anomaly (mm)",
      gridcolor: bg.grid, zeroline: true, zerolinecolor: bg.zero,
    },
    shapes: [{
      type: "line", xref: "paper", x0: 0, x1: 1,
      yref: "y", y0: 0, y1: 0,
      line: { color: bg.grid, width: 1, dash: "dot" },
    }],
    showlegend: false,
    font: { family: "Inter, sans-serif", size: 11, color: bg.text },
  }, { responsive: true, displayModeBar: false });
}

// ── Download Modal ─────────────────────────────────────────────────────────────
window.openDownloadModal = function() {
  if (!App.selected) return;
  document.getElementById("dl-modal-title").textContent =
    `⬇ Download — #${App.selected.id} ${App.selected.name}`;
  const ifdChk = document.getElementById("dlm-ifd");
  if (ifdChk) ifdChk.disabled = !App.ifdData;
  updateDlBtn();
  document.getElementById("dl-modal-overlay").classList.add("open");
};

window.updateDlBtn = function() {
  const fmt = document.querySelector('input[name="dl-format"]:checked')?.value ?? "csv";
  const btn = document.getElementById("dl-modal-go-btn");
  if (btn) btn.textContent = fmt === "xlsx" ? "Download XLSX" : "Download CSV";
};

window.closeDownloadModal = function(e) {
  if (e && e.target !== document.getElementById("dl-modal-overlay")) return;
  document.getElementById("dl-modal-overlay").classList.remove("open");
};

function downloadCSVBlob(content, filename) {
  const blob = new Blob(["﻿" + content], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function genMonthlyCSV() {
  const data = App.stationData;
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthly = {};
  data.dates.forEach((d, i) => {
    const yr = parseInt(d.slice(0,4)), mo = parseInt(d.slice(5,7));
    const v  = data.values[i];
    if (!monthly[yr]) monthly[yr] = {};
    monthly[yr][mo] = (monthly[yr][mo] ?? 0) + (v ?? 0);
  });
  let csv = "Year," + MONTHS.join(",") + ",Annual_Total\n";
  Object.keys(monthly).map(Number).sort((a,b)=>a-b).forEach(yr => {
    const vals = MONTHS.map((_,i) => round1(monthly[yr]?.[i+1] ?? ""));
    const tot  = round1(vals.reduce((s,v) => s + (Number(v)||0), 0));
    csv += `${yr},${vals.join(",")},${tot}\n`;
  });
  return csv;
}

function genAnnualCSV() {
  const data = App.stationData;
  const dim  = (yr, mo) => new Date(yr, mo, 0).getDate();
  const recorded = {}, annual = {};
  data.dates.forEach((d, i) => {
    const yr = parseInt(d.slice(0,4)), mo = parseInt(d.slice(5,7));
    const v  = data.values[i];
    annual[yr] = (annual[yr] ?? 0) + (v ?? 0);
    if (v !== null) {
      const k = d.slice(0,7); recorded[k] = (recorded[k] ?? 0) + 1;
    }
  });
  const allMonths = [...new Set(data.dates.map(d=>d.slice(0,7)))].sort();
  const [fy, fm] = allMonths[0].split("-").map(Number);
  const [ly, lm] = allMonths[allMonths.length-1].split("-").map(Number);
  let csv = "Year,Annual_Total_mm,Missing_days\n";
  Object.keys(annual).map(Number).sort((a,b)=>a-b).forEach(yr => {
    let miss=0, exp=0;
    for (let mo=1;mo<=12;mo++) {
      if (yr===fy && mo<fm) continue;
      if (yr===ly && mo>lm) continue;
      const pres = recorded[`${yr}-${String(mo).padStart(2,"0")}`] ?? 0;
      const e = dim(yr, mo); exp += e; miss += Math.max(0, e-pres);
    }
    csv += `${yr},${round1(annual[yr])},${miss}\n`;
  });
  return csv;
}

function genMissingCSV() {
  const data = App.stationData;
  const dim  = (yr, mo) => new Date(yr, mo, 0).getDate();
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const recorded = {};
  data.dates.forEach((d, i) => {
    if (data.values[i] !== null) { const k=d.slice(0,7); recorded[k]=(recorded[k]??0)+1; }
  });
  const allMonths = [...new Set(data.dates.map(d=>d.slice(0,7)))].sort();
  const [fy,fm] = allMonths[0].split("-").map(Number);
  const [ly,lm] = allMonths[allMonths.length-1].split("-").map(Number);
  const years = [...new Set(data.dates.map(d=>+d.slice(0,4)))].sort((a,b)=>a-b);
  let csv = "Year," + MONTHS.join(",") + ",Total_Missing\n";
  years.forEach(yr => {
    let tot = 0;
    const vals = MONTHS.map((_,mi) => {
      const mo = mi+1;
      if (yr===fy && mo<fm) return "";
      if (yr===ly && mo>lm) return "";
      const k = `${yr}-${String(mo).padStart(2,"0")}`;
      const pres = recorded[k] ?? 0;
      const miss = Math.max(0, dim(yr,mo)-pres);
      tot += miss;
      return miss;
    });
    csv += `${yr},${vals.join(",")},${tot}\n`;
  });
  return csv;
}

function genAMSCSV(thresh) {
  const ams = computeAMS(thresh);
  let csv = "Year,Annual_Max_mm,Rank,ARI_years,AEP,Missing_days,Excluded\n";
  ams.sort((a,b)=>a.yr-b.yr).forEach(r => {
    csv += `${r.yr},${r.maxVal},${r.rank??''},${r.ari??''},${r.aep??''},${r.missing},${r.excluded?'yes':'no'}\n`;
  });
  return csv;
}

function genIFDCSV() {
  if (!App.ifdData) return "";
  const ifd       = App.ifdData;
  const durations = ifd.durations ?? [];
  const aepCols   = ifd.aep_cols  ?? [];
  const table     = ifd.table     ?? {};
  if (!durations.length) return "";

  const depthHdrs = aepCols.map(a => `Depth_${a}_mm`);
  const intHdrs   = aepCols.map(a => `Intensity_${a}_mmhr`);
  let csv = `Duration,Duration_min,${depthHdrs.join(",")},${intHdrs.join(",")}\n`;

  durations.forEach(dur => {
    const mins   = _durToMins(dur) ?? "";
    const depths = aepCols.map(a => table[dur]?.[a] ?? "");
    const ints   = aepCols.map(a => {
      const d = table[dur]?.[a];
      const m = typeof mins === "number" ? mins : null;
      return (d != null && m) ? Math.round(d / m * 60 * 10) / 10 : "";
    });
    csv += `${dur},${mins},${depths.join(",")},${ints.join(",")}\n`;
  });
  return csv;
}

window.triggerModalDownloads = async function() {
  const btn = document.getElementById("dl-modal-go-btn");
  btn.disabled = true;
  const origLabel = btn.textContent;
  btn.textContent = "Downloading…";

  const stn    = App.selected;
  const id     = stn?.id ?? "station";
  const name   = (stn?.name ?? "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30);
  const base   = `${id}_${name}`;
  const dist   = document.getElementById("dl-distribute")?.checked ?? true;
  const thresh = parseInt(document.getElementById("dlm-ams-thresh")?.value ?? 30);
  const fmt    = document.querySelector('input[name="dl-format"]:checked')?.value ?? "csv";

  const sel = {
    daily:   !!document.getElementById("dlm-daily")?.checked,
    monthly: !!document.getElementById("dlm-monthly")?.checked,
    annual:  !!document.getElementById("dlm-annual")?.checked,
    missing: !!document.getElementById("dlm-missing")?.checked,
    ams:     !!document.getElementById("dlm-ams")?.checked,
    ifd:     !!(document.getElementById("dlm-ifd")?.checked && App.ifdData),
  };

  try {
    if (fmt === "xlsx") {
      const sheets = Object.entries(sel).filter(([,v]) => v).map(([k]) => k).join(",");
      if (!sheets) { btn.disabled = false; btn.textContent = origLabel; return; }
      const si  = App.stationData?.station;
      const lat = si?.lat ?? stn?.lat;
      const lon = si?.lon ?? stn?.lon;
      let url = `${API}/api/export/${id}/xlsx?distribute=${dist}&sheets=${encodeURIComponent(sheets)}&ams_threshold=${thresh}`;
      if (lat != null && lon != null) url += `&lat=${lat}&lon=${lon}`;
      const res  = await fetch(url);
      const blob = await res.blob();
      const a    = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = `${base}.xlsx`; a.click();
      URL.revokeObjectURL(a.href);
    } else {
      // CSV — separate file per selection
      const delay = () => new Promise(r => setTimeout(r, 300));
      if (sel.daily) {
        const res = await fetch(`${API}/api/export/${id}/csv?distribute=${dist}`);
        const blob = await res.blob();
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
        a.download = `${base}_daily.csv`; a.click(); URL.revokeObjectURL(a.href);
        await delay();
      }
      if (sel.monthly) { downloadCSVBlob(genMonthlyCSV(), `${base}_monthly.csv`); await delay(); }
      if (sel.annual)  { downloadCSVBlob(genAnnualCSV(),  `${base}_annual.csv`);  await delay(); }
      if (sel.missing) { downloadCSVBlob(genMissingCSV(), `${base}_missing.csv`); await delay(); }
      if (sel.ams)     { downloadCSVBlob(genAMSCSV(thresh), `${base}_ams.csv`);   await delay(); }
      if (sel.ifd)     { downloadCSVBlob(genIFDCSV(),    `${base}_ifd.csv`); }
    }
  } finally {
    btn.disabled = false;
    btn.textContent = origLabel;
    document.getElementById("dl-modal-overlay").classList.remove("open");
  }
};

// ── Loading overlay ───────────────────────────────────────────────────────────
function showLoading(areaOrId) {
  const area = typeof areaOrId === "string" ? document.getElementById(areaOrId) : areaOrId;
  if (!area) return;
  const existing = area.querySelector(".loading-overlay");
  if (existing) return;
  const div = document.createElement("div");
  div.className = "loading-overlay";
  div.innerHTML = '<div class="spinner"></div> Loading…';
  area.style.position = "relative";
  area.appendChild(div);
  setTimeout(() => div.remove(), 30000);  // fallback timeout only
}

function hideLoading(areaOrId) {
  const area = typeof areaOrId === "string" ? document.getElementById(areaOrId) : areaOrId;
  if (!area) return;
  area.querySelectorAll(".loading-overlay, .empty-msg").forEach(el => el.remove());
}

// ── Location search ───────────────────────────────────────────────────────────
async function searchLocation(query) {
  const statusEl = document.getElementById("loc-status");
  query = query.trim();
  if (!query) {
    App.locationPin = null;
    applyFilters();
    clearLocationPin();
    statusEl.textContent = "";
    return;
  }
  statusEl.textContent = "⏳ Searching…";
  try {
    const geo = await apiFetch("/api/geocode", { q: query });
    App.locationPin = { lat: geo.lat, lon: geo.lon, label: geo.label };
    statusEl.textContent = `📍 ${geo.label}`;
    applyFilters();
    placeLocationPin(geo.lat, geo.lon, geo.label);
    const r    = App.filters.radius;
    const zoom = Math.max(4, Math.min(12, Math.round(13.5 - Math.log2(Math.max(r, 1)))));
    App.map.setView([geo.lat, geo.lon], zoom, { animate: true });
  } catch {
    statusEl.textContent = `⚠️ "${query}" not found`;
    App.locationPin = null;
    applyFilters();
    clearLocationPin();
  }
}

function placeLocationPin(lat, lon, label) {
  clearLocationPin();
  App.locationMarker = L.marker([lat, lon], {
    icon: L.divIcon({
      html: `<div style="
        width:16px;height:16px;border-radius:50%;
        background:#F57C00;border:3px solid #fff;
        box-shadow:0 2px 8px rgba(0,0,0,.45);
      "></div>`,
      className: "",
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    }),
    zIndexOffset: 1000,
  }).addTo(App.map).bindTooltip(label, { permanent: false });
}

function clearLocationPin() {
  if (App.locationMarker) { App.locationMarker.remove(); App.locationMarker = null; }
}

// ── Location autocomplete ─────────────────────────────────────────────────────
const _locInput = document.getElementById("loc-input");
const _locSug   = document.getElementById("loc-suggestions");
let _suggestions = [];
let _sugIdx      = -1;

const _debouncedSuggest = debounce(async (q) => {
  q = q.trim();
  if (q.length < 2) { _hideSug(); return; }
  try {
    const results = await apiFetch("/api/suggest", { q, limit: 8 });
    _showSug(results);
  } catch { _hideSug(); }
}, 200);

function _showSug(results) {
  _suggestions = results;
  _sugIdx = -1;
  if (!results.length) { _hideSug(); return; }
  _locSug.innerHTML = results.map((r, i) => `
    <div class="loc-suggestion" data-idx="${i}">
      <div class="loc-sug-name">${r.locality}, ${r.state}</div>
      <div class="loc-sug-pc">${r.postcode}</div>
    </div>`).join("");
  _locSug.classList.add("open");
}

function _hideSug() { _locSug.classList.remove("open"); _sugIdx = -1; }

function _pickSug(r) {
  _locInput.value = r.label;
  _hideSug();
  document.getElementById("loc-status").textContent = `📍 ${r.label}`;
  App.locationPin = { lat: r.lat, lon: r.lon, label: r.label };
  applyFilters();
  placeLocationPin(r.lat, r.lon, r.label);
  const zoom = Math.max(4, Math.min(12, Math.round(13.5 - Math.log2(Math.max(App.filters.radius, 1)))));
  App.map.setView([r.lat, r.lon], zoom, { animate: true });
}

_locSug.addEventListener("mousedown", e => {
  const item = e.target.closest(".loc-suggestion");
  if (!item) return;
  e.preventDefault();
  _pickSug(_suggestions[+item.dataset.idx]);
});

_locInput.addEventListener("keydown", e => {
  const items = _locSug.querySelectorAll(".loc-suggestion");
  if (_locSug.classList.contains("open") && items.length) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      _sugIdx = Math.min(_sugIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle("active", i === _sugIdx));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      _sugIdx = Math.max(_sugIdx - 1, -1);
      items.forEach((el, i) => el.classList.toggle("active", i === _sugIdx));
      return;
    }
    if (e.key === "Enter" && _sugIdx >= 0) {
      e.preventDefault();
      _pickSug(_suggestions[_sugIdx]);
      return;
    }
    if (e.key === "Escape") { _hideSug(); return; }
  }
  if (e.key === "Enter") { _hideSug(); searchLocation(_locInput.value); }
});

_locInput.addEventListener("input",  e => _debouncedSuggest(e.target.value));
_locInput.addEventListener("blur",   ()  => setTimeout(_hideSug, 150));

// ── Header station search ─────────────────────────────────────────────────────
const stnSearchInput = document.getElementById("station-search");
const stnDropdown    = document.getElementById("search-results-dropdown");

const debouncedStnSearch = debounce((q) => {
  if (!q || q.length < 2) { stnDropdown.classList.remove("open"); return; }

  const ql = q.toLowerCase();
  const matches = App.allStations.filter(s =>
    s.name.toLowerCase().includes(ql) || s.id.includes(q)
  ).slice(0, 8);

  if (!matches.length) { stnDropdown.classList.remove("open"); return; }

  stnDropdown.innerHTML = matches.map(s => `
    <div class="search-result-item" onclick="pickStation('${s.id}')">
      <span class="sri-name">${s.name}</span>
      <span class="sri-meta">${s.state} · ${s.id}</span>
    </div>`).join("");
  stnDropdown.classList.add("open");
}, 200);

stnSearchInput.addEventListener("input", e => debouncedStnSearch(e.target.value));
stnSearchInput.addEventListener("blur",  () => setTimeout(() => stnDropdown.classList.remove("open"), 200));

window.pickStation = function(id) {
  stnDropdown.classList.remove("open");
  stnSearchInput.value = "";
  selectStation(id);
};

// ── Station ID search ─────────────────────────────────────────────────────────
function doStationIdSearch() {
  const raw    = document.getElementById("stn-id-input").value.trim();
  const status = document.getElementById("stn-id-status");
  if (!raw) { status.textContent = ""; return; }

  // Pad to 6 digits so "66011" matches "066011"
  const padded = raw.padStart(6, "0");
  const hit = App.allStations.find(s => s.id === padded || s.id === raw);

  if (hit) {
    status.textContent = "";
    document.getElementById("stn-id-input").value = "";
    selectStation(hit.id);
  } else {
    status.textContent = `No station found for "${padded}"`;
    status.style.color = "var(--accent)";
  }
}

document.getElementById("stn-id-go-btn").addEventListener("click", doStationIdSearch);
document.getElementById("stn-id-input").addEventListener("keydown", e => {
  if (e.key === "Enter") doStationIdSearch();
});

// ── Event Listeners ───────────────────────────────────────────────────────────

// Right panel tabs
document.querySelectorAll(".rp-tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.rptab;
    document.querySelectorAll(".rp-tab-btn").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".rp-body").forEach(b => b.classList.toggle("active", b.id === `rptab-${tab}`));
  });
});

// Panel compare button
document.getElementById("panel-compare-btn").addEventListener("click", () => {
  addToComparison();
  // Switch right panel to compare tab
  document.querySelectorAll(".rp-tab-btn").forEach(b => b.classList.toggle("active", b.dataset.rptab === "compare"));
  document.querySelectorAll(".rp-body").forEach(b => b.classList.toggle("active", b.id === "rptab-compare"));
});

// Location Go button
document.getElementById("loc-btn").addEventListener("click", () => {
  _hideSug(); searchLocation(_locInput.value);
});

// Radius slider
const radiusSlider = document.getElementById("radius-slider");
radiusSlider.addEventListener("input", e => {
  App.filters.radius = +e.target.value;
  document.getElementById("radius-val").textContent = e.target.value;
});
radiusSlider.addEventListener("change", () => {
  if (App.locationPin) applyFilters();
});

// Favs toggle
document.getElementById("favs-toggle-btn").addEventListener("click", () => {
  App.showFavsOnly = !App.showFavsOnly;
  document.getElementById("favs-toggle-btn").classList.toggle("active", App.showFavsOnly);
  applyFilters();
});

// Panel close
document.getElementById("panel-close-btn").addEventListener("click", closePanel);

// Panel fav button
document.getElementById("panel-fav-btn").addEventListener("click", () => {
  if (App.selected) toggleFav(App.selected.id);
});

// Chart type toggle (daily)
document.getElementById("ctype-bar").addEventListener("click", () => {
  App.chartType = "bar";
  document.getElementById("ctype-bar").classList.add("active");
  document.getElementById("ctype-line").classList.remove("active");
  if (App.stationData && App.activeTab === "daily") loadDailyChart();
});
document.getElementById("ctype-line").addEventListener("click", () => {
  App.chartType = "line";
  document.getElementById("ctype-line").classList.add("active");
  document.getElementById("ctype-bar").classList.remove("active");
  if (App.stationData && App.activeTab === "daily") loadDailyChart();
});

// Year range selects
document.getElementById("yr-start").addEventListener("change", e => {
  App.yearRange[0] = +e.target.value;
  App.singleYear = ""; document.getElementById("yr-single").value = "";
  App.dailyXRange = null;   // new time window → reset range slider
  if (App.stationData && App.activeTab === "daily") loadDailyChart();
});
document.getElementById("yr-end").addEventListener("change", e => {
  App.yearRange[1] = +e.target.value;
  App.singleYear = ""; document.getElementById("yr-single").value = "";
  App.dailyXRange = null;
  if (App.stationData && App.activeTab === "daily") loadDailyChart();
});
document.getElementById("yr-single").addEventListener("change", e => {
  App.singleYear = e.target.value;
  App.dailyXRange = null;
  if (App.stationData && App.activeTab === "daily") loadDailyChart();
});

// Monthly controls
document.getElementById("monthly-yr-select").addEventListener("change", e => {
  App.monthlyYear = +e.target.value;
  if (App.stationData && App.activeTab === "monthly") loadMonthlyChart();
});
document.getElementById("mview-year").addEventListener("click", () => {
  App.monthlyView = "year";
  document.getElementById("mview-year").classList.add("active");
  document.getElementById("mview-allyears").classList.remove("active");
  document.getElementById("monthly-yr-select").style.display = "";
  document.getElementById("monthly-month-ctrl").style.display = "none";
  if (App.stationData && App.activeTab === "monthly") loadMonthlyChart();
});
document.getElementById("mview-allyears").addEventListener("click", () => {
  App.monthlyView = "allyears";
  document.getElementById("mview-allyears").classList.add("active");
  document.getElementById("mview-year").classList.remove("active");
  document.getElementById("monthly-yr-select").style.display = "none";
  document.getElementById("monthly-month-ctrl").style.display = "";
  if (App.stationData && App.activeTab === "monthly") loadMonthlyChart();
});
document.getElementById("monthly-month-select").addEventListener("change", e => {
  App.monthlyMonth = +e.target.value;
  if (App.stationData && App.activeTab === "monthly") loadMonthlyChart();
});

// Download tab now uses the modal — dl-csv-btn and dl-xlsx-btn removed from HTML.

function triggerDownload(url) {
  const statusEl = document.getElementById("dl-status");
  statusEl.textContent = "⏳ Preparing download…";
  const a = document.createElement("a");
  a.href = url;
  a.click();
  setTimeout(() => { statusEl.textContent = "✅ Download started"; }, 500);
  setTimeout(() => { statusEl.textContent = ""; }, 4000);
}

// ── Batch Download ────────────────────────────────────────────────────────────
function _batchSourceIds() {
  const src = document.querySelector('input[name="batch-src"]:checked')?.value ?? "favs";
  if (src === "favs") {
    return [...App.favourites];
  } else if (src === "filtered") {
    return App.filtered.map(s => s.id);
  } else {
    // custom textarea
    return document.getElementById("batch-custom-ids").value
      .split(/[\n,;]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }
}

// Keep the count badges up-to-date
function updateBatchCounts() {
  const fc = document.getElementById("batch-fav-count");
  const lc = document.getElementById("batch-filtered-count");
  if (fc) fc.textContent = `(${App.favourites.size})`;
  if (lc) lc.textContent = `(${App.filtered.length})`;
}

// Show/hide custom textarea
document.addEventListener("change", e => {
  if (e.target.name === "batch-src") {
    const ta = document.getElementById("batch-custom-ids");
    if (ta) ta.style.display = e.target.value === "custom" ? "block" : "none";
    updateBatchCounts();
  }
});

window.startBatchDownload = async function() {
  const ids = _batchSourceIds();
  if (!ids.length) {
    alert("No stations selected. Add some favourites first, or choose a different source.");
    return;
  }

  const fmt      = document.querySelector('input[name="batch-fmt"]:checked')?.value ?? "zip";
  const distrib  = document.getElementById("batch-distribute").checked;
  const endpoint = fmt === "xlsx" ? "/api/export/batch/xlsx" : "/api/export/batch/zip";
  const maxIds   = fmt === "xlsx" ? 20 : 50;
  const trimmed  = ids.slice(0, maxIds);

  const progressEl = document.getElementById("batch-progress");
  const labelEl    = document.getElementById("batch-progress-label");
  const barEl      = document.getElementById("batch-progress-bar");
  const errListEl  = document.getElementById("batch-error-list");
  const btn        = document.getElementById("batch-start-btn");

  progressEl.style.display = "block";
  errListEl.innerHTML = "";
  barEl.style.width   = "10%";
  labelEl.textContent = `⏳ Requesting ${trimmed.length} station${trimmed.length > 1 ? "s" : ""}…`;
  btn.disabled = true;

  try {
    const resp = await fetch(`${API}${endpoint}?distribute=${distrib}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ station_ids: trimmed }),
    });

    barEl.style.width = "80%";

    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      try { const j = await resp.json(); msg = j.detail ?? msg; } catch {}
      throw new Error(msg);
    }

    // Parse errors from response headers if server embeds them (ZIP case)
    const blob = await resp.blob();
    barEl.style.width = "100%";

    const filename = resp.headers.get("Content-Disposition")
      ?.match(/filename="([^"]+)"/)?.[1] ?? `rainfall_batch.${fmt === "xlsx" ? "xlsx" : "zip"}`;

    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);

    labelEl.textContent = `✅ Downloaded ${trimmed.length} station${trimmed.length > 1 ? "s" : ""} — check the file for any errors.`;
    if (ids.length > maxIds) {
      errListEl.innerHTML = `<div class="batch-error-item">⚠ Only the first ${maxIds} stations were included (${fmt === "xlsx" ? "XLSX" : "ZIP"} limit). ${ids.length - maxIds} skipped.</div>`;
    }
  } catch (err) {
    barEl.style.width   = "100%";
    barEl.style.background = "var(--danger, #e74c3c)";
    labelEl.textContent = `❌ Batch download failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => { barEl.style.background = ""; }, 3000);
  }
};

// ── Panel Resize / Collapse ───────────────────────────────────────────────────
function initPanelResize() {
  const root  = document.documentElement;
  const MIN_W = 180;
  const MAX_W = 600;
  const KEY_SB = "rf-sidebar-w";
  const KEY_RP = "rf-rpanel-w";

  // Restore saved widths (0 = collapsed)
  const rawSb = localStorage.getItem(KEY_SB);
  const rawRp = localStorage.getItem(KEY_RP);
  if (rawSb !== null) root.style.setProperty("--sidebar-w", +rawSb + "px");
  if (rawRp !== null) root.style.setProperty("--right-w",   +rawRp + "px");

  let prevSidebarW = rawSb !== null && +rawSb > 0 ? +rawSb : 320;
  let prevRpanelW  = rawRp !== null && +rawRp > 0 ? +rawRp : 310;
  let sidebarCollapsed = rawSb !== null && +rawSb === 0;
  let rpanelCollapsed  = rawRp !== null && +rawRp === 0;

  function currentW(varName) {
    return parseInt(getComputedStyle(root).getPropertyValue(varName)) || 0;
  }

  function setWidth(which, px) {
    const clamped = Math.max(0, Math.min(MAX_W, Math.round(px)));
    if (which === "sidebar") {
      root.style.setProperty("--sidebar-w", clamped + "px");
      localStorage.setItem(KEY_SB, clamped);
    } else {
      root.style.setProperty("--right-w", clamped + "px");
      localStorage.setItem(KEY_RP, clamped);
    }
    if (App.map) App.map.invalidateSize();
  }

  function updateBtns() {
    const sbBtn = document.getElementById("sidebar-collapse-btn");
    const rpBtn = document.getElementById("rpanel-collapse-btn");
    if (sbBtn) sbBtn.textContent = sidebarCollapsed ? "»" : "«";
    if (rpBtn) rpBtn.textContent = rpanelCollapsed  ? "«" : "»";
  }
  updateBtns();

  // Sidebar collapse toggle
  document.getElementById("sidebar-collapse-btn").addEventListener("click", e => {
    e.stopPropagation();
    if (sidebarCollapsed) {
      sidebarCollapsed = false;
      setWidth("sidebar", prevSidebarW);
    } else {
      prevSidebarW = currentW("--sidebar-w") || 320;
      sidebarCollapsed = true;
      setWidth("sidebar", 0);
    }
    updateBtns();
  });

  // Right-panel collapse toggle
  document.getElementById("rpanel-collapse-btn").addEventListener("click", e => {
    e.stopPropagation();
    if (rpanelCollapsed) {
      rpanelCollapsed = false;
      setWidth("rpanel", prevRpanelW);
    } else {
      prevRpanelW = currentW("--right-w") || 310;
      rpanelCollapsed = true;
      setWidth("rpanel", 0);
    }
    updateBtns();
  });

  // Drag-to-resize
  function attachDrag(sizerId, which) {
    const sizer = document.getElementById(sizerId);
    if (!sizer) return;

    sizer.addEventListener("mousedown", e => {
      if (e.target.classList.contains("sizer-btn")) return; // collapse btn handles its own click
      e.preventDefault();
      const startX = e.clientX;
      const startW = which === "sidebar" ? currentW("--sidebar-w") : currentW("--right-w");

      sizer.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      function onMove(ev) {
        // sidebar: drag right → wider; right-panel: drag left → wider
        const dx  = which === "sidebar" ? ev.clientX - startX : startX - ev.clientX;
        const newW = Math.max(MIN_W, startW + dx);
        setWidth(which, newW);
        if (which === "sidebar") { prevSidebarW = newW; sidebarCollapsed = false; }
        else                     { prevRpanelW  = newW; rpanelCollapsed  = false; }
        updateBtns();
      }

      function onUp() {
        sizer.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup",   onUp);
    });
  }

  attachDrag("sidebar-sizer", "sidebar");
  attachDrag("rpanel-sizer",  "rpanel");

  // Detail panel vertical resize
  const KEY_PH = "rf-panel-h";
  const MIN_H  = 150;
  const MAX_H  = 750;
  const rawPh  = localStorage.getItem(KEY_PH);
  if (rawPh !== null) root.style.setProperty("--panel-h", +rawPh + "px");

  const detailSizer = document.getElementById("detail-panel-sizer");
  if (detailSizer) {
    detailSizer.addEventListener("mousedown", e => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = parseInt(getComputedStyle(root).getPropertyValue("--panel-h")) || 430;
      detailSizer.classList.add("dragging");
      document.body.style.cursor    = "row-resize";
      document.body.style.userSelect = "none";

      function onMove(ev) {
        const newH = Math.max(MIN_H, Math.min(MAX_H, startH + (startY - ev.clientY)));
        root.style.setProperty("--panel-h", newH + "px");
        localStorage.setItem(KEY_PH, newH);
        if (App.map) App.map.invalidateSize();
        ["daily-chart-area", "monthly-chart-area", "annual-chart-area", "compare-chart-area",
         "ams-chart-area", "ifd-chart-area", "cumulative-chart-area"].forEach(id => {
          const el = document.getElementById(id);
          if (el?._fullLayout) Plotly.Plots.resize(el);
        });
      }

      function onUp() {
        detailSizer.classList.remove("dragging");
        document.body.style.cursor    = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup",   onUp);
    });
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
initMap();
renderRefLines();
loadStations();
initPanelResize();
