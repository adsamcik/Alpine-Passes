const EARTH_RADIUS_M = 6_371_000;

export function clamp(value, min = 0, max = 1) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function haversineM(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function pointSegmentDistanceM(point, a, b) {
  const origin = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
  const p = project(point, origin);
  const pA = project(a, origin);
  const pB = project(b, origin);
  const dx = pB.x - pA.x;
  const dy = pB.y - pA.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - pA.x, p.y - pA.y);
  const t = clamp(((p.x - pA.x) * dx + (p.y - pA.y) * dy) / len2, 0, 1);
  return Math.hypot(p.x - (pA.x + t * dx), p.y - (pA.y + t * dy));
}

export function segmentProjection(point, a, b) {
  const origin = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
  const p = project(point, origin);
  const pA = project(a, origin);
  const pB = project(b, origin);
  const dx = pB.x - pA.x;
  const dy = pB.y - pA.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return 0;
  return ((p.x - pA.x) * dx + (p.y - pA.y) * dy) / len2;
}

export function polylineLengthM(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += haversineM(points[i - 1], points[i]);
  }
  return total;
}

export function fallbackGeometry(a, b, count = 13) {
  const distance = haversineM(a, b);
  const curve = clamp(distance / 80_000, 0.002, 0.018);
  const latDelta = b.lat - a.lat;
  const lonDelta = b.lon - a.lon;
  const perpLat = -lonDelta;
  const perpLon = latDelta;
  const points = [];

  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0 : i / (count - 1);
    const bend = Math.sin(Math.PI * t) * curve;
    points.push({
      lat: roundCoord(a.lat + latDelta * t + perpLat * bend),
      lon: roundCoord(a.lon + lonDelta * t + perpLon * bend),
    });
  }

  return points;
}

export function toLatLonArray(points) {
  return dedupePoints(points).map((p) => [roundCoord(p.lat), roundCoord(p.lon)]);
}

export function dedupePoints(points) {
  const out = [];
  for (const point of points) {
    if (!isValidCoord(point)) continue;
    const prev = out[out.length - 1];
    if (!prev || Math.abs(prev.lat - point.lat) > 1e-6 || Math.abs(prev.lon - point.lon) > 1e-6) {
      out.push({ lat: Number(point.lat), lon: Number(point.lon) });
    }
  }
  return out;
}

export function roundCoord(value) {
  return Math.round(Number(value) * 100_000) / 100_000;
}

export function roundNumber(value, decimals = 3) {
  const scale = 10 ** decimals;
  return Math.round(Number(value) * scale) / scale;
}

export function isValidCoord(point) {
  return point
    && Number.isFinite(Number(point.lat))
    && Number.isFinite(Number(point.lon))
    && Math.abs(Number(point.lat)) <= 90
    && Math.abs(Number(point.lon)) <= 180;
}

export function coordFromPair(pair) {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const lat = Number(pair[0]);
  const lon = Number(pair[1]);
  return isValidCoord({ lat, lon }) ? { lat, lon } : null;
}

export function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function slug(value) {
  return normalizeName(value).replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
}

export function quantile(sortedValues, q) {
  if (!sortedValues.length) return 0;
  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedValues[base + 1];
  return next === undefined ? sortedValues[base] : sortedValues[base] + rest * (next - sortedValues[base]);
}

function project(point, origin) {
  const lat = toRad(point.lat);
  const lon = toRad(point.lon);
  const lat0 = toRad(origin.lat);
  const lon0 = toRad(origin.lon);
  return {
    x: (lon - lon0) * Math.cos(lat0) * EARTH_RADIUS_M,
    y: (lat - lat0) * EARTH_RADIUS_M,
  };
}

function toRad(value) {
  return Number(value) * Math.PI / 180;
}
