// Usage: node backtest.mjs
// Config via env vars (all optional, shown with defaults):
//   SYMBOL=1HZ90V  LOOKBACK=5  TP_STEP=1  ATR_PERIOD=14
//   HISTORY_DAYS=30   (how far back to fetch M1 data)
//   H1_DECAY=1.5  M1_DECAY=4.5  (unused by the trade logic itself, kept for parity)
//
// Output: prints a summary to the console and writes backtest_results.json + backtest_trades.csv

import WebSocket from 'ws';
import fs from 'fs';
import {
  computeStructure, computeATR, getCandidateZones, isConfirmationCandle
} from './strategy_core.mjs';

const APP_ID = 1089;
const SYMBOL = process.env.SYMBOL || '1HZ90V';
const LOOKBACK = parseInt(process.env.LOOKBACK || '5', 10);
const TP_STEP = parseFloat(process.env.TP_STEP || '1');
const ATR_PERIOD = parseInt(process.env.ATR_PERIOD || '14', 10);
const HISTORY_DAYS = parseFloat(process.env.HISTORY_DAYS || '30');
const GRAN_M1 = 60;
const GRAN_H1 = 3600;
const WINDOW = 250; // rolling window fed into computeStructure each step, matches live dashboard's practical scale

function call(ws, request) {
  return new Promise((resolve, reject) => {
    const reqId = Math.floor(Math.random() * 1e9);
    const timeout = setTimeout(() => { ws.removeListener('message', onMsg); reject(new Error('timeout')); }, 20000);
    const onMsg = (raw) => {
      const data = JSON.parse(raw);
      if (data.req_id !== reqId) return;
      clearTimeout(timeout);
      ws.removeListener('message', onMsg);
      if (data.error) return reject(new Error(data.error.message));
      resolve(data);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ ...request, req_id: reqId }));
  });
}

function mapCandles(raw) {
  return raw.map(c => ({
    open: parseFloat(c.open), high: parseFloat(c.high),
    low: parseFloat(c.low), close: parseFloat(c.close), epoch: c.epoch
  }));
}

async function fetchHistory(ws, symbol, granularity, totalNeeded) {
  let all = [];
  let end = 'latest';
  let lastOldestEpoch = null;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  while (all.length < totalNeeded) {
    const count = Math.min(5000, totalNeeded - all.length + 5);
    const data = await call(ws, {
      ticks_history: symbol, count, end,
      granularity, style: 'candles'
    });
    const batch = mapCandles(data.candles);
    if (!batch.length) break;

    const oldestEpoch = batch[0].epoch;
    const newestEpoch = batch[batch.length - 1].epoch;
    if (lastOldestEpoch !== null && oldestEpoch >= lastOldestEpoch) {
      console.warn(`  WARNING: pagination stuck (no older data returned, still at epoch ${oldestEpoch}). Stopping early with ${all.length} candles instead of the requested ${totalNeeded}.`);
      break;
    }
    lastOldestEpoch = oldestEpoch;

    // Keep only previously-fetched candles that are strictly newer than this batch's newest point,
    // to avoid duplication at the boundary, then prepend this (older) batch.
    all = batch.concat(all.filter(c => c.epoch > newestEpoch));
    end = oldestEpoch - granularity;
    console.log(`  fetched ${batch.length} candles (oldest: ${new Date(oldestEpoch * 1000).toISOString()}), total so far: ${all.length}`);
    if (batch.length < count) break; // hit the beginning of available history
    await sleep(400); // be polite to the shared demo app_id
  }
  return all;
}

function pctDiff(a, b) { return b === 0 ? 0 : (a - b) / b; }

async function main() {
  console.log(`Backtesting ${SYMBOL} — lookback=${LOOKBACK}, tpStep=${TP_STEP}, history=${HISTORY_DAYS} days\n`);

  const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

  const m1Needed = Math.ceil(HISTORY_DAYS * 24 * 60);
  const h1Needed = Math.ceil(HISTORY_DAYS * 24) + WINDOW;

  console.log('Fetching M1 history...');
  const m1All = await fetchHistory(ws, SYMBOL, GRAN_M1, m1Needed);
  console.log(`Got ${m1All.length} M1 candles.\n`);

  console.log('Fetching H1 history...');
  const h1All = await fetchHistory(ws, SYMBOL, GRAN_H1, h1Needed);
  console.log(`Got ${h1All.length} H1 candles.\n`);

  ws.close();

  if (m1All.length < WINDOW * 2 || h1All.length < WINDOW * 2) {
    console.error('Not enough historical data returned to run a meaningful backtest.');
    process.exit(1);
  }

  // --- Precompute H1 zone at every point in time (no lookahead: only uses H1 bars closed so far) ---
  function h1ZoneAt(epoch) {
    // Find index of the latest H1 candle whose epoch <= given epoch
    let lo = 0, hi = h1All.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (h1All[mid].epoch <= epoch) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx < WINDOW) return 'NEUTRAL';
    const windowSlice = h1All.slice(Math.max(0, idx - WINDOW), idx + 1);
    const res = computeStructure(windowSlice, LOOKBACK);
    if (windowSlice.length < LOOKBACK * 2 + 3) return 'NEUTRAL';
    const value = res.state === 0 ? 50 : res.state === 1 ? Math.max(50, 92 - 1.5 * Math.min(res.barsSinceBos, 100)) : Math.min(50, 8 + 1.5 * Math.min(res.barsSinceBos, 100));
    if (value >= 60) return 'BUY';
    if (value <= 40) return 'SELL';
    return 'NEUTRAL';
  }

  // --- Walk forward through M1 bars, replaying the exact live decision logic ---
  const trades = [];
  let activeTrade = null;
  let pendingSetup = null;
  let lastH1Epoch = -1;
  let cachedH1Zone = 'NEUTRAL';

  // Diagnostics: track exactly where the funnel bottlenecks
  const diag = {
    barsProcessed: 0,
    h1BuyBars: 0, h1SellBars: 0, h1NeutralBars: 0,
    freshM1Breaks: 0, freshBreaksMatchingH1: 0,
    pendingBarsTotal: 0, zonesComputedCount: 0, confirmationChecks: 0,
    maxPendingStreak: 0
  };
  let currentPendingStreak = 0;

  for (let i = WINDOW; i < m1All.length; i++) {
    const windowSlice = m1All.slice(i - WINDOW, i + 1);
    const currentEpoch = m1All[i].epoch;
    const currentH1Epoch = Math.floor(currentEpoch / GRAN_H1) * GRAN_H1;
    if (currentH1Epoch !== lastH1Epoch) {
      cachedH1Zone = h1ZoneAt(currentEpoch);
      lastH1Epoch = currentH1Epoch;
    }
    const h1Zone = cachedH1Zone;
    diag.barsProcessed++;
    if (h1Zone === 'BUY') diag.h1BuyBars++;
    else if (h1Zone === 'SELL') diag.h1SellBars++;
    else diag.h1NeutralBars++;

    const atr = computeATR(windowSlice, ATR_PERIOD);
    const m1res = computeStructure(windowSlice, LOOKBACK, atr);
    const price = windowSlice[windowSlice.length - 1].close;
    const localIdx = windowSlice.length - 1;

    // --- Manage an open trade ---
    if (activeTrade) {
      const m1Direction = m1res.state === 1 ? 'BUY' : m1res.state === -1 ? 'SELL' : null;
      const aligned = h1Zone !== 'NEUTRAL' && m1Direction === h1Zone;
      const reversed = aligned && m1Direction !== activeTrade.direction;
      const favorable = (t) => activeTrade.direction === 'BUY' ? price >= t : price <= t;

      if (!activeTrade.hit1 && favorable(activeTrade.tp1)) activeTrade.hit1 = true;
      if (!activeTrade.hit2 && favorable(activeTrade.tp2)) activeTrade.hit2 = true;
      if (!activeTrade.hit3 && favorable(activeTrade.tp3)) {
        activeTrade.hit3 = true;
        activeTrade.exit = 'TP3';
        activeTrade.exitPrice = price;
        activeTrade.exitEpoch = currentEpoch;
        trades.push(activeTrade);
        activeTrade = null;
        continue;
      }
      if (reversed) {
        activeTrade.exit = 'REVERSED';
        activeTrade.exitPrice = price;
        activeTrade.exitEpoch = currentEpoch;
        trades.push(activeTrade);
        activeTrade = null;
      }
      continue;
    }

    // --- Manage pending setup ---
    const isFreshBreak = m1res.barsSinceBos === 0 && m1res.breakType !== null;
    const m1Direction = m1res.state === 1 ? 'BUY' : m1res.state === -1 ? 'SELL' : null;

    if (isFreshBreak) diag.freshM1Breaks++;

    if (isFreshBreak && m1Direction && h1Zone === m1Direction) {
      diag.freshBreaksMatchingH1++;
      pendingSetup = { direction: m1Direction, breakType: m1res.breakType, sweep: m1res.sweep };
    } else if (pendingSetup) {
      if (h1Zone !== pendingSetup.direction) pendingSetup = null;
      else if (m1Direction && m1Direction !== pendingSetup.direction) pendingSetup = null;
    }

    if (pendingSetup) {
      diag.pendingBarsTotal++;
      currentPendingStreak++;
      diag.maxPendingStreak = Math.max(diag.maxPendingStreak, currentPendingStreak);
    } else {
      currentPendingStreak = 0;
    }

    if (pendingSetup && atr) {
      const closedCandle = windowSlice.length >= 2 ? windowSlice[windowSlice.length - 2] : null;
      const zones = getCandidateZones(pendingSetup.direction, m1res, atr, localIdx);
      diag.zonesComputedCount += zones.length;
      let triggeredZone = null;
      for (const z of zones) {
        diag.confirmationChecks++;
        if (isConfirmationCandle(closedCandle, pendingSetup.direction, z.low, z.high, atr)) { triggeredZone = z; break; }
      }
      if (triggeredZone) {
        const dir = pendingSetup.direction;
        const step = atr * TP_STEP;
        const sign = dir === 'BUY' ? 1 : -1;
        const entryPrice = closedCandle.close;
        activeTrade = {
          direction: dir, entryPrice, entryEpoch: currentEpoch,
          zoneType: triggeredZone.type, breakType: pendingSetup.breakType, sweep: pendingSetup.sweep,
          tp1: entryPrice + sign * step, tp2: entryPrice + sign * 2 * step, tp3: entryPrice + sign * 3 * step,
          hit1: false, hit2: false, hit3: false
        };
        pendingSetup = null;
      }
    }
  }

  console.log('\n========== FUNNEL DIAGNOSTICS ==========');
  console.log(`M1 bars processed: ${diag.barsProcessed}`);
  console.log(`H1 zone distribution: BUY=${diag.h1BuyBars} (${(diag.h1BuyBars/diag.barsProcessed*100).toFixed(1)}%)  SELL=${diag.h1SellBars} (${(diag.h1SellBars/diag.barsProcessed*100).toFixed(1)}%)  NEUTRAL=${diag.h1NeutralBars} (${(diag.h1NeutralBars/diag.barsProcessed*100).toFixed(1)}%)`);
  console.log(`Fresh M1 breaks (any direction): ${diag.freshM1Breaks}`);
  console.log(`Fresh M1 breaks matching H1 direction (setups armed): ${diag.freshBreaksMatchingH1}`);
  console.log(`Total bars spent in an armed/pending state: ${diag.pendingBarsTotal}`);
  console.log(`Longest single armed streak: ${diag.maxPendingStreak} bars`);
  console.log(`Retest zones computed while armed: ${diag.zonesComputedCount}`);
  console.log(`Confirmation-candle checks performed: ${diag.confirmationChecks}`);
  console.log(`Signals actually triggered: ${trades.length}`);
  console.log('==========================================\n');

  // If a trade was still open at the end of the data, close it out at last known price for scoring purposes.
  if (activeTrade) {
    const lastPrice = m1All[m1All.length - 1].close;
    activeTrade.exit = 'END_OF_DATA';
    activeTrade.exitPrice = lastPrice;
    activeTrade.exitEpoch = m1All[m1All.length - 1].epoch;
    trades.push(activeTrade);
  }

  // --- Score results ---
  function rMultiple(t) {
    const risk = Math.abs(t.tp1 - t.entryPrice); // 1x ATR step used as the risk unit
    if (risk === 0) return 0;
    const gain = t.direction === 'BUY' ? (t.exitPrice - t.entryPrice) : (t.entryPrice - t.exitPrice);
    return gain / risk;
  }

  const scored = trades.map(t => ({ ...t, r: rMultiple(t), riskUnit: Math.abs(t.tp1 - t.entryPrice) }));
  const wins = scored.filter(t => t.hit1);
  const total = scored.length;
  const winRate = total ? (wins.length / total * 100) : 0;
  const avgR = total ? (scored.reduce((a, t) => a + t.r, 0) / total) : 0;

  const sortedByR = [...scored].sort((a, b) => a.r - b.r);
  const medianR = total ? (total % 2 === 1 ? sortedByR[(total - 1) / 2].r : (sortedByR[total / 2 - 1].r + sortedByR[total / 2].r) / 2) : 0;
  const worstTrades = sortedByR.slice(0, 5);
  const bestTrades = sortedByR.slice(-5).reverse();
  const sortedByRisk = [...scored].sort((a, b) => a.riskUnit - b.riskUnit);
  const tiniestRiskTrades = sortedByRisk.slice(0, 5);

  function breakdown(key) {
    const groups = {};
    for (const t of scored) {
      const k = t[key];
      if (!groups[k]) groups[k] = [];
      groups[k].push(t);
    }
    return Object.entries(groups).map(([k, arr]) => ({
      [key]: k,
      count: arr.length,
      winRate: (arr.filter(t => t.hit1).length / arr.length * 100).toFixed(1) + '%',
      avgR: (arr.reduce((a, t) => a + t.r, 0) / arr.length).toFixed(2)
    }));
  }

  console.log('\n========== BACKTEST RESULTS ==========');
  console.log(`Symbol: ${SYMBOL} | Period: ~${HISTORY_DAYS} days | M1 bars analyzed: ${m1All.length}`);
  console.log(`Total signals fired: ${total}`);
  console.log(`Win rate (TP1 reached): ${winRate.toFixed(1)}%`);
  console.log(`Average R multiple: ${avgR.toFixed(2)}   Median R multiple: ${medianR.toFixed(2)}`);
  console.log(`TP2 reached: ${scored.filter(t=>t.hit2).length}/${total}  TP3 reached: ${scored.filter(t=>t.hit3).length}/${total}`);
  console.log(`Reversed before TP3: ${scored.filter(t=>t.exit==='REVERSED').length}/${total}`);

  console.log('\n-- Worst 5 trades by R (likely to reveal outlier bugs) --');
  console.table(worstTrades.map(t => ({ direction: t.direction, zoneType: t.zoneType, entryPrice: t.entryPrice.toFixed(4), riskUnit: t.riskUnit.toFixed(6), exit: t.exit, exitPrice: t.exitPrice.toFixed(4), r: t.r.toFixed(2) })));
  console.log('-- Best 5 trades by R --');
  console.table(bestTrades.map(t => ({ direction: t.direction, zoneType: t.zoneType, entryPrice: t.entryPrice.toFixed(4), riskUnit: t.riskUnit.toFixed(6), exit: t.exit, exitPrice: t.exitPrice.toFixed(4), r: t.r.toFixed(2) })));
  console.log('-- 5 smallest risk units (most likely to produce distorted R if near zero) --');
  console.table(tiniestRiskTrades.map(t => ({ direction: t.direction, zoneType: t.zoneType, entryPrice: t.entryPrice.toFixed(4), riskUnit: t.riskUnit.toFixed(6), r: t.r.toFixed(2) })));

  console.log('\n-- By zone type --');
  console.table(breakdown('zoneType'));
  console.log('-- By break type --');
  console.table(breakdown('breakType'));
  console.log('-- By liquidity sweep --');
  console.table(breakdown('sweep'));

  fs.writeFileSync('backtest_results.json', JSON.stringify({
    symbol: SYMBOL, historyDays: HISTORY_DAYS, lookback: LOOKBACK, tpStep: TP_STEP,
    totalSignals: total, winRate, avgR, medianR,
    byZoneType: breakdown('zoneType'), byBreakType: breakdown('breakType'), bySweep: breakdown('sweep')
  }, null, 2));

  const csvHeader = 'entryEpoch,direction,zoneType,breakType,sweep,entryPrice,exit,exitPrice,hit1,hit2,hit3,r\n';
  const csvRows = scored.map(t =>
    `${t.entryEpoch},${t.direction},${t.zoneType},${t.breakType},${t.sweep},${t.entryPrice.toFixed(4)},${t.exit},${t.exitPrice.toFixed(4)},${t.hit1},${t.hit2},${t.hit3},${t.r.toFixed(3)}`
  ).join('\n');
  fs.writeFileSync('backtest_trades.csv', csvHeader + csvRows);

  console.log('\nWrote backtest_results.json and backtest_trades.csv');
}

main().catch(e => { console.error(e); process.exit(1); });
