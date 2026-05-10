import crypto from "node:crypto";
import { clamp, haversineM, roundCoord } from "./geo.mjs";

export const ROAD_CLASS_MULTIPLIER = Object.freeze({
  motorway: 1.5,
  trunk: 1.4,
  primary: 1.0,
  secondary: 0.9,
  tertiary: 0.85,
  unclassified: 0.95,
  track: 1.2,
  default: 1.0,
});

export function roadMultiplier(roadClass) {
  return ROAD_CLASS_MULTIPLIER[roadClass] ?? ROAD_CLASS_MULTIPLIER.default;
}

export function leisureCost(durationS, roadClass = "default", scenicWeight = 0, outAndBackMultiplier = 1) {
  const duration = Number(durationS);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return duration
    * roadMultiplier(roadClass)
    * (1 - clamp(scenicWeight, 0, 0.5))
    * Math.max(0, Number(outAndBackMultiplier) || 0);
}

export function statsFor(values) {
  const clean = values.filter(Number.isFinite);
  const mean = clean.reduce((sum, value) => sum + value, 0) / Math.max(1, clean.length);
  const variance = clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, clean.length);
  return { mean, std: Math.sqrt(variance) || 1 };
}

export function zScore(value, stats) {
  return (value - stats.mean) / stats.std;
}

export function zNormalize(values) {
  const stats = statsFor(values);
  return values.map((value) => zScore(value, stats));
}

export function shortHash(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12);
}

export function cacheKeyHash(value) {
  return shortHash(typeof value === "string" ? value : JSON.stringify(value));
}

export function osrmChunkHash(points, sourceIndexes, destIndexes) {
  const payload = {
    v: 1,
    sources: sourceIndexes.map((index) => pointHashTuple(points[index])),
    destinations: destIndexes.map((index) => pointHashTuple(points[index])),
  };
  return cacheKeyHash(payload);
}

export function pointHashTuple(point) {
  return [point.cacheId ?? point.id, roundCoord(point.lat), roundCoord(point.lon)];
}

export function selectKNearestCandidates(candidates, k) {
  return candidates
    .slice()
    .sort((a, b) => a.leisureCost - b.leisureCost || a.distanceM - b.distanceM)
    .slice(0, k);
}

export function nearestByDistance(origin, candidates, k, maxDistanceM = Infinity) {
  return candidates
    .map((candidate) => ({
      ...candidate,
      distanceM: candidate.distanceM ?? haversineM(origin, candidate),
    }))
    .filter((candidate) => candidate.distanceM <= maxDistanceM)
    .sort((a, b) => a.distanceM - b.distanceM || String(a.id).localeCompare(String(b.id)))
    .slice(0, k);
}
