# Itinera Alpine Contour Enamel icons

This directory contains the generated source artwork for the second-generation
Itinera UI icon system. It replaces the mixed visual language in the original
atlas with one app-specific style across all 64 runtime icons.

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

Eight generated sources are 4×2 contact sheets on a removable magenta
chroma-key background; the refresh control is a standalone square source.
`source/` preserves the built-in image generator output; `transparent/`
contains the result of the image-generation skill's standard chroma-key
removal workflow.

The exact cell-to-runtime mapping is defined in
`assets/ui-icons/icon-manifest.v2.json`. The eighth cell in the final sheet is a
documented reserve brand mark and is not part of the 64-cell runtime atlas.

## Prompt set

The nine prompts used the `stylized-concept` taxonomy and required the same
Itinera “alpine contour enamel” system:

1. Status, generic POI, access, and summit.
2. Alpine nature, heritage, railway, and bridge.
3. Village, park, wellness, viewpoint, museum, cave, wine, and experience.
4. Pass, funicular, island art, temple, market, district, tower, and onsen.
5. Japan-specific POIs and the three layer modes.
6. Complete weather family.
7. Breaks, parking, warning, external link, and lock.
8. Remaining utility controls and the reserve compass-trail mark.
9. A standalone refresh/reload glyph: two bold circular arrows around a tiny
   alpine notch, using midnight navy, snow white, and glacier cyan.

The sheet prompts specified a strict 4×2 row-major layout. Every prompt used a
flat `#FF00FF` removable background, identical optical scale, a maximum of
three colors per glyph, and recognizability at 12, 16, and 24 px. The refresh
source used the built-in image generator in `stylized-concept` mode and the
same Alpine Contour Enamel production constraints.
