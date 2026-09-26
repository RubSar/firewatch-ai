import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  investigate,
  requestPayload,
  resultGeometry,
  scoreColor,
} from "./investigation.js";
import { renderOverview, renderEvidence } from "../results.js";
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/examples/fire-investigation-response.live.json",
      import.meta.url,
    ),
  ),
);

test("request sends only the fire geometry with explicit dates and metres", () => {
  const fire = { type: "Feature", geometry: fixture.investigation.fire };
  assert.deepEqual(requestPayload(fire, "2025-07-01", "2025-08-01", "5000"), {
    fire: fixture.investigation.fire,
    start_date: "2025-07-01",
    end_date: "2025-08-01",
    cell_size_m: 5000,
  });
  assert.throws(
    () => requestPayload(fire, "2025-07-01", "2025-09-01", "5000"),
    /1–31/,
  );
});

test("response adapter uses backend ring and areas; null is distinct from zero", () => {
  const geometry = resultGeometry(fixture);
  assert.deepEqual(
    geometry.interest.geometry,
    fixture.investigation.investigation_area,
  );
  assert.equal(
    geometry.areas_km2.interest,
    fixture.investigation.areas_m2.investigation / 1e6,
  );
  assert.notEqual(scoreColor(null), scoreColor(0));
  assert.match(renderOverview(fixture), /111/);
  const unknown = fixture.features.find((f) => f.properties.score === null);
  assert.match(renderEvidence(fixture, unknown), /<dd>Unknown<\/dd>/);
});

test("upstream failures are surfaced, never converted to fabricated scores", async () => {
  const signal = new AbortController().signal;
  const failing = async () => ({
    ok: false,
    status: 429,
    json: async () => ({
      detail: { message: "One satellite analysis is already running" },
    }),
  });
  await assert.rejects(investigate({}, signal, failing), /already running/);
  const bad = async () => ({ ok: true, json: async () => ({}) });
  await assert.rejects(investigate({}, signal, bad), /unsupported response/);
  let sent;
  const good = async (url, options) => {
    sent = { url, options };
    return { ok: true, json: async () => fixture };
  };
  assert.equal(
    await investigate({ fire: fixture.investigation.fire }, signal, good),
    fixture,
  );
  assert.equal(sent.url, "/api/v1/fire-investigation");
  assert.deepEqual(
    JSON.parse(sent.options.body).fire,
    fixture.investigation.fire,
  );
});
