//! Path geometry + RouteFacts merge — Rust port of the route* helpers in
//! `assets/js/leisure/lib/ui-translation.js`. See ADRs F3-001..F3-004 in the
//! program ADR registry.

pub const APPROX_ROUTE_WARNING: &str =
    "Could not fetch detailed route geometry; map line is approximate.";
pub const MAX_OSRM_WAYPOINTS: usize = 80;
pub const FALLBACK_SPEED_KMH: f64 = 45.0;
pub const AVG_SPEED_KMH: f64 = 55.0;

#[derive(Clone, Debug, PartialEq)]
pub struct MergedRoute {
    /// `[lon, lat]` pairs (matches OSRM and JS shape).
    pub geom: Vec<[f64; 2]>,
    pub distance_km: f64,
    pub duration_h: f64,
    pub route_warning: Option<&'static str>,
}

/// JS `routePoints(tour, graph, start)` — ui-translation.js line 276.
pub fn route_points(
    graph: &crate::LeisureGraph,
    tour: &crate::PublicTour,
    start: &crate::UiPoint,
) -> Vec<crate::UiPoint> {
    let path = if tour.path.is_empty() {
        crate::tour_dto::path_from_edges(&tour.edges)
    } else {
        tour.path.clone()
    };
    let path = crate::tour_dto::compressed_path(&path, graph);

    let mut points = Vec::new();
    let (lat, lon) = coord_of(start).unwrap_or((f64::NAN, f64::NAN));
    push_point(&mut points, lat, lon);

    for node_id in path {
        if let Some(node) = graph.nodes.get(&node_id) {
            push_point(&mut points, node.lat, node.lon);
        }
    }

    if is_closed_tour(tour) {
        let (lat, lon) = coord_of(start).unwrap_or((f64::NAN, f64::NAN));
        push_point(&mut points, lat, lon);
    } else if let Some(node) = graph.nodes.get(&tour.end_node) {
        push_point(&mut points, node.lat, node.lon);
    }

    points
}

/// Step 1 of the two-call OSRM protocol. Builds an OSRM-shaped RouteRequest
/// (coords as `[lon, lat]` pairs) from the tour's compressed path.
pub fn build_route_request(
    graph: &crate::LeisureGraph,
    tour: &crate::PublicTour,
    start: &crate::UiPoint,
) -> crate::ui_options::RouteRequest {
    let coords = route_points(graph, tour, start)
        .into_iter()
        .filter_map(|point| match point {
            crate::UiPoint::Coord { lat, lon, .. } => Some([lon, lat]),
            crate::UiPoint::Id(_) => None,
        })
        .collect();

    crate::ui_options::RouteRequest { coords }
}

/// Step 3 (merge half) of the two-call OSRM protocol. Mirrors JS
/// `routeForTour` lines 202-234.
pub fn merge_route_facts(
    points: &[crate::UiPoint],
    route_facts: Option<&crate::ui_options::RouteFacts>,
    tour: &crate::PublicTour,
) -> MergedRoute {
    let Some(route_facts) = route_facts else {
        let geom = points_to_geom(points);
        let distance_km = haversine_route_km(points);
        let duration_h = distance_km / AVG_SPEED_KMH;
        return MergedRoute {
            geom,
            distance_km,
            duration_h,
            route_warning: Some(APPROX_ROUTE_WARNING),
        };
    };

    let geom = if route_facts.geom.len() >= 2 {
        route_facts.geom.clone()
    } else {
        points_to_geom(points)
    };
    let distance_km = match route_facts.distance_km {
        Some(v) if v.is_finite() => v,
        _ => crate::extras::finite_or(tour.total_distance_km, haversine_route_km(points)),
    };
    let duration_h = match route_facts.duration_h {
        Some(v) if v.is_finite() => v,
        _ => crate::extras::finite_or(tour.total_duration_h, distance_km / FALLBACK_SPEED_KMH),
    };

    MergedRoute {
        geom,
        distance_km,
        duration_h,
        route_warning: None,
    }
}

/// JS `haversineRouteKm` — ui-translation.js line 921.
pub fn haversine_route_km(points: &[crate::UiPoint]) -> f64 {
    points
        .windows(2)
        .map(|pair| haversine_km(&pair[0], &pair[1]))
        .sum()
}

fn is_closed_tour(tour: &crate::PublicTour) -> bool {
    tour.end_node.is_empty()
        || tour.stops.first().map(|s| &s.node_id) == Some(&tour.end_node)
        || tour.stops.iter().any(|s| s.return_to_start)
}

fn coord_of(point: &crate::UiPoint) -> Option<(f64, f64)> {
    match point {
        crate::UiPoint::Coord { lat, lon, .. } if lat.is_finite() && lon.is_finite() => {
            Some((*lat, *lon))
        }
        _ => None,
    }
}

fn points_to_geom(points: &[crate::UiPoint]) -> Vec<[f64; 2]> {
    points
        .iter()
        .filter_map(|point| match point {
            crate::UiPoint::Coord { lat, lon, .. } if lat.is_finite() && lon.is_finite() => {
                Some([*lon, *lat])
            }
            _ => None,
        })
        .collect()
}

fn push_point(points: &mut Vec<crate::UiPoint>, lat: f64, lon: f64) {
    if !lat.is_finite() || !lon.is_finite() {
        return;
    }
    if let Some(crate::UiPoint::Coord {
        lat: pl, lon: pn, ..
    }) = points.last()
    {
        if (pl - lat).abs() < 1e-6 && (pn - lon).abs() < 1e-6 {
            return;
        }
    }
    points.push(crate::UiPoint::Coord {
        lat,
        lon,
        name: None,
    });
}

fn haversine_km(a: &crate::UiPoint, b: &crate::UiPoint) -> f64 {
    let Some((a_lat, a_lon)) = coord_of(a) else {
        return 0.0;
    };
    let Some((b_lat, b_lon)) = coord_of(b) else {
        return 0.0;
    };

    let to_rad = |deg: f64| deg * std::f64::consts::PI / 180.0;
    let d_lat = to_rad(b_lat - a_lat);
    let d_lon = to_rad(b_lon - a_lon);
    let lat1 = to_rad(a_lat);
    let lat2 = to_rad(b_lat);
    let h = (d_lat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (d_lon / 2.0).sin().powi(2);
    12_742.0 * h.sqrt().min(1.0).asin()
}
