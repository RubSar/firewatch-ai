import { booleanPointInPolygon } from "@turf/turf";
export const IMAGERY =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";
export const SOURCE_URL =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
export function classifyPixel(r, g, b) {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  if (max < 52) return "dark";
  if (g > r * 1.06 && g > b * 1.08 && g - min > 7) return "green";
  if (r > b * 1.22 && g > b * 1.1 && r >= g * 0.97 && max - min > 15)
    return "tan";
  return "other";
}
const mercator = (lon, lat, z) => [
  ((lon + 180) / 360) * 2 ** z,
  ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z,
];
const inverse = (x, y, z) => [
  (x / 2 ** z) * 360 - 180,
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI,
];
function loadImage(url, signal) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      done();
      img.src = "";
      reject(new DOMException("Cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      done();
      img.src = "";
      reject(
        new Error(
          "Imagery timed out. Try a smaller area or check your connection.",
        ),
      );
    }, 15000);
    img.onload = () => {
      done();
      resolve(img);
    };
    img.onerror = () => {
      done();
      reject(
        new Error(
          "Satellite pixels could not be loaded. Check your connection and try again.",
        ),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) return abort();
    img.src = url;
  });
}
export async function analyze(geometry, bufferM, onProgress, signal) {
  const extent = geometry.bounds;
  if (extent[0] < -180 || extent[2] > 180 || extent[1] < -80 || extent[3] > 80)
    throw new Error("Choose an area farther from the coordinate limits.");
  let z = 15,
    a,
    b;
  do {
    a = mercator(extent[0], extent[3], z);
    b = mercator(extent[2], extent[1], z);
    if (
      (Math.floor(b[0]) - Math.floor(a[0]) + 1) *
        (Math.floor(b[1]) - Math.floor(a[1]) + 1) <=
      48
    )
      break;
    z--;
  } while (z >= 0);
  const coords = [];
  for (let y = Math.floor(a[1]); y <= Math.floor(b[1]); y++)
    for (let x = Math.floor(a[0]); x <= Math.floor(b[0]); x++)
      coords.push([x, y]);
  const counts = () => ({ green: 0, tan: 0, dark: 0, other: 0, total: 0 });
  const selected = counts(),
    nearby = counts(),
    grid = [];
  const requests = [];
  let completed = 0;
  for (let start = 0; start < coords.length; start += 4) {
    await Promise.all(
      coords.slice(start, start + 4).map(async ([x, y]) => {
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        const url = `${IMAGERY}/${z}/${y}/${x}`;
        const img = await loadImage(url, signal);
        requests.push(url);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 256;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 256, 256);
        let pixels;
        try {
          pixels = ctx.getImageData(0, 0, 256, 256).data;
        } catch {
          throw new Error(
            "The imagery provider did not allow pixel access. No analysis was produced.",
          );
        }
        for (let row = 0; row < 256; row += 8)
          for (let col = 0; col < 256; col += 8) {
            const [lon, lat] = inverse(
              x + (col + 0.5) / 256,
              y + (row + 0.5) / 256,
              z,
            );
            if (
              lon < extent[0] ||
              lon > extent[2] ||
              lat < extent[1] ||
              lat > extent[3]
            )
              continue;
            const idx = (row * 256 + col) * 4;
            if (pixels[idx + 3] === 0) continue;
            const k = classifyPixel(
              pixels[idx],
              pixels[idx + 1],
              pixels[idx + 2],
            );
            const inside = booleanPointInPolygon([lon, lat], geometry.interest);
            const inFire = booleanPointInPolygon([lon, lat], geometry.fire);
            if (!inside && !inFire) continue;
            const target = inside ? selected : nearby;
            target[k]++;
            target.total++;
            grid.push({
              lat,
              lon,
              category: k,
              zone: inside ? "interest" : "fire",
            });
          }
        onProgress(++completed / coords.length, completed, coords.length);
      }),
    );
  }
  if (!selected.total)
    throw new Error("No valid pixels were found in this selection.");
  const summarize = (c) => ({
    ...c,
    green_pct: c.total ? Math.round((c.green / c.total) * 100) : null,
  });
  return {
    schema_version: "2.0",
    analysis_kind: "rgb_color_screening",
    generated_at: new Date().toISOString(),
    bounds: extent,
    geometry,
    coordinate_system: "EPSG:4326",
    buffer_m: bufferM,
    area_km2: geometry.areas_km2.interest,
    interest: summarize(selected),
    fire: summarize(nearby),
    fuel_index: null,
    moisture: null,
    source: {
      name: "Esri World Imagery",
      url: SOURCE_URL,
      acquired_at: null,
      tile_zoom: z,
      tiles_requested: coords.length,
      tile_urls: requests,
    },
    method: {
      id: "rgb-rules-v1",
      sample_stride_px: 8,
      description:
        "Green chromaticity screening. Color categories are not validated land-cover classifications.",
    },
    limitations: [
      "Acquisition date is unavailable from the basemap tiles.",
      "Dark pixels may include canopy, water, or shadow. Tan pixels may include rock, soil, or vegetation.",
      "RGB imagery cannot establish fuel moisture or dead-tree condition.",
      "Regional spherical 28 km buffer; projection and polygon discretization introduce approximation. Not a fire-spread prediction.",
    ],
    grid,
  };
}
