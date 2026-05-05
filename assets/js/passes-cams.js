/* ───────────────────────── Curated live webcams ─────────────────────────
   Hand-picked live camera links for select Alpine passes. Keys MUST match
   the exact `n` (name) field in passes-data.js. Each cam is { l, u, s }:
       l — short label shown in the popup
       u — link URL (opens in a new tab)
       s — source attribution shown to the right of the label

   Adding more cams: append a new key here with the exact pass name from
   passes-data.js and a list of cams. No code changes required.

   Auto-added at runtime (see app.js):
   * Any Swiss pass with a `slug` also gets an "alpen-paesse.ch" cams entry.
   * Every pass with at least one cam gets a "more nearby" Windy.com link
     anchored on its lat/lon.
*/
window.PASS_CAMS = {
  "Passo dello Stelvio - Stilfser Joch": [
    { l: "Stilfser Joch panorama",   u: "https://stilfserjoch.panomax.com/", s: "panomax" },
    { l: "Stelvio south approach",   u: "https://stelvio.panomax.com/",      s: "panomax" },
  ],
  "Jouf de Pordoi - Passo Pordoi - Pordoijoch": [
    { l: "Passo Pordoi summit",      u: "https://passo-pordoi.panomax.com/", s: "panomax" },
  ],
  "Reschenpass - Passo Resia": [
    { l: "Reschenpass live",         u: "https://reschen.panomax.com/",      s: "panomax" },
  ],
  "Passo dello Spluga - Splügenpass": [
    { l: "Splügen panorama",         u: "https://splugen.panomax.com/",      s: "panomax" },
  ],
  "Timmelsjoch - Passo Rombo": [
    { l: "Timmelsjoch official cams", u: "https://www.timmelsjoch.com/de/webcams", s: "timmelsjoch.com" },
  ],
  "Hochtor": [
    { l: "Großglockner Hochalpenstraße cams", u: "https://www.grossglockner.at/de/webcams", s: "grossglockner.at" },
  ],
};
