"""
BOM Rainfall Downloader  –  FastAPI backend
Fetches daily rainfall data on-demand from BOM CDO.
Run:  uvicorn api:app --reload --port 8000
"""
from __future__ import annotations
import io
import json
import math
import re
import time
import zipfile
from functools import lru_cache
from pathlib import Path
import concurrent.futures
from typing import List, Optional

import numpy as np
import pandas as pd
import requests
from cachetools import TTLCache, cached
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE_DIR       = Path(__file__).parent
STATIC_DIR     = BASE_DIR / "static"
DATA_DIR       = BASE_DIR / "data"
SHAPEFILE_PATH = DATA_DIR / "AUS_BoM_RF_Stations.shp"

# ── BOM constants ──────────────────────────────────────────────────────────────
OBS_CODE = 136
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-AU,en;q=0.9",
    "Referer": "http://www.bom.gov.au/climate/data/",
}

_POSTCODE_URL = (
    "https://raw.githubusercontent.com/matthewproctor/"
    "australianpostcodes/master/australian_postcodes.csv"
)

# ── FastAPI App ────────────────────────────────────────────────────────────────
app = FastAPI(
    title="BOM Rainfall Downloader API",
    description="On-demand daily rainfall data from Bureau of Meteorology.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

DATA_DIR.mkdir(exist_ok=True)
STATIC_DIR.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def root():
    p = STATIC_DIR / "index.html"
    if p.exists():
        return HTMLResponse(p.read_text(encoding="utf-8"))
    return HTMLResponse(
        "<h1>BOM Rainfall Downloader</h1>"
        "<p>Docs: <a href='/docs'>/docs</a></p>"
    )


# ── Haversine ─────────────────────────────────────────────────────────────────
def _haversine(lat1: float, lon1: float, lat2, lon2) -> np.ndarray:
    R = 6371.0
    lat2 = np.asarray(lat2, dtype=float)
    lon2 = np.asarray(lon2, dtype=float)
    dlat = np.radians(lat2 - lat1)
    dlon = np.radians(lon2 - lon1)
    a = (
        np.sin(dlat / 2) ** 2
        + np.cos(np.radians(lat1)) * np.cos(np.radians(lat2)) * np.sin(dlon / 2) ** 2
    )
    return 2 * R * np.arcsin(np.sqrt(a))


# ── Station Index (from shapefile) ────────────────────────────────────────────
def _read_shapefile_pure(shp_path: Path) -> pd.DataFrame:
    """Pure-Python shapefile reader (no geopandas/fiona required).
    Reads DBF attributes and SHP point coordinates side-by-side.
    """
    import struct as _struct

    dbf_path = shp_path.with_suffix(".dbf")

    # ── Read DBF ──────────────────────────────────────────────────────────────
    with open(dbf_path, "rb") as f:
        f.read(4)                                       # version + date
        n_records   = _struct.unpack("<I", f.read(4))[0]
        header_size = _struct.unpack("<H", f.read(2))[0]
        record_size = _struct.unpack("<H", f.read(2))[0]
        f.read(20)                                      # reserved

        field_defs = []
        while f.tell() < header_size - 1:
            data = f.read(32)
            if not data or data[0] == 0x0D:
                break
            name  = data[:11].replace(b"\x00", b"").decode("ascii", "ignore")
            ftype = chr(data[11])
            flen  = data[16]
            field_defs.append((name, ftype, flen))

        f.seek(header_size)
        records = []
        for _ in range(n_records):
            del_flag = f.read(1)
            if not del_flag:
                break
            row = {}
            for name, ftype, flen in field_defs:
                raw = f.read(flen).decode("ascii", "ignore").strip()
                if ftype == "N":
                    try:
                        row[name] = float(raw) if "." in raw else int(raw)
                    except ValueError:
                        row[name] = None
                else:
                    row[name] = raw
            records.append(row)

    df = pd.DataFrame(records)

    # ── Read SHP point coordinates ────────────────────────────────────────────
    with open(shp_path, "rb") as f:
        f.read(100)  # file header
        lats, lons = [], []
        while True:
            rec_header = f.read(8)
            if len(rec_header) < 8:
                break
            content_len = _struct.unpack(">I", rec_header[4:8])[0] * 2  # bytes
            content = f.read(content_len)
            if len(content) < 4:
                break
            shape_type = _struct.unpack("<i", content[:4])[0]
            if shape_type == 1 and len(content) >= 20:  # Point
                x = _struct.unpack("<d", content[4:12])[0]
                y = _struct.unpack("<d", content[12:20])[0]
                lons.append(x)
                lats.append(y)
            else:
                lons.append(None)
                lats.append(None)

    # Align lengths
    n = min(len(df), len(lats))
    df = df.iloc[:n].copy()
    df["_LAT"] = lats[:n]
    df["_LON"] = lons[:n]

    return df


def _infer_state(lat: float, lon: float) -> str:
    """Rough bounding-box state inference from lat/lon (Australia)."""
    if lon < 129:
        if lat > -22:
            return "NT"    # Northern coast WA/NT
        if lon < 126:
            return "WA"
        return "NT"
    if lon < 138:
        if lat > -26:
            return "NT"
        if lat > -31:
            return "SA"
        return "SA" if lon < 141 else "VIC"
    if lon < 141:
        if lat < -31.5:
            return "VIC"
        if lat < -26:
            return "SA"
        return "QLD"
    if lon < 153.5:
        if lat < -38:
            return "TAS"
        if lat < -34:
            return "VIC"
        if lat < -28.5:
            return "NSW"
        return "QLD"
    return "NSW"


@lru_cache(maxsize=1)
def _station_index() -> list[dict]:
    """Read BOM rainfall station shapefile, return list of dicts."""
    gdf = None
    try:
        import geopandas as gpd
        gdf = gpd.read_file(str(SHAPEFILE_PATH))
    except Exception:
        pass

    if gdf is None:
        try:
            import fiona
            records = []
            with fiona.open(str(SHAPEFILE_PATH)) as src:
                for feat in src:
                    props = dict(feat["properties"])
                    geom  = feat["geometry"]
                    if geom and geom["type"] == "Point":
                        props["_LON"] = geom["coordinates"][0]
                        props["_LAT"] = geom["coordinates"][1]
                    records.append(props)
            gdf = pd.DataFrame(records)
        except Exception:
            pass

    if gdf is None:
        try:
            gdf = _read_shapefile_pure(SHAPEFILE_PATH)
        except Exception as e:
            raise RuntimeError(f"Cannot read shapefile with any method: {e}")

    # Map columns — priority list covers the known shapefile schema:
    # SITE_ID, SITE_NAME, LAT, LONG, START_Y, END_Y, PC_COMPLET
    # (no STATE column in this file — will be left absent)
    cols_upper = {c.upper(): c for c in gdf.columns}
    col_map = {}
    for key, candidates in [
        ("id",         ["SITE_ID", "STATIONID", "STN_ID", "ID"]),
        ("name",       ["SITE_NAME", "STATION_NAME", "NAME", "STATION"]),
        ("lat",        ["LAT", "_LAT", "LATITUDE"]),
        ("lon",        ["LONG", "LON", "_LON", "LONGITUDE"]),
        ("start_year", ["START_Y", "START_YEAR", "STARTYEAR"]),
        ("end_year",   ["END_Y", "END_YEAR", "ENDYEAR"]),
        ("pct",        ["PC_COMPLET", "PCT_COMPLETE", "COMPLETENESS"]),
        ("state",      ["STATE", "ST"]),
    ]:
        for c in candidates:
            if c in cols_upper:
                col_map[key] = cols_upper[c]
                break

    # Handle geometry lat/lon for geopandas GeoDataFrame (when LAT/LONG columns absent)
    if hasattr(gdf, "geometry") and hasattr(gdf.geometry, "x"):
        if "lat" not in col_map:
            gdf = gdf.copy()
            gdf["_lat"] = gdf.geometry.y
            gdf["_lon"] = gdf.geometry.x
            col_map["lat"] = "_lat"
            col_map["lon"] = "_lon"

    results = []
    for _, row in gdf.iterrows():
        try:
            sid = str(int(float(row[col_map["id"]]))).zfill(6)
        except Exception:
            continue
        try:
            lat = float(row[col_map.get("lat", "LAT")])
            lon = float(row[col_map.get("lon", "LON")])
        except Exception:
            lat = lon = None

        def _int_safe(col):
            try:
                return int(float(row[col]))
            except Exception:
                return None

        def _float_safe(col):
            try:
                v = float(row[col])
                return None if math.isnan(v) else round(v, 1)
            except Exception:
                return None

        pct = _float_safe(col_map["pct"]) if "pct" in col_map else None

        # Infer state from lat/lon when STATE column absent
        state = "?"
        if "state" in col_map:
            state = str(row[col_map["state"]]).strip().upper()
        elif lat is not None and lon is not None:
            state = _infer_state(lat, lon)

        results.append({
            "id":           sid,
            "name":         str(row[col_map["name"]]).strip() if "name" in col_map else sid,
            "lat":          lat,
            "lon":          lon,
            "state":        state,
            "start_year":   _int_safe(col_map["start_year"]) if "start_year" in col_map else None,
            "end_year":     _int_safe(col_map["end_year"])   if "end_year"   in col_map else None,
            "pct_complete": pct,
        })

    return results


# ── GET /api/stations ─────────────────────────────────────────────────────────
@app.get("/api/stations", summary="List all BOM rainfall stations")
def list_stations():
    return _station_index()


# ── GET /api/stations/nearby ──────────────────────────────────────────────────
@app.get("/api/stations/nearby", summary="Stations within radius")
def nearby_stations(
    lat:       float,
    lon:       float,
    radius_km: float = Query(100.0),
):
    stations = _station_index()
    lats = np.array([s["lat"] for s in stations], dtype=float)
    lons = np.array([s["lon"] for s in stations], dtype=float)
    dists = _haversine(lat, lon, lats, lons)
    result = []
    for i, stn in enumerate(stations):
        if dists[i] <= radius_km:
            d = {"distance_km": round(float(dists[i]), 1)}
            d.update(stn)
            result.append(d)
    result.sort(key=lambda x: x["distance_km"])
    return result


# ── BOM scrape helpers ─────────────────────────────────────────────────────────
class _NoDataError(Exception):
    """Raised when BOM permanently has no rainfall data for a station (don't retry)."""


def _make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    s.get("https://www.bom.gov.au/climate/data/", timeout=15)
    return s


def _strip_tags(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s).replace("&deg;", "°").replace("&nbsp;", " ").strip()


def _parse_station_info(html: str) -> dict:
    plain = re.sub(r"<[^>]+>", " ", html)
    plain = plain.replace("&deg;", "°").replace("&nbsp;", " ").replace("&amp;", "&")
    plain = re.sub(r"\s+", " ", plain)

    anchor = re.search(r"Number:\s*\d+", plain, re.IGNORECASE)
    if not anchor:
        block = plain
    else:
        start = max(0, anchor.start() - 300)
        end   = min(len(plain), anchor.end() + 600)
        block = plain[start:end]

    STOP = r"(?=\s*(?:Number|Opened|Now|Lat|Lon|Elevation|Station|Details)\s*:)"

    def field(label, default="N/A"):
        m = re.search(rf"{label}\s*:\s*(.*?){STOP}", block, re.IGNORECASE)
        return m.group(1).strip() if m else default

    name   = field("Station")
    number = field("Number")
    opened = field("Opened")
    now    = field("Now")
    lat    = field("Lat")
    lon    = field("Lon")
    elev_m = re.search(r"Elevation\s*:\s*([\d.]+)\s*m", block, re.IGNORECASE)
    elev   = elev_m.group(1) if elev_m else "N/A"
    is_open = ("closed" not in now.lower()) if now != "N/A" else None

    def _parse_coord(s, neg_dir):
        if not s or s == "N/A":
            return None
        num = re.search(r"[\d.]+", s)
        if not num:
            return None
        val = float(num.group())
        if neg_dir.upper() in s.upper():
            val = -val
        return val

    lat_f = _parse_coord(lat, "S")
    lon_f = _parse_coord(lon, "W")

    return {
        "name":    name,
        "number":  number,
        "lat":     lat_f,
        "lon":     lon_f,
        "lat_str": lat,
        "lon_str": lon,
        "opened":  opened,
        "now":     now,
        "is_open": is_open,
        "elevation": elev,
    }


# Per-station TTL cache (1 hour)
_station_data_cache: TTLCache = TTLCache(maxsize=512, ttl=3600)


def _fetch_rainfall_cached(station_id: str) -> dict:
    """Scrape BOM and return parsed station data. Cached 1 hour per station."""
    if station_id in _station_data_cache:
        return _station_data_cache[station_id]

    station_id = station_id.strip().zfill(6)
    last_exc = None

    for attempt in range(3):
        if attempt > 0:
            time.sleep(1.5)
        try:
            session = _make_session()

            # Step 1: get page to find p_c and start_year
            page_url = (
                f"https://www.bom.gov.au/jsp/ncc/cdio/weatherData/av"
                f"?p_nccObsCode={OBS_CODE}&p_display_type=dailyDataFile"
                f"&p_startYear=&p_c=&p_stn_num={station_id}"
            )
            resp = session.get(page_url, timeout=30)
            resp.raise_for_status()
            page_html = resp.text

            # BOM returns an "No data available" page for stations without rainfall records
            if "No data available" in page_html or "Error code: 1001" in page_html:
                raise _NoDataError(
                    f"Station {station_id} has no daily rainfall data in BOM Climate Data Online. "
                    "It may measure a different parameter (temperature, evaporation, etc.)."
                )

            match = re.search(
                r"p_display_type=dailyZippedDataFile&amp;p_stn_num=\d+&amp;p_c=(-?\d+)"
                r"&amp;p_nccObsCode=\d+&amp;p_startYear=(\d+)",
                page_html,
            )
            if not match:
                raise _NoDataError(
                    f"Station {station_id} does not have a daily rainfall download available on BOM."
                )

            p_c, start_year = match.group(1), match.group(2)
            download_url = (
                f"https://www.bom.gov.au/jsp/ncc/cdio/weatherData/av"
                f"?p_display_type=dailyZippedDataFile&p_stn_num={station_id}"
                f"&p_c={p_c}&p_nccObsCode={OBS_CODE}&p_startYear={start_year}"
            )

            # Step 2: download zip
            resp2 = session.get(download_url, timeout=60)
            resp2.raise_for_status()

            content_type = resp2.headers.get("Content-Type", "")
            if "html" in content_type:
                raise RuntimeError("BOM returned HTML instead of a zip — session may have expired.")

            # Step 3: parse CSV from zip
            with zipfile.ZipFile(io.BytesIO(resp2.content)) as z:
                csv_files = [f for f in z.namelist() if f.lower().endswith(".csv")]
                if not csv_files:
                    raise RuntimeError("No CSV found in downloaded zip.")
                with z.open(csv_files[0]) as f:
                    df = pd.read_csv(f)

            station_info = _parse_station_info(page_html)

            result = {"df": df, "info": station_info}
            _station_data_cache[station_id] = result
            return result

        except _NoDataError:
            raise  # permanent — don't retry, bubble up immediately
        except (zipfile.BadZipFile, RuntimeError) as e:
            last_exc = e
            continue

    raise RuntimeError(
        f"BOM did not return valid data after 3 attempts. "
        f"Last error: {last_exc}"
    )


# ── GET /api/stations/{station_id}/data ───────────────────────────────────────
@app.get("/api/stations/{station_id}/data", summary="Fetch daily rainfall from BOM")
def station_data(
    station_id: str,
    distribute: bool = Query(True, description="Distribute accumulated readings"),
):
    station_id = station_id.strip().zfill(6)
    try:
        cached = _fetch_rainfall_cached(station_id)
    except _NoDataError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        raise HTTPException(400, str(e))

    import traceback as _tb
    try:
        df   = cached["df"].copy()
        info = cached["info"]

        df.columns = df.columns.str.strip()
        rain_col   = next((c for c in df.columns if "rainfall" in c.lower()), None)
        period_col = next((c for c in df.columns if "period"   in c.lower()), None)

        if not rain_col:
            raise HTTPException(400, f"Could not identify rainfall column. Columns: {list(df.columns)}")

        # BOM CSVs may name year/month/day columns differently — detect them
        year_col  = next((c for c in df.columns if c.strip().lower() == "year"),  None)
        month_col = next((c for c in df.columns if c.strip().lower() == "month"), None)
        day_col   = next((c for c in df.columns if c.strip().lower() == "day"),   None)

        if year_col and month_col and day_col:
            df["_date"] = pd.to_datetime(
                {"year": pd.to_numeric(df[year_col],  errors="coerce"),
                 "month": pd.to_numeric(df[month_col], errors="coerce"),
                 "day":   pd.to_numeric(df[day_col],   errors="coerce")},
                errors="coerce",
            )
        else:
            raise HTTPException(400, f"Could not find Year/Month/Day columns. Columns: {list(df.columns)}")

        df[rain_col] = pd.to_numeric(df[rain_col], errors="coerce")

        if period_col and distribute:
            df[period_col] = pd.to_numeric(df[period_col], errors="coerce").fillna(1).clip(lower=1)
            df = df.set_index("_date").sort_index()
            rain_series = df[rain_col].copy()
            for date, row in df[df[period_col] > 1].iterrows():
                p = int(row[period_col])
                r = row[rain_col]
                if pd.isna(r):
                    continue
                daily = round(r / p, 1)
                for i in range(p):
                    d = date - pd.Timedelta(days=i)
                    if d in rain_series.index:
                        rain_series[d] = daily
            df[rain_col] = rain_series
            df = df.reset_index()  # index was "_date", reset_index restores it as a column named "_date"

        # Build output arrays
        valid  = df.dropna(subset=["_date"])
        dates  = valid["_date"].dt.strftime("%Y-%m-%d").tolist()
        values = [None if pd.isna(v) else round(float(v), 1) for v in valid[rain_col]]

        # Quality column (if present) — replace NaN/None with None for JSON safety
        quality_col = next((c for c in df.columns if "quality" in c.lower()), None)
        if quality_col:
            quality = [None if (v is None or (isinstance(v, float) and pd.isna(v))) else v
                       for v in valid[quality_col].tolist()]
        else:
            quality = [None] * len(dates)

        return {
            "dates":   dates,
            "values":  values,
            "quality": quality,
            "station": {
                "name":      info.get("name"),
                "number":    info.get("number"),
                "lat":       info.get("lat"),
                "lon":       info.get("lon"),
                "opened":    info.get("opened"),
                "now":       info.get("now"),
                "is_open":   info.get("is_open"),
                "elevation": info.get("elevation"),
            },
        }
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(500, f"Processing error:\n{_tb.format_exc()}")


# ── IFD cache (30 days) ────────────────────────────────────────────────────────
_ifd_cache: TTLCache = TTLCache(maxsize=256, ttl=86400 * 30)

_IFD_PREFERRED = [
    "50%", "20%", "10%", "5%", "2%", "1%",
    "1 in 200", "1 in 500", "1 in 1000", "1 in 2000",
]


def _within_ifd_coverage(lat: float, lon: float) -> bool:
    """Return True if coordinates fall within BOM Revised IFD 2016 coverage.
    Coverage is Australian mainland + Tasmania; excludes PNG, Vanuatu, Pacific islands.
    """
    return -44.5 <= lat <= -9.0 and 112.0 <= lon <= 154.0


@app.get("/api/ifd", summary="BOM Revised IFD 2016 design rainfall (24-hour)")
def get_ifd(lat: float, lon: float):
    if not _within_ifd_coverage(lat, lon):
        raise HTTPException(
            404,
            f"Location ({lat:.3f}, {lon:.3f}) is outside BOM Revised IFD 2016 coverage area "
            "(Australian mainland and Tasmania only)."
        )

    key = (round(lat, 3), round(lon, 3))
    if key in _ifd_cache:
        cached = _ifd_cache[key]
        if "_error" in cached:
            raise HTTPException(502, f"IFD fetch error: {cached['_error']}")
        return cached

    result = _fetch_ifd(lat, lon)
    _ifd_cache[key] = result
    if "_error" in result:
        raise HTTPException(502, f"IFD fetch error: {result['_error']}")
    return result


def _dur_to_minutes(label: str) -> float | None:
    """Convert a BOM duration label like '30 min' or '1.5 hour' to minutes."""
    s = label.strip().lower()
    try:
        if "min" in s:
            return float(re.search(r"[\d.]+", s).group())
        if "hour" in s or " h" in s or s.endswith("h"):
            return float(re.search(r"[\d.]+", s).group()) * 60
        if "day" in s:
            return float(re.search(r"[\d.]+", s).group()) * 1440
    except Exception:
        pass
    return None


def _fetch_ifd(lat: float, lon: float) -> dict:
    base_url = "https://www.bom.gov.au/water/designRainfalls/revised-ifd/"
    post_url = base_url + "?multipoint"
    try:
        sess = requests.Session()
        sess.headers.update(HEADERS)
        sess.get(base_url, timeout=15)

        lat3, lon3 = round(lat, 3), round(lon, 3)
        body = (
            f"sdmin=true&sdhr=true&sdday=true"
            f"&coordinate_type=dd"
            f"&latitude={lat3}&longitude={lon3}"
            f"&multi={json.dumps([[lat3, lon3]])}"
        )
        resp = sess.post(
            post_url, data=body,
            headers={"Content-type": "application/x-www-form-urlencoded; charset=UTF-8"},
            timeout=30,
        )
        resp.raise_for_status()
        html = resp.text

        # Clean HTML for pandas
        html = re.sub(r"<abbr[^>]*>([^<]*)</abbr>", r"\1", html, flags=re.IGNORECASE)
        html = re.sub(r'\s+width="[^"]*"', "", html, flags=re.IGNORECASE)
        html = re.sub(r'\s+colspan="100%"', "", html, flags=re.IGNORECASE)

        _marker = html.find("ifdDepthTab")
        if _marker == -1:
            return {"_error": "ifdDepthTab not found in BOM response"}

        _ts = html.find("<table", _marker)
        _te = html.find("</table>", _ts) + len("</table>")
        tbl_html = html[_ts:_te]

        tables = pd.read_html(io.StringIO(tbl_html))
        if not tables:
            return {"_error": "No table found"}

        df = tables[0]
        df = df.set_index(df.columns[0])
        df.index = df.index.astype(str).str.strip()

        if isinstance(df.columns, pd.MultiIndex):
            df.columns = [str(c[-1]).strip() for c in df.columns]
        else:
            df.columns = [str(c).strip() for c in df.columns]

        df.columns = [re.sub(r"[#*†‡]+$", "", c).strip() for c in df.columns]

        # AEP columns present in the table
        aep_cols = list(df.columns)

        # Build full duration table — skip winter-factor rows
        durations = []
        table: dict[str, dict[str, float]] = {}
        dur_24_key = None

        for idx in df.index:
            mins = _dur_to_minutes(idx)
            if mins is None:
                continue  # skip winter factors and unparseable rows
            row_data: dict[str, float] = {}
            for col in aep_cols:
                try:
                    f = float(df.loc[idx, col])
                    if not pd.isna(f):
                        row_data[str(col).strip()] = round(f, 1)
                except (ValueError, TypeError):
                    pass
            if not row_data:
                continue
            durations.append(idx)
            table[idx] = row_data
            if mins == 1440:          # 24-hour row
                dur_24_key = idx

        if not durations:
            return {"_error": "No IFD values extracted"}

        # Build result — flat 24-hr values at top level for backwards compat
        result: dict = {"durations": durations, "aep_cols": aep_cols, "table": table}
        ref_row = dur_24_key or durations[-1]
        for col, val in table[ref_row].items():
            result[col] = val          # e.g. result["50%"] = 112.0

        return result

    except Exception as e:
        return {"_error": str(e)}


# ── Postcode DB ────────────────────────────────────────────────────────────────
@lru_cache(maxsize=1)
def _postcode_db() -> pd.DataFrame:
    local = DATA_DIR / "postcodes.parquet"
    if local.exists():
        df = pd.read_parquet(local)
    else:
        df = pd.read_csv(
            _POSTCODE_URL,
            usecols=["postcode", "locality", "state", "lat", "long"],
            dtype={"postcode": str},
        )
        df["postcode"] = df["postcode"].str.zfill(4)
        df["locality"] = df["locality"].fillna("").str.strip()
        try:
            df.to_parquet(local, index=False)
        except Exception:
            pass
    return df.dropna(subset=["lat", "long"])


# ── GET /api/geocode ──────────────────────────────────────────────────────────
@app.get("/api/geocode", summary="Geocode suburb or postcode")
def geocode(q: str = Query(..., min_length=2)):
    result = _geocode(q)
    if result is None:
        raise HTTPException(404, f"Location '{q}' not found")
    lat, lon, label = result
    return {"lat": lat, "lon": lon, "label": label}


def _geocode(query: str):
    q = query.strip()
    db = _postcode_db()

    # Postcode-only
    if q.isdigit():
        rows = db[db["postcode"] == q.zfill(4)]
        if not rows.empty:
            r = rows.iloc[0]
            return float(r["lat"]), float(r["long"]), f"{r['locality'].title()}, {r['state']} {r['postcode']}"

    # Build a list of candidate locality strings to try, in priority order.
    # Handles typed autocomplete labels like "Orange, NSW 2800" or "Orange, NSW".
    candidates: list[str] = [q]
    # Strip trailing postcode:  "Orange, NSW 2800" → "Orange, NSW"
    stripped_pc = re.sub(r",?\s+\d{4}\s*$", "", q).strip()
    if stripped_pc and stripped_pc != q:
        candidates.append(stripped_pc)
    # Strip trailing ", STATE":  "Orange, NSW" → "Orange"
    stripped_state = re.sub(r",?\s+[A-Z]{2,3}\s*$", "", stripped_pc or q).strip()
    if stripped_state and stripped_state not in candidates:
        candidates.append(stripped_state)
    # Also try just the postcode if the query contains one
    m_pc = re.search(r"\b(\d{4})\b", q)
    if m_pc:
        candidates.append(m_pc.group(1))

    # State filter if present in query
    m_state = re.search(r"\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b", q, re.IGNORECASE)
    state_filter = m_state.group(1).upper() if m_state else None

    try:
        for candidate in candidates:
            cl = candidate.lower()
            # Postcode candidate
            if cl.isdigit():
                rows = db[db["postcode"] == cl.zfill(4)]
                if state_filter:
                    rows = rows[rows["state"].str.upper() == state_filter]
                if not rows.empty:
                    r = rows.iloc[0]
                    return float(r["lat"]), float(r["long"]), f"{r['locality'].title()}, {r['state']} {r['postcode']}"
                continue
            # Exact locality match
            exact = db[db["locality"].str.lower() == cl]
            if state_filter:
                exact = exact[exact["state"].str.upper() == state_filter]
            if not exact.empty:
                r = exact.iloc[0]
                return float(r["lat"]), float(r["long"]), f"{r['locality'].title()}, {r['state']}, Australia"
            # Partial locality match
            partial = db[db["locality"].str.lower().str.contains(cl, regex=False, na=False)]
            if state_filter:
                partial = partial[partial["state"].str.upper() == state_filter]
            if not partial.empty:
                r = partial.iloc[0]
                return float(r["lat"]), float(r["long"]), f"{r['locality'].title()}, {r['state']}, Australia"
    except Exception:
        pass

    # Photon fallback
    try:
        resp = requests.get(
            "https://photon.komoot.io/api/",
            params={"q": f"{query} Australia", "limit": 5, "lang": "en"},
            headers={"User-Agent": "BOM-Rainfall-App/1.0"},
            timeout=10,
        )
        resp.raise_for_status()
        for feat in resp.json().get("features", []):
            props = feat.get("properties", {})
            if props.get("country_code", "").lower() == "au":
                lon2, lat2 = feat["geometry"]["coordinates"]
                parts = [props.get(k) for k in ("name", "city", "county", "state") if props.get(k)]
                parts.append("Australia")
                return float(lat2), float(lon2), ", ".join(dict.fromkeys(parts))
    except Exception:
        pass

    return None


# ── GET /api/suggest ──────────────────────────────────────────────────────────
@app.get("/api/suggest", summary="Autocomplete suburb/postcode suggestions")
def suggest(q: str = Query(..., min_length=1), limit: int = 8):
    q = q.strip()
    db = _postcode_db()
    results: list[dict] = []
    seen: set[str] = set()

    def _add(rows, n):
        for _, r in rows.iterrows():
            if len(results) >= n:
                break
            label = f"{r['locality'].title()}, {r['state']} {r['postcode']}"
            if label in seen:
                continue
            seen.add(label)
            results.append({
                "label":    label,
                "locality": r["locality"].title(),
                "state":    r["state"],
                "postcode": r["postcode"],
                "lat":      float(r["lat"]),
                "lon":      float(r["long"]),
            })

    if q.isdigit():
        _add(db[db["postcode"].str.startswith(q)], limit)
    else:
        ql = q.lower()
        starts   = db[db["locality"].str.lower().str.startswith(ql, na=False)]
        _add(starts, limit)
        if len(results) < limit:
            contains = db[
                db["locality"].str.lower().str.contains(ql, regex=False, na=False)
                & ~db["locality"].str.lower().str.startswith(ql, na=False)
            ]
            _add(contains, limit)

    return results


# ── Export helpers ────────────────────────────────────────────────────────────
def _build_export_df(station_id: str, distribute: bool) -> tuple[pd.DataFrame, dict]:
    """Return (daily_df with Date col, station_info) for exports."""
    cached = _fetch_rainfall_cached(station_id)
    df     = cached["df"].copy()
    info   = cached["info"]

    df.columns = df.columns.str.strip()
    rain_col   = next((c for c in df.columns if "rainfall" in c.lower()), None)
    period_col = next((c for c in df.columns if "period" in c.lower()), None)

    if not rain_col:
        raise ValueError("No rainfall column found.")

    df["Date"]   = pd.to_datetime(df[["Year", "Month", "Day"]], errors="coerce")
    df[rain_col] = pd.to_numeric(df[rain_col], errors="coerce")

    if period_col and distribute:
        df[period_col] = pd.to_numeric(df[period_col], errors="coerce").fillna(1).clip(lower=1)
        df = df.set_index("Date").sort_index()
        rain_series = df[rain_col].copy()
        for date, row in df[df[period_col] > 1].iterrows():
            p = int(row[period_col])
            r = row[rain_col]
            if pd.isna(r):
                continue
            daily = round(r / p, 1)
            for i in range(p):
                d = date - pd.Timedelta(days=i)
                if d in rain_series.index:
                    rain_series[d] = daily
        df[rain_col] = rain_series
        df = df.reset_index()  # index was "Date"; reset restores it as column "Date"

    df = df.rename(columns={rain_col: "Rainfall_mm"})
    return df, info, "Rainfall_mm"


# ── GET /api/export/{station_id}/csv ─────────────────────────────────────────
@app.get("/api/export/{station_id}/csv", summary="Download station CSV")
def export_csv(
    station_id: str,
    distribute: bool = Query(True),
):
    station_id = station_id.strip().zfill(6)
    try:
        df, info, rain_col = _build_export_df(station_id, distribute)
    except RuntimeError as e:
        raise HTTPException(400, str(e))

    export_df = df[["Date", rain_col]].copy()
    export_df["Date"] = pd.to_datetime(export_df["Date"]).dt.strftime("%Y-%m-%d")
    buf = io.StringIO()
    export_df.to_csv(buf, index=False)
    buf.seek(0)

    return StreamingResponse(
        io.BytesIO(buf.getvalue().encode()),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="bom_rainfall_{station_id}.csv"'},
    )


# ── XLSX sheet helpers ────────────────────────────────────────────────────────
def _df_missing_days(df: pd.DataFrame, rain_col: str = "Rainfall_mm") -> pd.DataFrame:
    df = df.copy()
    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    df = df.dropna(subset=["Date"])
    if df.empty:
        return pd.DataFrame()
    MO = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    recorded = (
        df.dropna(subset=[rain_col])
        .groupby([df["Date"].dt.year, df["Date"].dt.month]).size()
    )
    fy, fm = df["Date"].min().year, df["Date"].min().month
    ly, lm = df["Date"].max().year, df["Date"].max().month
    rows = []
    for yr in sorted(df["Date"].dt.year.unique()):
        row: dict = {"Year": int(yr)}
        total = 0
        for mo in range(1, 13):
            if yr == fy and mo < fm: row[MO[mo-1]] = None; continue
            if yr == ly and mo > lm: row[MO[mo-1]] = None; continue
            exp  = (pd.Timestamp(yr, mo, 1) + pd.offsets.MonthEnd(1)).day
            pres = recorded.get((yr, mo), 0)
            miss = max(0, exp - pres)
            row[MO[mo-1]] = miss
            total += miss
        row["Total_Missing"] = total
        rows.append(row)
    return pd.DataFrame(rows)


def _df_ams(df: pd.DataFrame, rain_col: str = "Rainfall_mm", max_missing: int = 30) -> pd.DataFrame:
    df = df.copy()
    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    df = df.dropna(subset=["Date"])
    if df.empty:
        return pd.DataFrame()
    recorded = (
        df.dropna(subset=[rain_col])
        .groupby([df["Date"].dt.year, df["Date"].dt.month]).size()
    )
    fy, fm = df["Date"].min().year, df["Date"].min().month
    ly, lm = df["Date"].max().year, df["Date"].max().month
    rows = []
    for yr, grp in df.groupby(df["Date"].dt.year):
        miss = 0
        for mo in range(1, 13):
            if yr == fy and mo < fm: continue
            if yr == ly and mo > lm: continue
            exp  = (pd.Timestamp(yr, mo, 1) + pd.offsets.MonthEnd(1)).day
            pres = recorded.get((yr, mo), 0)
            miss += max(0, exp - pres)
        valid = grp[rain_col].dropna()
        if valid.empty: continue
        rows.append({"Year": int(yr), "Annual_Max_mm": round(float(valid.max()), 1),
                     "Missing_Days": int(miss), "Excluded": miss > max_missing})
    included = sorted([r for r in rows if not r["Excluded"]], key=lambda r: r["Annual_Max_mm"], reverse=True)
    n = len(included)
    for i, r in enumerate(included):
        r.update({"Rank": i+1, "ARI_years": round((n+1)/(i+1), 1), "AEP": round((i+1)/(n+1), 3)})
    rank_map = {r["Year"]: r for r in included}
    for r in rows:
        if r["Year"] not in rank_map:
            r.update({"Rank": None, "ARI_years": None, "AEP": None})
    df_out = pd.DataFrame(sorted(rows, key=lambda r: r["Year"]))
    for col in ["Rank", "ARI_years", "AEP"]:
        if col not in df_out.columns:
            df_out[col] = None
    return df_out[["Year","Annual_Max_mm","Rank","ARI_years","AEP","Missing_Days","Excluded"]]


# ── GET /api/export/{station_id}/xlsx ────────────────────────────────────────
@app.get("/api/export/{station_id}/xlsx", summary="Download station XLSX")
def export_xlsx(
    station_id:    str,
    distribute:    bool          = Query(True),
    sheets:        str           = Query("daily,monthly,annual"),
    ams_threshold: int           = Query(30),
    lat:           Optional[float] = Query(None),
    lon:           Optional[float] = Query(None),
):
    station_id = station_id.strip().zfill(6)
    try:
        df, info, rain_col = _build_export_df(station_id, distribute)
    except RuntimeError as e:
        raise HTTPException(400, str(e))

    requested = {s.strip().lower() for s in sheets.split(",")}

    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    df = df.dropna(subset=["Date"])

    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="xlsxwriter") as writer:
        wb = writer.book
        hdr_fmt = wb.add_format({"bold": True, "bg_color": "#1a6eb5",
                                  "font_color": "#ffffff", "border": 1})

        def _write_sheet(data_df: pd.DataFrame, name: str, col_w: list | None = None):
            data_df.to_excel(writer, index=False, sheet_name=name)
            ws = writer.sheets[name]
            for ci, cn in enumerate(data_df.columns):
                ws.write(0, ci, cn, hdr_fmt)
            if col_w:
                for ci, w in enumerate(col_w):
                    ws.set_column(ci, ci, w)
            ws.freeze_panes(1, 0)

        if "daily" in requested:
            d = df[["Date", rain_col]].copy()
            d["Date"] = d["Date"].dt.strftime("%Y-%m-%d")
            d = d.rename(columns={rain_col: "Rainfall_mm"})
            _write_sheet(d, "Daily Rainfall", [12, 14])

        if "monthly" in requested:
            MN = {1:"Jan",2:"Feb",3:"Mar",4:"Apr",5:"May",6:"Jun",
                  7:"Jul",8:"Aug",9:"Sep",10:"Oct",11:"Nov",12:"Dec"}
            mo = (df.groupby([df["Date"].dt.year.rename("Year"),
                               df["Date"].dt.month.rename("Month")])[rain_col]
                  .sum().round(1).reset_index())
            mo["Month"] = mo["Month"].map(MN)
            mo = mo.rename(columns={rain_col: "Total_mm"})
            _write_sheet(mo, "Monthly Summary", [8, 10, 14])

        if "annual" in requested:
            an = (df.groupby(df["Date"].dt.year.rename("Year"))[rain_col]
                  .agg(Total_mm="sum", Missing_Days=lambda x: int(x.isna().sum()))
                  .round(1).reset_index())
            _write_sheet(an, "Annual Summary", [8, 14, 14])

        if "missing" in requested:
            miss_df = _df_missing_days(df.rename(columns={rain_col: "Rainfall_mm"}))
            if not miss_df.empty:
                _write_sheet(miss_df, "Missing Days")

        if "ams" in requested:
            ams_df = _df_ams(df.rename(columns={rain_col: "Rainfall_mm"}),
                             max_missing=ams_threshold)
            if not ams_df.empty:
                _write_sheet(ams_df, "AMS", [8, 14, 8, 10, 8, 14, 10])

        if "ifd" in requested and lat is not None and lon is not None:
            try:
                ifd = _fetch_ifd(lat, lon)
                if "_error" not in ifd:
                    ifd_rows = []
                    for dur in ifd.get("durations", []):
                        mins = _dur_to_minutes(dur)
                        row: dict = {"Duration": dur, "Duration_min": mins or ""}
                        for aep in ifd.get("aep_cols", []):
                            depth = ifd["table"].get(dur, {}).get(aep)
                            row[f"Depth_{aep}_mm"] = depth if depth is not None else ""
                            row[f"Intensity_{aep}_mmhr"] = (
                                round(depth / mins * 60, 1)
                                if (depth is not None and mins) else ""
                            )
                        ifd_rows.append(row)
                    if ifd_rows:
                        _write_sheet(pd.DataFrame(ifd_rows), "IFD (BOM 2016)")
            except Exception:
                pass

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="bom_rainfall_{station_id}.xlsx"'},
    )


# ── Batch export helpers ──────────────────────────────────────────────────────
def _batch_fetch(station_ids: List[str], distribute: bool):
    """Fetch a list of stations in parallel (≤4 concurrent BOM requests).
    Returns (results, errors) where:
        results = list of (sid, df, info)
        errors  = dict {sid: error_message}
    """
    results, errors = [], {}

    def _one(sid):
        sid = str(sid).strip().zfill(6)
        try:
            df, info, _ = _build_export_df(sid, distribute)
            return sid, df, info, None
        except _NoDataError as e:
            return sid, None, None, f"No rainfall data available ({e})"
        except Exception as e:
            return sid, None, None, str(e)

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(_one, sid): sid for sid in station_ids}
        for fut in concurrent.futures.as_completed(futs):
            sid, df, info, err = fut.result()
            if err:
                errors[sid] = err
            else:
                results.append((sid, df, info))

    return results, errors


# ── POST /api/export/batch/zip ────────────────────────────────────────────────
@app.post("/api/export/batch/zip", summary="Batch download multiple stations as ZIP of CSVs")
def batch_export_zip(
    station_ids: List[str] = Body(..., embed=True),
    distribute:  bool      = Query(True),
):
    """Accept JSON body {"station_ids": ["066011", "066037", ...]}."""
    if not station_ids:
        raise HTTPException(400, "No station IDs provided.")
    station_ids = list(dict.fromkeys(s.strip().zfill(6) for s in station_ids))[:50]

    results, errors = _batch_fetch(station_ids, distribute)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for sid, df, info in results:
            safe_name = (
                (info.get("name") or sid)
                .replace("/", "-").replace("\\", "-").replace(":", "")
                .strip()
            )
            fname = f"{sid}_{safe_name}.csv"
            export_df = df[["Date", "Rainfall_mm"]].copy()
            export_df["Date"] = pd.to_datetime(export_df["Date"]).dt.strftime("%Y-%m-%d")
            zf.writestr(fname, export_df.to_csv(index=False))

        if errors:
            zf.writestr(
                "_errors.txt",
                "\n".join(f"{sid}: {msg}" for sid, msg in errors.items()),
            )

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="bom_rainfall_batch.zip"'},
    )


# ── POST /api/export/batch/xlsx ───────────────────────────────────────────────
@app.post("/api/export/batch/xlsx", summary="Batch download multiple stations as multi-sheet XLSX")
def batch_export_xlsx(
    station_ids: List[str] = Body(..., embed=True),
    distribute:  bool      = Query(True),
):
    """Accept JSON body {"station_ids": [...]}. One sheet per station (max 20)."""
    if not station_ids:
        raise HTTPException(400, "No station IDs provided.")
    station_ids = list(dict.fromkeys(s.strip().zfill(6) for s in station_ids))[:20]

    results, errors = _batch_fetch(station_ids, distribute)

    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="xlsxwriter") as writer:
        wb = writer.book
        hdr_fmt = wb.add_format({"bold": True, "bg_color": "#1a6eb5",
                                  "font_color": "#ffffff", "border": 1})

        for sid, df, info in results:
            stn_name = (info.get("name") or sid)
            # Excel sheet names: max 31 chars, no special chars
            sheet_name = re.sub(r'[\\/*?:\[\]]', '', sid)[:31]

            df2 = df[["Date", "Rainfall_mm"]].copy()
            df2["Date"] = pd.to_datetime(df2["Date"], errors="coerce").dt.strftime("%Y-%m-%d")
            df2.to_excel(writer, index=False, sheet_name=sheet_name)
            ws = writer.sheets[sheet_name]
            for ci, cn in enumerate(df2.columns):
                ws.write(0, ci, cn, hdr_fmt)
            ws.set_column(0, 0, 12)
            ws.set_column(1, 1, 14)
            ws.write_comment(0, 0, f"Station: {stn_name} ({sid})")
            ws.freeze_panes(1, 0)

        if errors:
            err_ws = wb.add_worksheet("_Errors")
            err_ws.write(0, 0, "Station_ID", hdr_fmt)
            err_ws.write(0, 1, "Error",      hdr_fmt)
            for r, (sid2, msg) in enumerate(errors.items(), start=1):
                err_ws.write(r, 0, sid2)
                err_ws.write(r, 1, msg)
            err_ws.set_column(0, 0, 12)
            err_ws.set_column(1, 1, 60)

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="bom_rainfall_batch.xlsx"'},
    )


# ── Run ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import os, uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("api:app", host="0.0.0.0", port=port, reload=(port == 8000))
