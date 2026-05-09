const test = require("node:test");
const assert = require("node:assert/strict");

const { loadPlannerHooks, loadRawPasses } = require("./helpers/plannerTestLoader");

const planner = loadPlannerHooks();

function matrixForStops(stopCount, fallback = 1_000_000) {
  const size = 1 + stopCount * 3;
  const dist = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => (i === j ? 0 : fallback))
  );
  const dur = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => (i === j ? 0 : fallback))
  );
  return { dist, dur };
}

function setEdge(matrix, from, to, metres, seconds = metres) {
  matrix.dist[from][to] = metres;
  matrix.dist[to][from] = metres;
  matrix.dur[from][to] = seconds;
  matrix.dur[to][from] = seconds;
}

function setDirectedEdge(matrix, from, to, metres, seconds = metres) {
  matrix.dist[from][to] = metres;
  matrix.dur[from][to] = seconds;
}

function pointIndex(passIdx, pointIdx) {
  return 1 + passIdx * 3 + pointIdx;
}

function ll(lat, lon) {
  return { lat, lon };
}

function lngLatLine(points) {
  return points.map(([lat, lon]) => [lon, lat]);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function northSouthOutAndBack() {
  const outbound = Array.from({ length: 13 }, (_, i) => [0, i * 0.0018]);
  const inbound = outbound.slice(0, -1).reverse();
  return outbound.concat(inbound);
}

function singleLegDeadEndSpur() {
  const outbound = Array.from({ length: 13 }, (_, i) => [0, i * 0.0018]);
  const inbound = outbound.slice(0, -1).reverse();
  return outbound.concat(inbound, [[0, -0.0018]]);
}

function syntheticRouteWithRetracedFirstLastLeg(numLegs) {
  const latlngs = [];
  const wpIdx = [0];
  const line = (baseLat, startLon, endLon) =>
    Array.from({ length: 13 }, (_, i) => [baseLat, startLon + (endLon - startLon) * i / 12]);
  const appendLeg = points => {
    if (!latlngs.length) latlngs.push(...points);
    else latlngs.push(...points.slice(1));
    wpIdx.push(latlngs.length - 1);
  };

  appendLeg(line(0, 0, 0.0216));
  for (let leg = 1; leg < numLegs - 1; leg++) {
    appendLeg(line(leg * 0.02, 0.1, 0.1216));
  }
  appendLeg(line(0, 0.0216, 0));
  return { latlngs, wpIdx };
}

test("selected-route optimizer never returns out-and-back pass visits", () => {
  const matrix = matrixForStops(2);

  for (let pass = 0; pass < 2; pass++) {
    setEdge(matrix, pointIndex(pass, 0), pointIndex(pass, 1), 1_000);
    setEdge(matrix, pointIndex(pass, 1), pointIndex(pass, 2), 1_000);
  }
  setEdge(matrix, 0, pointIndex(0, 0), 1_000);
  setEdge(matrix, pointIndex(0, 2), pointIndex(1, 0), 1_000);
  setEdge(matrix, pointIndex(1, 2), 0, 1_000);

  const result = planner.bestExactSelectedTour(matrix, 2, [
    { qSummit: 0.8, qApproach: 0.8 },
    { qSummit: 0.8, qApproach: 0.8 },
  ]);

  assert.equal(result.perm.length, 2);
  assert.deepEqual(plain(result.perm.map(t => t.mode)), ["traverse", "traverse"]);
  assert.ok(result.perm.every(t => t.enterSide !== t.exitSide));
});

test("POI stops are canonicalized and include dwell time", () => {
  const matrix = matrixForStops(1, 0);
  const result = planner.bestExactSelectedTour(matrix, 1, [{ qSummit: 1, qApproach: 0 }], [
    { id: "poi-a", isPoi: true, visitDwellSec: 90 * 60 },
  ]);

  assert.deepEqual(plain(result.perm), [{ passIdx: 0, enterSide: 0, exitSide: 0, mode: "poi" }]);
  assert.equal(result.dwellH, 1.5);
  assert.equal(result.totalH, result.driveH + 1.5);
});

test("selected-route optimizer returns null when only out-and-back visits are finite", () => {
  const matrix = matrixForStops(1, Infinity);
  setEdge(matrix, 0, pointIndex(0, 0), 1_000);
  setEdge(matrix, pointIndex(0, 0), pointIndex(0, 1), 1_000);
  setEdge(matrix, pointIndex(0, 1), pointIndex(0, 0), 1_000);

  assert.equal(planner.bestExactSelectedTour(matrix, 1), null);
});

test("Bellinzona-style selected-route repair penalizes retraced first and final connectors", () => {
  const matrix = matrixForStops(4);
  const start = ll(46.194, 9.024);
  const stops = Array.from({ length: 4 }, (_, i) => ({
    id: `p${i}`,
    name: `Pass ${i}`,
    lat: 46 + i * 0.01,
    lon: 9 + i * 0.01,
    baseA: ll(46 + i * 0.01, 9.1 + i * 0.01),
    baseB: ll(46 + i * 0.01, 9.2 + i * 0.01),
  }));

  for (let pass = 0; pass < 4; pass++) {
    setDirectedEdge(matrix, pointIndex(pass, 0), pointIndex(pass, 1), 1_000);
    setDirectedEdge(matrix, pointIndex(pass, 1), pointIndex(pass, 2), 1_000);
    setDirectedEdge(matrix, pointIndex(pass, 2), pointIndex(pass, 1), 50_000);
    setDirectedEdge(matrix, pointIndex(pass, 1), pointIndex(pass, 0), 50_000);
  }

  const badOrder = [2, 3, 1, 0];
  setDirectedEdge(matrix, 0, pointIndex(2, 0), 100);
  setDirectedEdge(matrix, pointIndex(2, 2), pointIndex(3, 0), 100);
  setDirectedEdge(matrix, pointIndex(3, 2), pointIndex(1, 0), 100);
  setDirectedEdge(matrix, pointIndex(1, 2), pointIndex(0, 0), 100);
  setDirectedEdge(matrix, pointIndex(0, 2), 0, 100);

  setDirectedEdge(matrix, 0, pointIndex(0, 0), 140);
  setDirectedEdge(matrix, pointIndex(0, 2), pointIndex(1, 0), 140);
  setDirectedEdge(matrix, pointIndex(1, 2), pointIndex(3, 0), 140);
  setDirectedEdge(matrix, pointIndex(3, 2), pointIndex(2, 0), 140);
  setDirectedEdge(matrix, pointIndex(2, 2), 0, 140);

  const first = planner.bestExactSelectedTour(matrix, 4, null, stops);
  assert.deepEqual(plain(first.perm.map(t => t.passIdx)), badOrder);

  const plan = planner.tourWaypointPlan(start, stops, first.perm);
  const { latlngs, wpIdx } = syntheticRouteWithRetracedFirstLastLeg(plan.wpMatrixIdx.length - 1);
  const retraced = planner.detectRetracedConnectorLegs(latlngs, wpIdx, plan.wpMatrixIdx);
  assert.equal(retraced.length, 1);
  assert.deepEqual(plain([retraced[0].legA, retraced[0].legB]), [0, 12]);

  planner.applyRetracePenalties(matrix, plan.wpMatrixIdx, retraced);
  const repaired = planner.bestExactSelectedTour(matrix, 4, null, stops);
  assert.notDeepEqual(plain(repaired.perm.map(t => t.passIdx)), badOrder);
  assert.deepEqual(plain(repaired.perm.map(t => t.passIdx).sort((a, b) => a - b)), [0, 1, 2, 3]);
  assert.ok(repaired.perm.every(t => t.mode === "traverse"));
});

test("auto planner prefers a high-discovery pass over a merely shorter pass in range", () => {
  const matrix = matrixForStops(2);
  for (let pass = 0; pass < 2; pass++) {
    setEdge(matrix, pointIndex(pass, 0), pointIndex(pass, 1), 1_000);
    setEdge(matrix, pointIndex(pass, 1), pointIndex(pass, 2), 1_000);
    setEdge(matrix, pointIndex(pass, 2), 0, pass === 0 ? 2_000 : 3_000);
  }
  setEdge(matrix, 0, pointIndex(0, 0), 2_000);
  setEdge(matrix, 0, pointIndex(1, 0), 3_000);

  const result = planner.bestTourGated(
    matrix,
    2,
    { mode: "distance", value: 7, tolerance: 0.4 },
    1,
    [
      { qSummit: 0.2, qApproach: 0.2 },
      { qSummit: 0.95, qApproach: 0.95 },
    ],
    null,
    [{ id: "short-low" }, { id: "slightly-longer-scenic" }]
  );

  assert.equal(result.perm.length, 1);
  assert.equal(result.perm[0].passIdx, 1);
  assert.ok(result.totalQuality > 0);
});

test("tour waypoint plan preserves arbitrary start and routes via summit parking", () => {
  const start = ll(46.194, 9.024);
  const stop = {
    id: "p-test",
    lat: 46.5,
    lon: 9.17,
    baseA: ll(46.53, 9.2),
    baseB: ll(46.47, 9.18),
    summitParking: { lat: 46.501, lon: 9.172 },
  };

  const points = planner.plannerPointsForPasses(start, [stop]);
  assert.deepEqual(points[0], start);

  const plan = planner.tourWaypointPlan(start, [stop], [{ passIdx: 0, enterSide: 0, exitSide: 1 }]);
  assert.deepEqual(plain(plan.waypoints), [
    [start.lat, start.lon],
    [stop.baseA.lat, stop.baseA.lon],
    [stop.summitParking.lat, stop.summitParking.lon],
    [stop.baseB.lat, stop.baseB.lon],
    [start.lat, start.lon],
  ]);
  assert.equal(planner.coordsFromWaypoints(plan.waypoints), "9.024,46.194;9.2,46.53;9.172,46.501;9.18,46.47;9.024,46.194");
});

test("ordered waypoint snapping uses the final occurrence of a repeated start", () => {
  const polyline = [
    [46, 9],
    [46.01, 9.01],
    [46.02, 9.02],
    [46, 9],
  ];
  const waypoints = [
    [46, 9],
    [46.01, 9.01],
    [46.02, 9.02],
    [46, 9],
  ];

  assert.deepEqual(plain(planner.orderedPolylineWaypointIndices(waypoints, polyline)), [0, 1, 2, 3]);
  assert.equal(planner.closestPolylineIdx([46, 9], polyline), 0);
});

test("adjacent connector out-and-back overlap is detected beyond the shared waypoint", () => {
  const latlngs = northSouthOutAndBack();
  const wpIdx = [0, 12, latlngs.length - 1];
  const wpMatrixIdx = [0, 2, 0];

  const retraced = planner.detectRetracedConnectorLegs(latlngs, wpIdx, wpMatrixIdx);

  assert.equal(retraced.length, 1);
  assert.deepEqual(plain([retraced[0].legA, retraced[0].legB]), [0, 1]);
  assert.ok(retraced[0].overlapM >= 1_200);
});

test("adjacent connector legs that only meet at a waypoint are not false positives", () => {
  const latlngs = [
    [0, -0.02],
    [0, -0.012],
    [0, -0.004],
    [0, 0],
    [0.004, 0],
    [0.012, 0],
    [0.02, 0],
  ];
  const wpIdx = [0, 3, 6];
  const wpMatrixIdx = [0, 2, 0];

  assert.deepEqual(plain(planner.detectRetracedConnectorLegs(latlngs, wpIdx, wpMatrixIdx)), []);
});

test("non-adjacent connector retrace remains detected", () => {
  const leg0 = Array.from({ length: 10 }, (_, i) => [0, i * 0.002]);
  const connector = [[0.01, 0.02], [0.02, 0.02], [0.03, 0.02]];
  const leg2 = leg0.slice().reverse();
  const latlngs = leg0.concat(connector, leg2);
  const wpIdx = [0, leg0.length - 1, leg0.length + connector.length - 1, latlngs.length - 1];
  const wpMatrixIdx = [0, 2, 5, 0];

  const retraced = planner.detectRetracedConnectorLegs(latlngs, wpIdx, wpMatrixIdx);

  assert.equal(retraced.length, 1);
  assert.deepEqual(plain([retraced[0].legA, retraced[0].legB]), [0, 2]);
});

test("same connector dead-end spur is detected as a retraced offshoot", () => {
  const latlngs = singleLegDeadEndSpur();
  const wpIdx = [0, latlngs.length - 1];
  const wpMatrixIdx = [0, 2];

  const retraced = planner.detectRetracedConnectorLegs(latlngs, wpIdx, wpMatrixIdx);

  assert.equal(retraced.length, 1);
  assert.deepEqual(plain([retraced[0].legA, retraced[0].legB]), [0, 0]);
  assert.ok(retraced[0].overlapM >= 1_200);
});

test("normal connector passing near itself briefly is not treated as a dead-end spur", () => {
  const latlngs = [
    [0, 0],
    [0, 0.001],
    [0.0002, 0.0012],
    [0.0004, 0.001],
    [0, 0.002],
    [0, 0.006],
    [0, 0.012],
  ];
  const wpIdx = [0, latlngs.length - 1];
  const wpMatrixIdx = [0, 2];

  assert.deepEqual(plain(planner.detectRetracedConnectorLegs(latlngs, wpIdx, wpMatrixIdx)), []);
});

test("internal pass climb/descent legs are excluded from retrace detection", () => {
  const latlngs = northSouthOutAndBack();
  const wpIdx = [0, 12, latlngs.length - 1];
  const samePassBaseSummitBase = [1, 2, 3];

  assert.deepEqual(plain(planner.detectRetracedConnectorLegs(latlngs, wpIdx, samePassBaseSummitBase)), []);
});

test("retrace penalties multiply both directions and both cost matrices", () => {
  const matrix = matrixForStops(2, 10);
  const wpMatrixIdx = [0, 2, 5, 0];
  planner.applyRetracePenalties(matrix, wpMatrixIdx, [{ legA: 0, legB: 2, overlapM: 2_000 }]);

  for (const [from, to] of [[0, 2], [2, 0], [5, 0], [0, 5]]) {
    assert.equal(matrix.dist[from][to], 30);
    assert.equal(matrix.dur[from][to], 30);
  }
  assert.equal(matrix.dist[2][5], 10);
});

test("route alternatives are ranked by least retraced connector overlap", () => {
  const plan = {
    waypoints: [[0, 0], [0, 0.0216], [0, 0]],
    wpMatrixIdx: [0, 2, 0],
  };
  const outAndBack = northSouthOutAndBack();
  const loop = [
    [0, 0],
    [0, 0.0216],
    [0.015, 0.0216],
    [0.015, 0],
    [0, 0],
  ];

  const ranked = planner.rankedRouteEntriesFromOsrm({
    routes: [
      { distanceKm: 5, durationH: 0.2, geom: lngLatLine(outAndBack) },
      { distanceKm: 6, durationH: 0.25, geom: lngLatLine(loop) },
    ],
  }, plan);

  assert.equal(ranked[0].route.distanceKm, 6);
  assert.equal(ranked[0].retrace.legs.length, 0);
  assert.ok(ranked[1].retrace.overlapM > 0);
});

test("implicit pass matching finds Klausen-style crossings split across waypoint legs", () => {
  const klaus = {
    id: "p77",
    name: "Klausenpass",
    lat: 0,
    lon: 0,
    baseA: ll(0, -0.04),
    baseB: ll(0, 0.04),
  };
  const hooks = loadPlannerHooks({ passes: [klaus] });
  const latlngs = [
    [0, -0.05],
    [0, -0.04],
    [0, -0.02],
    [0, 0],
    [0, 0.02],
    [0, 0.04],
    [0, 0.05],
  ];
  const wpIdx = [0, 3, 6];
  const wpMatrixIdx = [0, 2, 0];
  const result = hooks.routePassCrossingsForPlan({
    tourStops: [{ id: "planned", isPoi: true }],
    perm: [{ passIdx: 0, mode: "poi" }],
    wpMatrixIdx,
    wpIdx,
    latlngs,
    openOnly: false,
  });

  assert.equal(result.implicit.length, 1);
  assert.equal(result.implicit[0].pass.name, "Klausenpass");
});

test("implicit pass matching works on sparse gateway-to-gateway geometry without a summit vertex", () => {
  const klaus = {
    id: "p77",
    name: "Klausenpass",
    lat: 0,
    lon: 0,
    baseA: ll(0, -0.04),
    baseB: ll(0, 0.04),
  };
  const hooks = loadPlannerHooks({ passes: [klaus] });
  const result = hooks.routePassCrossingsForPlan({
    tourStops: [{ id: "planned", isPoi: true }],
    perm: [{ passIdx: 0, mode: "poi" }],
    wpMatrixIdx: [0, 2],
    wpIdx: [0, 1],
    latlngs: [[0, -0.04], [0, 0.04]],
    openOnly: false,
  });

  assert.equal(result.blocked.length, 0);
  assert.equal(result.implicit.length, 1);
  assert.equal(result.implicit[0].pass.name, "Klausenpass");
});

test("implicit pass matching ignores a single-gateway out-and-back spur", () => {
  const klaus = {
    id: "p77",
    name: "Klausenpass",
    lat: 0,
    lon: 0,
    baseA: ll(0, -0.04),
    baseB: ll(0, 0.04),
  };
  const hooks = loadPlannerHooks({ passes: [klaus] });
  const result = hooks.routePassCrossingsForPlan({
    tourStops: [{ id: "planned", isPoi: true }],
    perm: [{ passIdx: 0, mode: "poi" }],
    wpMatrixIdx: [0, 2],
    wpIdx: [0, 2],
    latlngs: [[0, -0.04], [0, 0], [0, -0.04], [0.02, 0.04]],
    openOnly: false,
  });

  assert.equal(result.blocked.length, 0);
  assert.equal(result.implicit.length, 0);
});

test("exact opening-date projections do not render as likely closed or likely open", () => {
  const date = { day: 25, month: 5, year: 2099 };
  const closed = {
    state: "closed",
    estimated: true,
    source: "estimate",
    stateText: "Likely closed",
    openingHint: { kind: "closed-until", date },
    projection: { basis: "opening-hint", guessed: false },
  };
  const open = {
    state: "open",
    estimated: true,
    source: "estimate",
    stateText: "Likely open",
    openingHint: { kind: "open-from", date },
    projection: { basis: "opening-hint", guessed: false },
  };

  assert.equal(planner.statusDisplay(closed).label, "Closed until 25 May 2099");
  assert.equal(planner.listStatusLabel(closed), "Closed until 25 May 2099");
  assert.equal(planner.statusDisplay(open).label, "Open from 25 May 2099");
  assert.equal(planner.listStatusLabel(open), "Open from 25 May 2099");
});

test("non-exact opening projections retain likely labels with the date as supporting detail", () => {
  const status = {
    state: "closed",
    estimated: true,
    source: "estimate",
    openingHint: { kind: "predicted", date: { day: 10, month: 6, year: 2026 } },
    projection: { basis: "opening-hint", guessed: true, listLabel: "opens 10 Jun 2026" },
  };

  assert.equal(planner.statusDisplay(status).label, "Likely closed");
  assert.equal(planner.listStatusLabel(status), "Likely closed (opens 10 Jun 2026)");
});

test("scenic stop planning chooses curated viewpoints, summit parking fallback, and rest placement", () => {
  const passes = [
    {
      id: "p-view",
      name: "View Pass",
      lat: 46,
      lon: 9,
      elev: 2200,
      quality: 0.9,
      qSummit: 0.8,
      qApproach: 0.8,
      viewpoints: [
        { name: "Low pullout", lat: 46.01, lon: 9.01, q: 0.4, side: "A", kind: "layby" },
        { name: "Panorama deck", lat: 46.02, lon: 9.02, q: 0.95, side: "B", kind: "viewpoint" },
      ],
      summitParking: { name: "Summit car park", lat: 46.03, lon: 9.03, kind: "summit-parking" },
    },
    {
      id: "p-park",
      name: "Parking Pass",
      lat: 47,
      lon: 10,
      elev: 1800,
      quality: 0.7,
      qSummit: 0.7,
      qApproach: 0.7,
      viewpoints: [],
      summitParking: { name: "Parking bay", lat: 47.01, lon: 10.01, kind: "summit-parking" },
    },
  ];

  const stops = planner.planScenicStops({
    tourStops: passes,
    modes: [
      { mode: "traverse", enterSide: 0, exitSide: 1 },
      { mode: "traverse", enterSide: 0, exitSide: 1 },
    ],
    extrasParts: { restCount: 1 },
    config: {
      passStopMin: 5,
      viewpointMode: "recommended",
      lunchBreak: "0",
      restBreakOn: true,
      restInterval: 2,
      restDuration: 15,
    },
  });

  assert.equal(stops.length, 2);
  assert.equal(stops[0].name, "Panorama deck");
  assert.equal(stops[0].source, "curated");
  assert.equal(stops[1].name, "Parking bay");
  assert.equal(stops[1].source, "summit-parking");
  assert.equal(stops.reduce((sum, s) => sum + s.restMin, 0), 15);
});

test("known Swiss topology regressions keep curated on-road bases", () => {
  const raw = loadRawPasses();
  const byName = name => raw.find(p => p.n === name);
  const near = (actual, expected, label) => {
    const km = planner.haversine(ll(actual[0], actual[1]), ll(expected[0], expected[1]));
    assert.ok(km < 0.55, `${label} should stay within 550m of curated on-road base, got ${km.toFixed(2)}km`);
  };

  near(byName("Passo del San Bernardino").bA, [46.53502, 9.19993], "San Bernardino north base");
  near(byName("Passo del San Bernardino").bB, [46.46982, 9.18488], "San Bernardino south base");
  near(byName("Grimselpass").bA, [46.56197, 8.36104], "Grimsel Gletsch-side base");
  near(byName("Grimselpass").bB, [46.58732, 8.33122], "Grimsel north-side base");
  near(byName("Oberalppass").bA, [46.64083, 8.60927], "Oberalp west base");
  near(byName("Oberalppass").bB, [46.65814, 8.71406], "Oberalp east base");
  near(byName("Passo del Lucomagno").bA, [46.61965, 8.82376], "Lukmanier north base");
  near(byName("Passo del Lucomagno").bB, [46.51240, 8.81886], "Lukmanier south base");
  near(byName("Furkapass").bA, [46.59111, 8.47193], "Furka east base");
  near(byName("Furkapass").bB, [46.57045, 8.39197], "Furka west base");
  near(byName("Malojapass").bA, [46.43280, 9.74559], "Maloja north/east base");
  near(byName("Malojapass").bB, [46.38478, 9.66267], "Maloja south/west base");
});
