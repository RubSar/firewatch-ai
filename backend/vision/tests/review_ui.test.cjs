const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../review_ui.js');
const input = {slot: 'A', packet: {packet_id: 'synthetic-test', cases: [{case_id: 'case-001', rgb_sha256: 'a'.repeat(64), dimensions_hw: [5, 5]}]}};
const makeState = () => new Map([['case-001', Object.fromEntries(tools.targets.map(t => [t, tools.emptyLayer([5, 5])]))]]);

test('unannotated layers start unknown and roundtrip without becoming background', () => {
  const state = makeState();
  const exported = tools.exportReview(input, state, 'synthetic-A', false, '2026-09-27T12:00:00Z');
  const restored = tools.importReview(input, exported);
  assert.equal(restored.get('case-001').smoke.mask.filter(x => x === 255).length, 25);
  assert.equal(restored.get('case-001').smoke.reviewed, false);
  assert.deepEqual(exported.records[0].layers.smoke.mask_rle, [[255, 25]]);
});
test('painting changes only the selected native pixels and layer', () => {
  const state = makeState();
  tools.paint(state.get('case-001').visible_flame.mask, [5, 5], 2, 2, 1, 1);
  assert.equal(state.get('case-001').visible_flame.mask.filter(x => x === 1).length, 5);
  assert.equal(state.get('case-001').smoke.mask.filter(x => x === 255).length, 25);
  const mask = state.get('case-001').visible_flame.mask;
  assert.deepEqual(tools.decodeRle(tools.encodeRle(mask), [5, 5]), mask);
});
test('rejects RLE overflow, missing pixels and non-label values before allocation', () => {
  for (const runs of [[], [[0, 24]], [[1, 26]], [[2, 25]], [[true, 25]], [[0, -25]], [[0, 25.5]]]) assert.throws(() => tools.decodeRle(runs, [5, 5]));
  assert.throws(() => tools.decodeRle([[0, 100000000]], [10000, 10000]));
});
test('import rejects the other reviewer, wrong image and silent unknown acceptance', () => {
  const exported = tools.exportReview(input, makeState(), 'synthetic-A', true, '2026-09-27T12:00:00Z');
  for (const mutate of [r => r.reviewer_slot = 'B', r => r.packet_id = 'other', r => r.records[0].rgb_sha256 = 'b'.repeat(64), r => r.records.push(r.records[0]), r => r.records[0].layers.smoke.reviewed = true]) {
    const r = structuredClone(exported); mutate(r); assert.throws(() => tools.importReview(input, r));
  }
});
test('missing cases stay unfinished, and overlapping smoke/flame labels are preserved', () => {
  const state = makeState();
  for (const target of tools.targets) state.get('case-001')[target].mask.fill(1);
  const exported = tools.exportReview(input, state, 'synthetic-A', true, '2026-09-27T12:00:00Z');
  const restored = tools.importReview(input, exported);
  for (const t of tools.targets) assert.equal(restored.get('case-001')[t].mask[0], 1);
  exported.records = [];
  assert.equal(tools.importReview(input, exported).get('case-001').smoke.mask[0], 255);
});
