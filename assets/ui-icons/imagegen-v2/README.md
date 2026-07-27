# Itinera Alpine Contour Enamel icons

This directory contains the generated source artwork for the second-generation
Itinera UI icon system. It replaces the mixed visual language in the original
atlas with one app-specific style across all 63 runtime icons.

## Visual contract

- Thick midnight-navy contour for legibility on dark and light surfaces.
- Snow-white negative-space cuts and a single glacier-cyan navigation accent.
- Lichen green, sunrise amber, coral, and violet appear only when state meaning
  requires them.
- Bold silhouettes, no micro-detail, and consistent optical weight target
  12–24 px rendering.
- A slight hand-cut contour asymmetry makes the system distinctive without
  sacrificing scanability.

## Source layout

Each generated source sheet is a 4×2 contact sheet on a removable magenta
chroma-key background. `source/` preserves the built-in image generator output;
`transparent/` contains the result of the image-generation skill's standard
chroma-key removal workflow.

The exact cell-to-runtime mapping is defined in
`assets/ui-icons/icon-manifest.v2.json`. The eighth cell in the final sheet is a
documented reserve brand mark and is not part of the 63-cell runtime atlas.

## Prompt set

The eight prompts used the `stylized-concept` taxonomy and required the same
Itinera “alpine contour enamel” system:

1. Status, generic POI, access, and summit.
2. Alpine nature, heritage, railway, and bridge.
3. Village, park, wellness, viewpoint, museum, cave, wine, and experience.
4. Pass, funicular, island art, temple, market, district, tower, and onsen.
5. Japan-specific POIs and the three layer modes.
6. Complete weather family.
7. Breaks, parking, warning, external link, and lock.
8. Remaining utility controls and the reserve compass-trail mark.

Every prompt specified a strict 4×2 row-major layout, a flat `#FF00FF`
background, identical optical scale, maximum three colors per glyph, and
recognizability at 12, 16, and 24 px.
