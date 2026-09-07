import WebSocket from 'ws';
import fs from 'fs';

const APP_ID = 1089;
const SYMBOLS = (process.env.SYMBOLS || '1HZ90V').split(',').map(s => s.trim()).filter(Boolean);
const GRAN_H1 = 3600;
const GRAN_M1 = 60;
const CCI_PERIOD = 14;
const TP_MULTIPLIER = parseFloat(process.env.TP_MULTIPLIER || '2');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = 'state.json';

const DISPLAY_NAMES = {
  'R_10': 'Volatility 10 Index', 'R_25': 'Volatility 25 Index', 'R_50': 'Volatility 50 Index',
  'R_75': 'Volatility 75 Index', 'R_100': 'Volatility 100 Index',
  '1HZ10V': 'Volatility 10 (1s) Index', '1HZ15V': 'Volatility 15 (1s) Index',
  '1HZ25V': 'Volatility 25 (1s) Index', '1HZ30V': 'Volatility 30 (1s) Index',
  '1HZ50V': 'Volatility 50 (1s) Index', '1HZ75V': 'Volatility 75 (1s) Index',
  '1HZ90V': 'Volatility 90 (1s) Index', '1HZ100V': 'Volatility 100 (1s) Index'
};

function loadState(){
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(state){
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function computeCCI(candles, period){
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const tps = slice.map(c => (c.high + c.low + c.close) / 3);
  const sma = tps.reduce((a,b) => a+b, 0) / period;
  const meanDev = tps.reduce((a,b) => a + Math.abs(b - sma), 0) / period;
  if (meanDev === 0) return 0;
  return (tps[tps.length - 1] - sma) / (0.015 * meanDev);
}

function computeATR(candles, period){
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++){
    const c = candles[i], prev = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  return trs.reduce((a,b) => a+b, 0) / period;
}

function cciToValue(cci){
  const clamped = Math.max(-200, Math.min(200, cci));
  return ((clamped + 200) / 400) * 100;
}
function zoneOf(v){ if (v >= 60) return 'BUY'; if (v <= 40) return 'SELL'; return 'NEUTRAL'; }

async function sendTelegram(text){
  if (!TG_TOKEN || !TG_CHAT_ID) { console.warn('Telegram not configured — skipping send'); return; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text })
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram error:', data.description);
    else console.log('Telegram sent:', text.split('\n')[0]);
  } catch (e) { console.error('Telegram send failed:', e.message); }
}

function fetchCandles(ws, symbol, granularity, count){
  return new Promise((resolve, reject) => {
    const reqId = Math.floor(Math.random() * 1e9);
    const timeout = setTimeout(() => { ws.removeListener('message', onMsg); reject(new Error('timeout')); }, 15000);
    const onMsg = (raw) => {
      const data = JSON.parse(raw);
      if (data.req_id !== reqId) return;
      clearTimeout(timeout);
      ws.removeListener('message', onMsg);
      if (data.error) return reject(new Error(data.error.message));
      resolve(data.candles.map(c => ({
        open: parseFloat(c.open), high: parseFloat(c.high),
        low: parseFloat(c.low), close: parseFloat(c.close), epoch: c.epoch
      })));
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({
      ticks_history: symbol, adjust_start_time: 1, count, end: 'latest',
      granularity, style: 'candles', req_id: reqId
    }));
  });
}

async function processSymbol(ws, symbol, state){
  const h1 = await fetchCandles(ws, symbol, GRAN_H1, 200);
  const m1 = await fetchCandles(ws, symbol, GRAN_M1, 200);

  const h1cci = computeCCI(h1, CCI_PERIOD);
  const m1cci = computeCCI(m1, CCI_PERIOD);
  if (h1cci === null || m1cci === null) { console.log(`${symbol}: not enough candle history yet`); return; }

  const h1Zone = zoneOf(cciToValue(h1cci));
  const m1Zone = zoneOf(cciToValue(m1cci));
  const price = m1[m1.length - 1].close;
  const name = DISPLAY_NAMES[symbol] || symbol;

  if (!state[symbol]) state[symbol] = { activeTrade: null };
  const s = state[symbol];

  const aligned = (h1Zone === m1Zone) && h1Zone !== 'NEUTRAL';
  const direction = aligned ? h1Zone : null;

  console.log(`${symbol}: H1=${h1Zone}(${h1cci.toFixed(1)}) M1=${m1Zone}(${m1cci.toFixed(1)}) price=${price} activeTrade=${JSON.stringify(s.activeTrade)}`);

  if (s.activeTrade) {
    const hitTP = s.activeTrade.direction === 'BUY' ? price >= s.activeTrade.tpPrice : price <= s.activeTrade.tpPrice;
    const reversed = aligned && direction !== s.activeTrade.direction;
    if (hitTP) {
      await sendTelegram(`✅ TP HIT — Exit ${s.activeTrade.direction}\n${name}: TP reached at ${price.toFixed(3)}`);
      s.activeTrade = null;
    } else if (reversed) {
      await sendTelegram(`⚠️ Signal reversed — Exit ${s.activeTrade.direction}\n${name}: trend flipped before TP, last ${price.toFixed(3)}`);
      s.activeTrade = null;
    }
    return;
  }

  if (aligned) {
    const atr = computeATR(m1, CCI_PERIOD);
    if (atr) {
      const dist = atr * TP_MULTIPLIER;
      const tp = direction === 'BUY' ? price + dist : price - dist;
      s.activeTrade = { direction, entryPrice: price, tpPrice: tp };
      await sendTelegram(`🎯 SNIPER ENTRY: ${direction}\n${name}: entry ${price.toFixed(3)} · TP ${tp.toFixed(3)} (${TP_MULTIPLIER}× ATR M1)`);
    }
  }
}

async function main(){
  const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  const state = loadState();

  for (const symbol of SYMBOLS) {
    try { await processSymbol(ws, symbol, state); }
    catch (e) { console.error(`Error processing ${symbol}:`, e.message); }
  }

  saveState(state);
  ws.close();
}

main().catch(e => { console.error(e); process.exit(1); });