export function requestPayload(fire, start, end, size) {
  const days = (Date.parse(end) - Date.parse(start)) / 86400000;
  if (!Number.isFinite(days) || days < 1 || days > 31)
    throw new Error(
      "Choose a date window of 1–31 days. The end date is exclusive.",
    );
  if (start < "2017-03-28" || end > new Date().toISOString().slice(0, 10))
    throw new Error("Use dates from 28 March 2017 through today (UTC).");
  return {
    fire: fire.geometry,
    start_date: start,
    end_date: end,
    cell_size_m: Number(size),
  };
}

export async function investigate(payload, signal, fetcher = fetch) {
  let response;
  try {
    response = await fetcher("/api/v1/fire-investigation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(
      "Cannot reach the fuel service. Check that the backend and frontend proxy are running.",
    );
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.detail;
    const message = Array.isArray(detail)
      ? detail.map((d) => d.msg).join("; ")
      : detail?.message;
    throw new Error(
      message ||
        `Fuel service request failed (${response.status}). Check backend availability.`,
    );
  }
  if (
    data?.type !== "FeatureCollection" ||
    !data.investigation ||
    !Array.isArray(data.features) ||
    !data.summary
  )
    throw new Error("The fuel service returned an unsupported response.");
  return data;
}

export function resultGeometry(result) {
  const i = result.investigation;
  const feature = (geometry) => ({ type: "Feature", properties: {}, geometry });
  return {
    fire: feature(i.fire),
    outer: feature(i.wrapper),
    interest: feature(i.investigation_area),
    buffer_m: i.buffer_m,
    method: i.buffer_method,
    areas_km2: {
      fire: i.areas_m2.fire / 1e6,
      outer: i.areas_m2.wrapper / 1e6,
      interest: i.areas_m2.investigation / 1e6,
    },
  };
}

export const escapeHtml = (value) =>
  String(value ?? "Unknown").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const scoreColor = (score) =>
  score == null
    ? "#919ba6"
    : score < 25
      ? "#57a487"
      : score < 50
        ? "#dbbf59"
        : score < 75
          ? "#e48b44"
          : "#c74e49";
export const statusLabel = (value) => String(value).replaceAll("_", " ");
