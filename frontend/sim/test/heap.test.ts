/**
 * The heap, against a sorted array. Dijkstra is only correct if this is.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TimeHeap } from '../src/heap.ts'

test('pops in nondecreasing key order, for random input past the growth point', () => {
  // Starts at capacity 16 so the doubling path is exercised many times over.
  const h = new TimeHeap(16)
  let seed = 12345
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const pushed: [number, number][] = []
  for (let i = 0; i < 5000; i++) {
    const k = rnd() * 1000
    h.push(k, i)
    pushed.push([k, i])
  }
  assert.equal(h.size, 5000)
  pushed.sort((a, b) => a[0] - b[0])
  let last = -Infinity
  for (let i = 0; i < 5000; i++) {
    const key = h.peekKey()
    const val = h.pop()
    assert.ok(key >= last, `key went backwards: ${key} after ${last}`)
    assert.equal(val, pushed[i][1], `wrong cell at rank ${i}`)
    last = key
  }
  assert.equal(h.size, 0)
})

test('an empty heap peeks Infinity and pops -1, so callers need no guard', () => {
  const h = new TimeHeap(4)
  assert.equal(h.peekKey(), Infinity)
  assert.equal(h.pop(), -1)
  h.push(5, 7)
  assert.equal(h.pop(), 7)
  assert.equal(h.peekKey(), Infinity)
})

test('duplicate keys and repeated entries for one cell both survive', () => {
  // Lazy deletion means the same cell is pushed several times with better
  // times; every entry must come back out, earliest first.
  const h = new TimeHeap(4)
  for (const k of [9, 3, 3, 7, 1, 3]) h.push(k, 42)
  const out: number[] = []
  while (h.size > 0) { out.push(h.peekKey()); h.pop() }
  assert.deepEqual(out, [1, 3, 3, 3, 7, 9])
})

test('clear empties it without discarding capacity', () => {
  const h = new TimeHeap(8)
  for (let i = 0; i < 100; i++) h.push(i, i)
  const cap = h.keys.length
  h.clear()
  assert.equal(h.size, 0)
  assert.equal(h.peekKey(), Infinity)
  assert.equal(h.keys.length, cap)
})
