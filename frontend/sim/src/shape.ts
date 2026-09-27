/**
 * Burn-shape descriptors: how elongated a fire is, and which way it points.
 *
 * Separate from the kernel because these are pure geometry over a mask, shared
 * by the hindcast scorer and the benchmark harness, and — unlike most of what
 * they measure — cheap to test against shapes whose answer is known in advance.
 */
/**
 * Principal-axis length-to-breadth ratio and major-axis bearing of a burn mask.
 *
 * Added to settle where the hindcast's area over-prediction comes from, after
 * a suppression sweep ruled out the last of the obvious causes. The reasoning
 * that motivated it was: the model burns 1.5-2.5x too much area while catching
 * only 66-69% of the real fire, so a third of the truth is somewhere the model
 * never reaches, and an over-elongated wind-driven plume would explain both.
 *
 * That hypothesis was WRONG, which is why this lives here instead of a fix
 * living in the kernel. Two of three replays reproduce the real fire's
 * elongation almost exactly (1.35 vs 1.32, 1.31 vs 1.32). What they get wrong
 * is the BEARING — the major axis lands 59-80 deg off the real one in all
 * three. The error is orientation, not elongation.
 *
 * Second moments of the cell coordinates, eigenvalues of the 2x2 covariance;
 * L/B is the ratio of the ellipse semi-axes, sqrt(l1/l2).
 */
export function lengthToBreadth(mask: Uint8Array, cols: number) {
  let n = 0
  let sx = 0
  let sy = 0
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    n++
    sx += i % cols
    sy += (i / cols) | 0
  }
  if (n < 8) return { lb: 1, bearing: 0 }
  const mx = sx / n
  const my = sy / n
  let vxx = 0
  let vyy = 0
  let vxy = 0
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const dx = (i % cols) - mx
    const dy = ((i / cols) | 0) - my
    vxx += dx * dx
    vyy += dy * dy
    vxy += dx * dy
  }
  vxx /= n; vyy /= n; vxy /= n
  const tr = vxx + vyy
  const det = vxx * vyy - vxy * vxy
  const disc = Math.max(0, (tr * tr) / 4 - det)
  const l1 = tr / 2 + Math.sqrt(disc)
  const l2 = Math.max(1e-9, tr / 2 - Math.sqrt(disc))
  /**
   * Bearing of the major axis, compass degrees, modulo 180 (an axis has no
   * sense of direction).
   *
   * Two traps here, both caught by validating against synthetic ellipses of
   * known orientation rather than by reading the formula. First, the major
   * eigenvector is a vector in (col, row), where row grows SOUTHWARD, so the
   * compass bearing is atan2(east, north) = atan2(dCol, -dRow) — not the math
   * angle atan2(dRow, dCol), which is a different quantity and reads 90 deg
   * off. Second, each of the two closed forms for the eigenvector collapses to
   * (0, 0) for a grid-aligned ellipse, so take whichever is longer.
   */
  const a1 = [l1 - vyy, vxy]
  const a2 = [vxy, l1 - vxx]
  const [dCol, dRow] = Math.hypot(a1[0], a1[1]) >= Math.hypot(a2[0], a2[1]) ? a1 : a2
  const bearing = ((Math.atan2(dCol, -dRow) * 180) / Math.PI + 360) % 180
  return { lb: Math.sqrt(l1 / l2), bearing }
}

/**
 * Anderson (1983) empirical length-to-breadth for a wind-driven fire, from
 * midflame wind in mi/h. An independent target: it says what shape a fire of
 * this windiness should be, without reference to these three perimeters.
 */
export function andersonLB(midflameKmh: number) {
  const mph = midflameKmh * 0.621371
  return 0.936 * Math.exp(0.2566 * mph) + 0.461 * Math.exp(-0.1548 * mph) - 0.397
}

