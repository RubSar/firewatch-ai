import test from 'node:test'
import assert from 'node:assert/strict'
import { compare, difference, rank, SPECS, GROUPS, value, eventAvailability, sortByAvailability } from '../src/history/model.ts'

test('perimeter context can be inspected but never ranked as an hourly growth situation', () => {
  const a = interval('a'), b = interval('b')
  b.kind = 'perimeter_snapshot'
  b.growth_ha = null
  b.measurements.forEach(m => { m.support = 'cumulative_perimeter_context' })
  assert.equal(value(b, SPECS[0]), 0)
  assert.equal(compare(a, b, GROUPS).percentage, null)
  assert.equal(compare(b, a, GROUPS).percentage, null)
  assert.equal(compare(b, { ...b, event_id: 'c' }, GROUPS).percentage, null)
})

function interval(event, numbers = {}) {
  const defaults = { ndvi: 0, ndmi: 0, nbr: 0, fuel: { '165': 1 }, slope: 0, wind: 0, temp: 0, rh: 0 }
  const values = { ...defaults, ...numbers }
  return { id: `${event}/hour`, event_id: event, area_ha: 10, growth_ha: 1,
    measurements: SPECS.map(s => ({ field: s.field, source: s.source, support: 'newly_burned',
      value: values[s.key] === null ? null : s.key === 'fuel' ? { class_sample_proportions: values.fuel } : values[s.key] })) }
}
test('zero values are valid and an identical other fire has zero difference', () => {
  assert.equal(compare(interval('a'), interval('b'), GROUPS).percentage, 0)
  assert.equal(value(interval('a'), SPECS[0]), 0)
})
test('known group-weighted distance and wind unit conversion', () => {
  // Vegetation 50%, fuels 50%, terrain 50%, wind 36%, weather (50%+50%)/2.
  const b = interval('b', { ndvi: 1, ndmi: 1, nbr: 1, fuel: { '165': .5, '142': .5 }, slope: 45, wind: 10, temp: 30, rh: 50 })
  assert.equal(value(b, SPECS.find(s => s.key === 'wind')), 36)
  assert.ok(Math.abs(compare(interval('a'), b, GROUPS).percentage - 47.2) < 1e-10)
})
test('missing footprint values cannot be replaced by ignition context', () => {
  const b = interval('b', { ndvi: null })
  b.measurements.push({ field: 'ndvi', source: 'NASA/HLS/', support: 'ignition_point_context', value: 0 })
  assert.equal(compare(interval('a'), b, GROUPS).percentage, null)
  assert.deepEqual(compare(interval('a'), b, GROUPS).missing, ['NDVI'])
  assert.equal(compare(interval('a'), b, GROUPS.filter(g => g !== 'Vegetation')).percentage, 0)
})
test('score is bounded, symmetric and refuses fewer than three groups or same fire', () => {
  const a = interval('a'), b = interval('b', { wind: 1000 })
  assert.equal(difference(a, b, SPECS.find(s => s.key === 'wind')), 1)
  assert.equal(compare(a, b, GROUPS).percentage, compare(b, a, GROUPS).percentage)
  assert.equal(compare(a, b, ['Wind']).percentage, null)
  assert.equal(compare(a, interval('a'), GROUPS).percentage, null)
})
test('rank excludes query fire, returns one per event and ignores observed outcomes', () => {
  const a = interval('a'), b = interval('b'), c = { ...interval('b', { temp: 10 }), id: 'b/later' }
  const events = [{ id: 'a', intervals: [a] }, { id: 'b', intervals: [b, c] }]
  assert.equal(rank(a, events, GROUPS).length, 1)
  assert.equal(rank(a, events, GROUPS)[0].best.interval.id, b.id)
  b.growth_ha = 1e9; b.area_ha = 1e10
  assert.equal(rank(a, events, GROUPS)[0].best.score.percentage, 0)
})

test('completeness prioritizes complete hours over quantity, excludes snapshots and missing values', () => {
  const full = { ...interval('full'), start: '2020-01-01T00:00:00Z', end: '2020-01-01T01:00:00Z' }
  const partial = { ...full, measurements: full.measurements.filter(m => m.field !== 'ndvi') }
  const event = (id, intervals) => ({ id, name: id, year: 2020, intervals })
  const a = event('one-complete', [full])
  const b = event('many-partial', [partial, partial, partial])
  const snapshot = event('snapshot', [{ ...full, kind: 'perimeter_snapshot', start: null, growth_ha: null,
    measurements: full.measurements.map(m => ({ ...m, support: 'cumulative_perimeter_context' })) }])
  assert.equal(eventAvailability(a).completeHours, 1)
  assert.equal(eventAvailability(b).completeHours, 0)
  assert.equal(eventAvailability(snapshot).completeHours, 0)
  assert.equal(eventAvailability(snapshot).coverage, 1)
  assert.deepEqual(sortByAvailability([b, snapshot, a]).map(e => e.id), ['one-complete', 'snapshot', 'many-partial'])
  assert.equal(eventAvailability(event('two-hour', [{ ...full, end: '2020-01-01T02:00:00Z' }])).completeHours, 0)
  assert.equal(eventAvailability(event('unknown-growth', [{ ...full, growth_ha: null }])).completeHours, 0)
})
