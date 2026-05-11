use leisure_core::{
    infer_intent, tags_from_entity, tags_from_target, IntentEntity, IntentState, IntentTarget,
};
use serde_json::json;

#[test]
fn tags_from_entity_basic_poi_returns_expected_tags() {
    let entity = IntentEntity {
        kind: Some("poi".to_owned()),
        themes: vec!["photogenic".to_owned()],
        categories: vec!["viewpoint".to_owned()],
        ..Default::default()
    };

    let tags = tags_from_entity(&entity);

    assert!(tags.contains(&"poi".to_owned()));
    assert!(tags.contains(&"photogenic".to_owned()));
    assert!(tags.contains(&"viewpoint".to_owned()));
    assert!(tags.contains(&"viewpoints".to_owned()));
}

#[test]
fn tags_from_target_delegates_to_entity_logic() {
    let target = IntentTarget {
        kind: Some("poi".to_owned()),
        themes: vec!["panoramic-view".to_owned()],
        categories: vec!["viewpoint".to_owned()],
        ..Default::default()
    };
    let entity = IntentEntity {
        kind: target.kind.clone(),
        themes: target.themes.clone(),
        categories: target.categories.clone(),
        ..Default::default()
    };

    assert_eq!(tags_from_target(&target), tags_from_entity(&entity));
}

#[test]
fn summit_tag_expands_to_js_intent_classification_tags() {
    let entity = IntentEntity {
        kind: Some("poi".to_owned()),
        themes: vec!["mountain-summit".to_owned()],
        ..Default::default()
    };

    let tags = tags_from_entity(&entity);

    assert!(tags.contains(&"mountain-summit".to_owned()));
    assert!(tags.contains(&"viewpoint".to_owned()));
    assert!(tags.contains(&"panoramic-view".to_owned()));
}

#[test]
fn summit_tag_does_not_create_direct_persona_weight() {
    let intent = infer_intent(IntentState {
        pinned_stops: vec![IntentEntity {
            kind: Some("poi".to_owned()),
            themes: vec!["mountain-summit".to_owned()],
            ..Default::default()
        }],
        ..Default::default()
    });

    assert!(!intent.effective_tag_vector.contains_key("mountain-summit"));
    assert!(intent.effective_tag_vector.contains_key("viewpoint"));
    assert!(intent.effective_tag_vector.contains_key("panoramic-view"));
}

#[test]
fn viewpoint_tag_expands_to_js_intent_classification_tags() {
    let entity = IntentEntity {
        kind: Some("poi".to_owned()),
        categories: vec!["viewpoint".to_owned()],
        ..Default::default()
    };

    let tags = tags_from_entity(&entity);

    assert!(tags.contains(&"viewpoint".to_owned()));
    assert!(tags.contains(&"viewpoints".to_owned()));
}

#[test]
fn poi_with_no_tags_returns_minimal_tag_set() {
    let entity = IntentEntity {
        kind: Some("poi".to_owned()),
        ..Default::default()
    };

    let tags = tags_from_entity(&entity);

    assert_eq!(tags, vec!["poi".to_owned()]);
}

#[test]
fn multi_tag_poi_order_is_deterministic() {
    let entity = IntentEntity {
        kind: Some("poi".to_owned()),
        themes: vec![
            "museum-cultural".to_owned(),
            "viewpoint".to_owned(),
            "alpine-lake".to_owned(),
        ],
        categories: vec!["castle-fortress".to_owned()],
        ..Default::default()
    };

    let first = tags_from_entity(&entity);
    let second = tags_from_entity(&entity);
    let mut sorted = first.clone();
    sorted.sort();

    assert_eq!(first, second);
    assert_eq!(first, sorted);
}

#[test]
fn empty_entity_no_panic() {
    let entity = IntentEntity::default();

    let tags = tags_from_entity(&entity);

    assert!(tags.is_empty());
}

#[test]
fn unexpected_schema_field_is_tolerated() {
    let entity: IntentEntity = serde_json::from_value(json!({
        "kind": "poi",
        "themes": ["food-drink"],
        "futureSchemaField": { "ignored": true }
    }))
    .expect("unknown fields should be ignored");

    let tags = tags_from_entity(&entity);

    assert!(tags.contains(&"food-drink".to_owned()));
    assert!(tags.contains(&"poi".to_owned()));
}
