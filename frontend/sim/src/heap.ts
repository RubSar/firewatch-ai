/**
 * Binary min-heap over (time, cell), for the minimum-travel-time front.
 *
 * Dijkstra needs the earliest-arriving node next, and a linear scan over a
 * frontier that can hold tens of thousands of cells would dominate the step.
 *
 * LAZY DELETION instead of decrease-key. When a shorter path to a cell is
 * found, its new time is pushed without removing the old entry; the stale entry
 * is recognised on pop because the caller holds the authoritative arrival time
 * and discards any key that no longer matches. This trades some memory for not
 * having to maintain a cell -> heap-position index, which is the usual source of
 * bugs in hand-written Dijkstra.
 *
 * Typed arrays, grown by doubling, so a long run does no per-push allocation.
 */
export class TimeHeap {
  keys: Float64Array
  vals: Int32Array
  size: number

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity)
    this.vals = new Int32Array(capacity)
    this.size = 0
  }

  clear() {
    this.size = 0
  }

  /** Smallest time in the heap. Infinity when empty, so callers need no guard. */
  peekKey(): number {
    return this.size > 0 ? this.keys[0] : Infinity
  }

  push(key: number, val: number) {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2)
      const v = new Int32Array(this.size * 2)
      k.set(this.keys)
      v.set(this.vals)
      this.keys = k
      this.vals = v
    }
    let i = this.size++
    this.keys[i] = key
    this.vals[i] = val
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.keys[p] <= this.keys[i]) break
      this.swap(p, i)
      i = p
    }
  }

  /** Removes and returns the cell with the smallest time. -1 when empty. */
  pop(): number {
    if (this.size === 0) return -1
    const top = this.vals[0]
    this.size--
    if (this.size > 0) {
      this.keys[0] = this.keys[this.size]
      this.vals[0] = this.vals[this.size]
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < this.size && this.keys[l] < this.keys[m]) m = l
        if (r < this.size && this.keys[r] < this.keys[m]) m = r
        if (m === i) break
        this.swap(m, i)
        i = m
      }
    }
    return top
  }

  swap(a: number, b: number) {
    const k = this.keys[a]
    const v = this.vals[a]
    this.keys[a] = this.keys[b]
    this.vals[a] = this.vals[b]
    this.keys[b] = k
    this.vals[b] = v
  }
}
