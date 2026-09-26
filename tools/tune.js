#!/usr/bin/env node
/* =====================================================================
   評価の重み(PARAMS)を、ある素材向けに座標探索する(改善の検討用)。
   貪欲エンジン(評価関数だけ)で打ち、全候補を同じ乱数の種で比べる(比較のばらつきを抑えるため)。
   重みを1つずつ 0・半分・1.5倍・2倍・3倍に変え、大成功率が 0.4pt 以上良くなれば採用する。
   探索に使った種に合っただけの「たまたまの改善」もあり得るので、見つけた重みは
   別の種で tools/analyze.js --params ... を使って確かめること。
   使い方(リポジトリの直下で):
     node tools/tune.js --preset hidane --games 3000 --seed 7
     node tools/tune.js --preset hidane --start '{"cap":24}'    途中の結果から再開する
   採用のたびに現在の重みを出力するので、止まった場合はそれを --start に渡せばよい。
   ===================================================================== */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), os = require('os'), { fork } = require('child_process');
const ENGINE = path.join(__dirname, '..', 'engine.js');
function seeded(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ---------- 子プロセス: 渡された重みで games 局打ち、大成功率を返す ---------- */
if(process.argv[2] === '--worker'){
  const q = JSON.parse(process.argv[3]);
  Math.random = seeded(q.seed ^ 99);
  vm.runInThisContext(fs.readFileSync(ENGINE, 'utf8'), { filename: 'engine.js' });
  const E = c => vm.runInThisContext(c);
  const PR = E('PRESETS')[q.preset];
  process.on('message', job => {
    // 重みは素材の params に入れる(applyThreshold が毎局、既定値+素材の params に戻すため)
    PR.params = job.params;
    const rng = seeded(q.seed); let great = 0;
    for(let g = 0; g < q.games; g++){
      const G = E('G');
      G.preset = q.preset; G.trait = PR.trait; G.level = 80; G.hammerId = 'light'; G.star = 3;
      G.masses = PR.zones.map(([lo,hi],i) => { const off = !!(PR.off && PR.off.includes(i)); return { current:0, zoneLow: off?0:lo, zoneHigh: off?0:hi, off }; });
      E('setActiveMask')(G.masses.map(m => !m.off)); E('applyThreshold')();
      G.temp = 1000; E('litMassIndex = null; simFirstMove = null;');
      G.focus = E('FOCUS_CAP[80] + HAMMERS.light.focusBonus');
      G.posts = null; G.hist = [];
      const cfg = E('cfgOf')(), P = E('PARAMS');
      const ideal = G.masses.map(m => m.zoneLow + Math.floor(rng() * (m.zoneHigh - m.zoneLow + 1)));
      for(let s = 0; s < 70; s++){
        if(E('boardDone')(G.masses, G.trait) || G.temp <= 0) break;
        let lit = null;
        if(G.trait === 'kaishin' && !E('isStartState')() && G.temp % 200 === 0){
          const c = G.masses.map((m,i)=>i).filter(i => !G.masses[i].off && G.masses[i].current < G.masses[i].zoneLow);
          if(c.length) lit = c[Math.floor(rng()*c.length)];
        }
        E(`litMassIndex = ${lit === null ? 'null' : lit};`);
        const ms = G.masses.map(m => ({ current:m.current, zoneLow:m.zoneLow, zoneHigh:m.zoneHigh }));
        const mv = E('stratB')(ms, G.focus, G.temp, P, cfg);
        if(!mv || mv.c > G.focus) break;
        const seen = [];
        if(mv.sk.key) for(const i of mv.tg){
          const m = G.masses[i]; if(m.current >= m.zoneLow) continue;
          const rolls = E('rollsForMass')(mv.sk, G.temp, G.trait, i), cr = E('critForMass')(mv.sk, cfg, G.temp, i);
          if(!rolls) continue;
          const roll = rolls[Math.floor(rng()*rolls.length)], crit = rng() < cr, before = m.current;
          m.current = crit ? Math.min(before + 2*roll, ideal[i]) : before + roll;
          seen.push({ i, before, rolls, cr, crit });
        }
        G.focus -= mv.c; G.temp = mv.nt; G.hist.push(1);
        const md = E('applyModori')(G.masses, G.temp, G.trait, rng);   // 戻り
        for(const o of seen) E('updatePost')(o.i, o.before, o.rolls, o.cr, G.masses[o.i].current, o.crit,
                                             md && md.i === o.i ? E('modoriRange')() : undefined);
      }
      E('litMassIndex = null;');
      const reached = G.masses.every(m => m.current >= m.zoneLow);
      let err = 0; G.masses.forEach((m,i) => { err += E('massError')(m.current, ideal[i], m.zoneLow, m.zoneHigh); });
      if(reached && err <= E('SUCCESS_THRESHOLD')) great++;
    }
    process.send({ id: job.id, great: great / q.games });
  });
  return;
}

/* ---------- 親プロセス: 座標探索 ---------- */
const o = { preset:'bloom', games:3000, seed:7, start:null, rounds:2 };
const a = process.argv.slice(2);
for(let i = 0; i < a.length; i++){
  const k = a[i].replace(/^--/, ''), v = a[++i];
  if(!(k in o)){ console.error('不明な引数: ' + a[i-1]); process.exit(2); }
  o[k] = k === 'start' ? JSON.parse(v) : (k === 'preset' ? v : Number(v));
}
vm.runInThisContext(fs.readFileSync(ENGINE, 'utf8'), { filename: 'engine.js' });
const BASE = Object.assign({}, vm.runInThisContext('BASE_PARAMS'));
const presetParams = vm.runInThisContext('PRESETS')[o.preset].params || {};
let cur = o.start || Object.assign({}, presetParams);
const N = os.cpus().length, workers = [], waiting = new Map(); let jid = 0, rr = 0;
for(let k = 0; k < N; k++){
  const w = fork(__filename, ['--worker', JSON.stringify({ preset: o.preset, games: o.games, seed: o.seed })]);
  w.on('message', r => { waiting.get(r.id)(r); waiting.delete(r.id); });
  workers.push(w);
}
const evalP = params => new Promise(res => { const id = ++jid; waiting.set(id, res); workers[rr++ % N].send({ id, params }); });
(async () => {
  let best = await evalP(cur);
  console.log(`開始 大成功 ${(best.great*100).toFixed(2)}%  ${JSON.stringify(cur)}`);
  const keys = Object.keys(BASE).filter(k => typeof BASE[k] === 'number');
  for(let round = 0; round < o.rounds; round++){
    let improved = false;
    for(const k of keys){
      const v0 = cur[k] !== undefined ? cur[k] : BASE[k];
      const cands = [...new Set([0, v0 * 0.5, v0 * 1.5, v0 * 2, v0 * 3].map(x => +x.toFixed(3)))].filter(x => x !== v0);
      const res = await Promise.all(cands.map(x => evalP(Object.assign({}, cur, { [k]: x }))));
      let bi = -1;
      res.forEach((r, i) => { if(r.great > best.great + 0.004 && (bi < 0 || r.great > res[bi].great)) bi = i; });
      if(bi >= 0){
        cur = Object.assign({}, cur, { [k]: cands[bi] }); best = res[bi]; improved = true;
        console.log(`  ${k}: ${v0} → ${cands[bi]}  大成功 ${(best.great*100).toFixed(2)}%  現在 ${JSON.stringify(cur)}`);
      }
    }
    console.log(`第${round+1}巡 終了 大成功 ${(best.great*100).toFixed(2)}%  ${JSON.stringify(cur)}`);
    if(!improved) break;
  }
  workers.forEach(w => w.kill());
})();
