/**
 * Web-Mercator tile math, shared by the browser tile loader and the server one.
 *
 * Pure arithmetic with no I/O, so both sides address exactly the same tiles and
 * sample exactly the same pixel for a given lat/lng. Drift here shows up as a
 * fuel map that disagrees between client and server, which is very hard to spot.
 */
export const lngToTileX = (lng: number, z: number) => ((lng + 180) / 360) * 2 ** z

export const latToTileY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
}

/** Ground resolution of one tile pixel, metres. */
export const metresPerPixel = (lat: number, z: number) =>
  (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z

/** Pick the zoom whose pixels land closest to `targetM` on the ground. */
export function zoomFor(lat: number, targetM: number, min: number, max: number) {
  const z = Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / targetM)
  return Math.max(min, Math.min(max, Math.round(z)))
}

export const TILE_SIZE = 256

/**
 * Terrarium RGB height decode: (R*256 + G + B/256) − 32768 metres.
 * Returns NaN for a transparent pixel — a tile that failed to load would
 * otherwise decode to −32768 m and wreck both hillshade and the elevation ramp.
 */
export function terrariumHeight(r: number, g: number, b: number, a: number): number {
  if (a < 250) return NaN
  const e = r * 256 + g + b / 256 - 32768
  // Deep bathymetry tells us nothing here; everything well below sea level is water.
  return e < -50 ? -50 : e
}
