#!/usr/bin/env node
/* =====================================================================
   大成功率の分析(改善の検討用)
   tests/sim.js と同じゲームのモデルで打ち切り、失敗の内訳を出す。
     ・大成功 / 未到達 / 超過 / 誤差超え(到達して超過も無いが誤差合計が許容を超えた)
     ・誤差合計の分布、誤差0で終わったマス数の分布、マスごとの誤差
     ・各マスの「最後の一打」の分類(狙い打ち系か/会心ターンか/本会心を狙える位置か)
   使い方(リポジトリの直下で):
     node tools/analyze.js --preset bloom --games 2000
     node tools/analyze.js --preset hidane --games 200 --mode mc --log out.jsonl
   オプション:
     --mode greedy|mc   評価関数だけ(速い)か、アプリと同じ先読みか(既定 greedy)
     --seed N           乱数の種(既定 1)。局 g の種は seed と g から決まる
     --params JSON      評価の重みの上書き(素材の params に重ねる)
     --mcs N --mck N    先読みの試行回数・候補数を変える(実験用)
     --log FILE         1局ごとの結果を追記する。同じ FILE で再実行すると、記録済みの局は飛ばす
                        (途中で止まっても続きから再開できる)
     --summary FILE     記録済みの FILE を集計して表示するだけ
   ===================================================================== */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

function args(){
  const o = { preset:'bloom', games:1000, mode:'greedy', seed:1, params:null, mcs:null, mck:null, log:null, summary:null };
  const a = process.argv.slice(2);
  for(let i = 0; i < a.length; i++){
    const k = a[i].replace(/^--/, ''), v = a[++i];
    if(!(k in o)){ console.error('不明な引数: ' + a[i-1]); process.exit(2); }
    o[k] = (k === 'params') ? JSON.parse(v) : (['games','seed','mcs','mck'].includes(k) ? Number(v) : v);
  }
  return o;
}
function seeded(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function loadEngine(o){
  Math.random = seeded(o.seed ^ 99);
  let src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  if(o.mcs || o.mck){
    const re = /const MC_K = \d+, MC_S = \d+/;
    if(!re.test(src)) throw new Error('engine.js に先読みの設定が見つかりません');
    src = src.replace(re, `const MC_K = ${o.mck || 8}, MC_S = ${o.mcs || 640}`);
  }
  vm.runInThisContext(src, { filename: 'engine.js' });
  const E = c => vm.runInThisContext(c);
  if(o.params) E('PRESETS')[o.preset].params = Object.assign({}, E('PRESETS')[o.preset].params || {}, o.params);
  return E;
}

// 1局を打つ。アプリの resetAll と同じ初期化、プレイヤーは毎手候補ボタンで結果を入力する想定
async function playGame(E, o, g){
  const rng = seeded((o.seed * 100003 + g * 7919) | 0);
  const p = E('PRESETS')[o.preset], G = E('G');
  G.preset = o.preset; G.trait = p.trait; G.level = 80; G.hammerId = 'light'; G.star = 3;
  G.masses = p.zones.map(([lo,hi],i) => { const off = !!(p.off && p.off.includes(i));
    return { current:0, zoneLow: off?0:lo, zoneHigh: off?0:hi, off }; });
  E('setActiveMask')(G.masses.map(m => !m.off)); E('applyThreshold')();
  G.temp = 1000; E('litMassIndex = null; simFirstMove = null;');
  G.focus = E('FOCUS_CAP[80] + HAMMERS.light.focusBonus');
  G.rec = null; G.plan = []; G.pending = []; G.hist = []; G.posts = null; G.obs = null;
  const cfg = E('cfgOf')(), P = E('PARAMS');
  const ideal = G.masses.map(m => m.zoneLow + Math.floor(rng() * (m.zoneHigh - m.zoneLow + 1)));
  const fin = [];                     // 各マスの最後の一打の分類
  const modori = [];                  // 起きた戻り
  let moves = 0;
  for(let s = 0; s < 70; s++){
    if(E('boardDone')(G.masses, G.trait) || G.temp <= 0) break;
    // 点灯(威力会心率上昇): 200℃の倍数で未到達マスから1つ(開始直後は特性が乗らない)
    let lit = null;
    if(G.trait === 'kaishin' && !E('isStartState')() && G.temp % 200 === 0){
      const c = G.masses.map((m,i)=>i).filter(i => !G.masses[i].off && G.masses[i].current < G.masses[i].zoneLow);
      if(c.length) lit = c[Math.floor(rng() * c.length)];
    }
    E(`litMassIndex = ${lit === null ? 'null' : lit};`);
    const ms = G.masses.map(m => ({ current:m.current, zoneLow:m.zoneLow, zoneHigh:m.zoneHigh }));
    const mv = o.mode === 'mc' ? await E('stratMCAsync')(ms, G.focus, G.temp, P, cfg, null)
                               : E('stratB')(ms, G.focus, G.temp, P, cfg);
    if(!mv || mv.c > G.focus) break;
    if(mv.sk.key) for(const i of mv.tg){
      const m = G.masses[i]; if(m.current >= m.zoneLow) continue;
      const rolls = E('rollsForMass')(mv.sk, G.temp, G.trait, i), cr = E('critForMass')(mv.sk, cfg, G.temp, i);
      if(!rolls) continue;
      const roll = rolls[Math.floor(rng() * rolls.length)], crit = rng() < cr, before = m.current;
      m.current = crit ? Math.min(before + 2*roll, ideal[i]) : before + roll;
      if(m.current >= m.zoneLow){
        const boost = E('isBoostTurn')(G.temp) || (lit === i);
        const pink = before + rolls[rolls.length-1] <= m.zoneHigh && before + 2*rolls[0] >= m.zoneHigh;
        fin.push({ i, aim: !!mv.sk.crit, boost, pink, exact: m.current === ideal[i] });
      }
      E('updatePost')(i, before, rolls, cr, m.current, crit);
    }
    G.focus -= mv.c; G.temp = mv.nt; G.hist.push(mv.sk.id); moves++;
    const md = E('applyModori')(G.masses, G.temp, G.trait, rng);   // 戻り
    if(md) modori.push(md);
  }
  E('litMassIndex = null;');
  const errs = G.masses.map((m,i) => m.off ? null : E('massError')(m.current, ideal[i], m.zoneLow, m.zoneHigh));
  const reached = G.masses.every(m => m.current >= m.zoneLow);
  const over = G.masses.some(m => m.current > m.zoneHigh);
  const err = errs.reduce((a,e) => a + (e || 0), 0);
  return { g, great: reached && err <= E('SUCCESS_THRESHOLD'), reached, over, err, errs,
           overBy: G.masses.map(m => m.current > m.zoneHigh), focusLeft: G.focus, moves, fin, modori };
}

function summarize(rows, label){
  const n = rows.length; if(!n){ console.log('記録がありません'); return; }
  const pct = x => (x / n * 100).toFixed(1) + '%';
  const great = rows.filter(r => r.great).length, unr = rows.filter(r => !r.reached).length,
        over = rows.filter(r => r.over).length, errFail = rows.filter(r => r.reached && !r.over && !r.great).length;
  // 大成功率の標準誤差(二項分布)
  const p = great / n, se = Math.sqrt(p * (1 - p) / n) * 100;
  console.log(`${label} ${n}局: 大成功 ${pct(great)} (±${se.toFixed(1)}pt) / 未到達 ${pct(unr)} / 超過 ${pct(over)} / 誤差超え ${pct(errFail)}`);
  const hist = {}, exact = {};
  rows.forEach(r => { const k = Math.min(r.err, 12); hist[k] = (hist[k] || 0) + 1;
    const e0 = r.errs.filter(e => e === 0).length; exact[e0] = (exact[e0] || 0) + 1; });
  console.log('  誤差合計の分布(12は12以上):', JSON.stringify(hist));
  console.log('  誤差0のマス数の分布:', JSON.stringify(exact));
  const nm = rows[0].errs.length;
  for(let i = 0; i < nm; i++){
    if(rows[0].errs[i] === null) continue;
    const e = rows.map(r => r.errs[i]);
    console.log(`  マス${i+1}: 平均誤差 ${(e.reduce((a,b)=>a+b,0)/n).toFixed(2)} / 誤差0 ${pct(e.filter(x=>x===0).length)} / 超過 ${pct(rows.filter(r=>r.overBy[i]).length)}`);
  }
  console.log(`  平均残り集中力 ${(rows.reduce((a,r)=>a+r.focusLeft,0)/n).toFixed(1)} / 平均手数 ${(rows.reduce((a,r)=>a+r.moves,0)/n).toFixed(1)}`);
  const md = rows.reduce((a,r)=>a+((r.modori||[]).length),0);
  if(md) console.log(`  戻り ${(md/n).toFixed(2)}回/局`);
  const cls = {};
  // 戻りで未到達に戻ったマスは打ち直すので、マスごとに最後の記録だけを数える
  rows.forEach(r => r.fin.filter((f, k) => !r.fin.slice(k + 1).some(g => g.i === f.i)).forEach(f => {
    const k = (f.aim ? '狙い打ち系' : '通常技') + (f.boost ? '・会心ターン/点灯' : '・他') + (f.pink ? '・本会心圏' : '・圏外');
    const c = cls[k] = cls[k] || { n:0, ex:0 }; c.n++; if(f.exact) c.ex++;
  }));
  for(const [k, c] of Object.entries(cls).sort((a,b) => b[1].n - a[1].n))
    console.log(`  最後の一打 ${k}: ${(c.n/n).toFixed(2)}回/局 誤差0 ${(c.ex/c.n*100).toFixed(0)}%`);
}

(async () => {
  const o = args();
  if(o.summary){
    const rows = fs.readFileSync(o.summary, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    summarize(rows, path.basename(o.summary)); return;
  }
  const E = loadEngine(o);
  const done = new Set(), rows = [];
  if(o.log && fs.existsSync(o.log)){
    for(const l of fs.readFileSync(o.log, 'utf8').split('\n').filter(Boolean)){ const r = JSON.parse(l); done.add(r.g); rows.push(r); }
  }
  for(let g = 0; g < o.games; g++){
    if(done.has(g)) continue;
    const r = await playGame(E, o, g);
    rows.push(r);
    if(o.log) fs.appendFileSync(o.log, JSON.stringify(r) + '\n');
  }
  summarize(rows, `${o.preset} ${o.mode}`);
})().catch(e => { console.error(e); process.exit(1); });
