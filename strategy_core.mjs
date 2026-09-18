// strategy_core.mjs
// This is the single source of truth for the P.A.T. + ICT + Retest detection engine.
// The live dashboard (pat_dashboard.html) currently has its own inline copy of this same
// logic — if you change the strategy here, the dashboard's inline <script> needs the same
// change applied by hand, since it's a standalone static file. They are NOT automatically
// kept in sync.

export function computeStructure(candles, lb, atrForSweep) {
  const n = candles.length;
  if (n < lb * 2 + 3) {
    return { state: 0, barsSinceBos: 999, lastSwingHigh: null, lastSwingLow: null, breakType: null, impulseStart: null, impulseExtreme: null, sweep: false, recentSwingHighs: [], recentSwingLows: [] };
  }

  const swings = [];
  for (let i = lb; i < n - lb; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= lb; k++) {
      if (candles[i].high <= candles[i - k].high || candles[i].high <= candles[i + k].high) isHigh = false;
      if (candles[i].low  >= candles[i - k].low  || candles[i].low  >= candles[i + k].low)  isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swings.push({ confirmedAt: i + lb, type: 'H', price: candles[i].high, idx: i });
    if (isLow)  swings.push({ confirmedAt: i + lb, type: 'L', price: candles[i].low, idx: i });
  }
  swings.sort((a, b) => a.confirmedAt - b.confirmedAt);

  let lastSwingHigh = null, lastSwingLow = null;
  let swingHighsSoFar = [], swingLowsSoFar = [];
  let state = 0, lastBosIndex = -1, breakType = null, impulseStart = null, impulseExtreme = null, sweep = false;
  let ptr = 0;
  const tol = (atrForSweep || 0) * 0.3;

  for (let i = 0; i < n; i++) {
    while (ptr < swings.length && swings[ptr].confirmedAt <= i) {
      const s = swings[ptr];
      if (s.type === 'H') { lastSwingHigh = s.price; swingHighsSoFar.push({ idx: s.idx, price: s.price }); }
      else { lastSwingLow = s.price; swingLowsSoFar.push({ idx: s.idx, price: s.price }); }
      ptr++;
    }
    if (i > 0) {
      const c = candles[i].close;
      const brokeLow = lastSwingLow !== null && c < lastSwingLow;
      const brokeHigh = lastSwingHigh !== null && c > lastSwingHigh;

      if (brokeLow) {
        const oldState = state;
        const brokenLevel = lastSwingLow;
        const priorLow = swingLowsSoFar.length >= 2 ? swingLowsSoFar[swingLowsSoFar.length - 2].price : null;
        sweep = priorLow !== null && Math.abs(brokenLevel - priorLow) <= tol;
        breakType = oldState === -1 ? 'BOS' : 'CHOCH';
        state = -1;
        lastBosIndex = i;
        impulseStart = brokenLevel;
        impulseExtreme = candles[i].low;
        lastSwingLow = null;
      } else if (brokeHigh) {
        const oldState = state;
        const brokenLevel = lastSwingHigh;
        const priorHigh = swingHighsSoFar.length >= 2 ? swingHighsSoFar[swingHighsSoFar.length - 2].price : null;
        sweep = priorHigh !== null && Math.abs(brokenLevel - priorHigh) <= tol;
        breakType = oldState === 1 ? 'BOS' : 'CHOCH';
        state = 1;
        lastBosIndex = i;
        impulseStart = brokenLevel;
        impulseExtreme = candles[i].high;
        lastSwingHigh = null;
      } else if (lastBosIndex !== -1) {
        if (state === 1 && lastSwingHigh === null) impulseExtreme = Math.max(impulseExtreme, candles[i].high);
        else if (state === -1 && lastSwingLow === null) impulseExtreme = Math.min(impulseExtreme, candles[i].low);
      }
    }
  }

  const barsSinceBos = lastBosIndex === -1 ? 999 : (n - 1 - lastBosIndex);
  return {
    state, barsSinceBos, lastSwingHigh, lastSwingLow, breakType, impulseStart, impulseExtreme, sweep,
    recentSwingHighs: swingHighsSoFar.slice(-2),
    recentSwingLows: swingLowsSoFar.slice(-2)
  };
}

export function computeATR(candles, period) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

export function computeOTE(direction, impulseStart, impulseExtreme) {
  if (impulseStart === null || impulseExtreme === null) return null;
  const range = Math.abs(impulseExtreme - impulseStart);
  if (range === 0) return null;
  if (direction === 'BUY') {
    return { low: impulseExtreme - range * 0.79, high: impulseExtreme - range * 0.618 };
  }
  return { low: impulseExtreme + range * 0.618, high: impulseExtreme + range * 0.79 };
}

// Structural stop-loss: just beyond the swing point that broke (the setup's invalidation point),
// with a small buffer so a routine wick back to the exact level doesn't stop it out prematurely.
export function computeSL(direction, impulseStart, atr, bufferMult = 0.2) {
  if (impulseStart === null || atr === null) return null;
  const buffer = atr * bufferMult;
  return direction === 'BUY' ? impulseStart - buffer : impulseStart + buffer;
}

export function projectTrendline(points, atIdx) {
  if (!points || points.length < 2) return null;
  const a = points[points.length - 2], b = points[points.length - 1];
  if (b.idx === a.idx) return null;
  const slope = (b.price - a.price) / (b.idx - a.idx);
  return b.price + slope * (atIdx - b.idx);
}

export function getCandidateZones(direction, m1res, atr, currentIdx) {
  const zones = [];
  const tol = atr * 0.3;
  const ote = computeOTE(direction, m1res.impulseStart, m1res.impulseExtreme);
  if (ote) zones.push({ type: 'OTE', low: ote.low, high: ote.high });
  if (m1res.impulseStart !== null) {
    zones.push({ type: 'Broken level', low: m1res.impulseStart - tol, high: m1res.impulseStart + tol });
  }
  if (direction === 'SELL' && m1res.recentSwingHighs.length >= 2) {
    const proj = projectTrendline(m1res.recentSwingHighs, currentIdx);
    if (proj !== null) zones.push({ type: 'Trendline', low: proj - tol, high: proj + tol });
  }
  if (direction === 'BUY' && m1res.recentSwingLows.length >= 2) {
    const proj = projectTrendline(m1res.recentSwingLows, currentIdx);
    if (proj !== null) zones.push({ type: 'Trendline', low: proj - tol, high: proj + tol });
  }
  return zones;
}

export function isConfirmationCandle(candle, direction, zoneLow, zoneHigh, atr) {
  if (!candle) return false;
  const touchedZone = candle.high >= zoneLow && candle.low <= zoneHigh;
  if (!touchedZone) return false;
  const bodySize = Math.abs(candle.close - candle.open);
  const strongCandle = bodySize >= atr * 0.5;
  if (direction === 'SELL') {
    const wickRejection = candle.high >= zoneLow && candle.close < zoneLow;
    const strongMomentum = strongCandle && candle.close < candle.open && candle.close <= zoneHigh;
    return wickRejection || strongMomentum;
  }
  const wickRejection = candle.low <= zoneHigh && candle.close > zoneHigh;
  const strongMomentum = strongCandle && candle.close > candle.open && candle.close >= zoneLow;
  return wickRejection || strongMomentum;
}

// --- FIX: entry/SL sanity check -------------------------------------------------
// Bug found 2026-09-17 (part 1): isConfirmationCandle's "strong momentum" branch can
// accept an entry as low as zoneLow = impulseStart - atr*0.3 (BUY case; mirrored for
// SELL). computeSL's default buffer (0.2) is smaller than the zone tolerance (0.3),
// so a momentum-candle entry can land BEYOND its own stop-loss — entryPrice already
// on the wrong side of sl the instant the trade opens. A pure sign check (entry vs
// sl) catches that case.
//
// Bug found 2026-09-17 (part 2, after re-running with the part-1 fix live): a sign
// check alone isn't enough. Entries just barely on the CORRECT side of sl (e.g. risk
// of 0.05 points on an instrument trading near 19,000) are just as degenerate — the
// same near-zero-denominator problem, just without crossing to negative. The zone
// tolerance (atr*0.3) and SL buffer (atr*0.2) sit close enough together that entries
// landing in that narrow band produce unrealistically small, unfilled-by-real-slippage
// risk distances. So isValidEntry also requires the risk to clear a minimum fraction
// of ATR — not just a sign check — before a trade is allowed to open.
export function isValidEntry(direction, entryPrice, sl, atr, minRiskAtrFraction = 0.15) {
  if (entryPrice === null || sl === null || !Number.isFinite(entryPrice) || !Number.isFinite(sl)) return false;
  const correctSide = direction === 'BUY' ? entryPrice > sl : entryPrice < sl;
  if (!correctSide) return false;
  if (atr === null || !Number.isFinite(atr) || atr <= 0) return false;
  const risk = Math.abs(entryPrice - sl);
  return risk >= atr * minRiskAtrFraction;
}
// ----------------------------------------------------------------------------------

export function structureToValue(res, decayPerBar) {
  if (!res || res.state === 0) return 50;
  const bars = Math.min(res.barsSinceBos, 100);
  if (res.state === 1) return Math.max(50, 92 - decayPerBar * bars);
  return Math.min(50, 8 + decayPerBar * bars);
}

export function zoneOf(value) {
  if (value >= 60) return 'BUY';
  if (value <= 40) return 'SELL';
  return 'NEUTRAL';
}
