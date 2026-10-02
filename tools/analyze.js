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
     --mc JSON          先読みの設定の上書き(例: '{"K":16,"gate":0}'。素材の mc に重ねる)
     --tape 1           乱数テープ: ロール・会心などの乱数を「何手目のどのマスか」で決める。打ち方が
                        分かれても同じ局の対応が崩れにくく、2つの設定の比較のばらつきが減る
     --log FILE         1局ごとの結果を追記する。同じ FILE で再実行すると、記録済みの局は飛ばす
                        (途中で止まっても続きから再開できる)
     --summary FILE     記録済みの FILE を集計して表示するだけ
     --hs0 P            必殺(ヘパイトスの炎)が打ち始めにチャージされる確率(既定 0)
     --hsp P            叩く手の後に必殺がチャージされる確率(まだチャージも使用もしていない時。既定 0)
     --hsAt N           N 手目の前に必ずチャージする(既定 -1 = しない)
     --hsNow 1          チャージされたら、すぐに使う(エンジンの判断と比べる用)
     --from N           局 N から打つ(既定 0)。局の結果は seed と局の番号だけで決まるので、
                        --from と --games で範囲を分けて並べて回しても、通しで打った時と同じ局になる
   ===================================================================== */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

function args(){
  const o = { preset:'bloom', games:1000, mode:'greedy', seed:1, params:null, mcs:null, mck:null, mc:null, tape:0, log:null, summary:null, from:0, fork:0, hs0:0, hsp:0, hsAt:-1, hsNow:0 };
  const a = process.argv.slice(2);
  for(let i = 0; i < a.length; i++){
    const k = a[i].replace(/^--/, ''), v = a[++i];
    if(!(k in o)){ console.error('不明な引数: ' + a[i-1]); process.exit(2); }
    o[k] = (k === 'params' || k === 'mc') ? JSON.parse(v) : (['games','seed','mcs','mck','tape','from','fork','hs0','hsp','hsAt','hsNow'].includes(k) ? Number(v) : v);
  }
  return o;
}
function seeded(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function loadEngine(o){
  Math.random = seeded(o.seed ^ 99);
  let src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  vm.runInThisContext(src, { filename: 'engine.js' });
  const E = c => vm.runInThisContext(c);
  E('LDP_CACHE_MAX = LDP_CACHE_TEST_MB * 1048576;');   // 検証では総当たりの表を捨てずに使い回す(速さだけが変わる)
  // 先読みの設定は素材の mc に重ねる(mcConf が読む)
  if(o.mcs || o.mck || o.mc){
    const pr = E('PRESETS')[o.preset];
    pr.mc = Object.assign({}, pr.mc || {}, o.mc || {}, o.mck ? { K: o.mck } : {}, o.mcs ? { S: o.mcs } : {});
  }
  if(o.params) E('PRESETS')[o.preset].params = Object.assign({}, E('PRESETS')[o.preset].params || {}, o.params);
  return E;
}

// 1局を打つ。アプリの resetAll と同じ初期化、プレイヤーは毎手候補ボタンで結果を入力する想定
async function playGame(E, o, g){
  const rng = seeded((o.seed * 100003 + g * 7919) | 0);
  // 乱数テープ: 種類(k)・手番(s)・マス(i)ごとに乱数を先に並べておき、同じ座標なら同じ値を使う
  const tape = {};
  const R = (k, s, i) => { if(!o.tape) return rng();
    const key = k + ':' + s + ':' + i;
    if(!(key in tape)) tape[key] = seeded((o.seed * 100003 + g * 7919) ^ (k.charCodeAt(0) * 1000003 + s * 131 + i * 7))();
    return tape[key]; };
  const p = E('PRESETS')[o.preset], G = E('G');
  G.preset = o.preset; G.trait = p.trait; G.level = 80; G.hammerId = 'light'; G.star = 3;
  G.masses = p.zones.map(([lo,hi],i) => { const off = !!(p.off && p.off.includes(i));
    return { current:0, zoneLow: off?0:lo, zoneHigh: off?0:hi, off }; });
  E('setActiveMask')(G.masses.map(m => !m.off)); E('applyThreshold')();
  G.temp = 1000; E('litMassIndex = null; simFirstMove = null;');
  G.focus = E('FOCUS_CAP[80] + HAMMERS.light.focusBonus');
  G.rec = null; G.plan = []; G.pending = []; G.hist = []; G.posts = null; G.obs = null;
  const cfg = E('cfgOf')(), P = E('PARAMS');
  const ideal = G.masses.map((m, i) => m.zoneLow + Math.floor(R('i', 0, i) * (m.zoneHigh - m.zoneLow + 1)));
  const fin = [];                     // 各マスの最後の一打の分類
  const modori = [];                  // 起きた戻り
  let moves = 0, redoN = 0, forkBase = null, hsUsed = false, hsAt = -1, hsFire = -1, hsZone = -1, hsZoneBad = -1, undoOps = 0;
  if(o.fork) P.er = 0;                // --fork: 全マスがゾーンに入るまでは今の設定で打つ
  E('HS = 0;');
  if(o.hs0 > 0 && R('H', 0, 0) < o.hs0){ E('HS = 1;'); hsAt = 0; }
  for(let s = 0; s < 70; s++){
    if(G.temp <= 0) break;
    if(o.hsAt === s && !hsUsed && E('HS') === 0){ E('HS = 1;'); hsAt = s; }
    // 全マスがゾーンに入った後も、やり直しの見込み(endRedo、戻りの地金・P.er)があれば続ける
    let mvEnd = null;
    if(E('boardDone')(G.masses, G.trait)){
      // --fork: 全マスがゾーンに入った時点の結果を「やり直し無し」として控え、ここからやり直しを入れて続ける
      if(o.fork && !forkBase){ forkBase = result(); P.er = 1; }
      const msE = G.masses.map(m => ({ current:m.current, zoneLow:m.zoneLow, zoneHigh:m.zoneHigh }));
      mvEnd = E('hsEndMove')(msE, G.focus, G.temp, cfg, P);   // 必殺が残っていれば先に使う
      if(!mvEnd){ mvEnd = E('endRedo')(msE, G.focus, G.temp, P, cfg); if(mvEnd) redoN++; }
      if(!mvEnd) break;
    }
    // 点灯(威力会心率上昇): 200℃の倍数で未到達マスから1つ(開始直後は特性が乗らない)
    let lit = null;
    if(G.trait === 'kaishin' && !E('isStartState')() && G.temp % 200 === 0){
      const c = G.masses.map((m,i)=>i).filter(i => !G.masses[i].off && G.masses[i].current < G.masses[i].zoneLow);
      if(c.length) lit = c[Math.floor(R('l', s, 0) * c.length)];
    }
    E(`litMassIndex = ${lit === null ? 'null' : lit};`);
    const ms = G.masses.map(m => ({ current:m.current, zoneLow:m.zoneLow, zoneHigh:m.zoneHigh }));
    E(`PREV_SK = ${G.hist.length ? JSON.stringify(G.hist[G.hist.length - 1]) : 'null'};`);
    const hsN = o.hsNow && E('HS') === 1 ? E('hsMove')(G.temp) : null;   // --hsNow: チャージされたらすぐ使う
    const mv = mvEnd ? mvEnd : hsN ? hsN : o.mode === 'mc' ? await E('stratMCAsync')(ms, G.focus, G.temp, P, cfg, null)
                               : E('stratB')(ms, G.focus, G.temp, P, cfg);
    if(!mv || mv.c > G.focus) break;
    const seen = [];                    // この手で打ったマス(理想値の推定は戻りの後にまとめて更新)
    // みだれ打ちは使うマスからランダムに4回(同じマスに重なることもある)。ゾーン内のマスにも当たる
    const hits = mv.sk.random ? [0,1,2,3].map(h => ({ i: mv.tg[Math.floor(R('h', s, h) * mv.tg.length)], k: 100 + h }))
                              : mv.tg.map(i => ({ i, k: i }));
    if(mv.sk.key) for(const { i, k } of hits){
      // やり直しの手・必殺の効果中の手はゾーン内も打つ
      const m = G.masses[i]; if(m.current >= m.zoneLow && !mv.redo && !mv.sk.random && E('HS') !== 2) continue;
      const rolls = E('rollsForMass')(mv.sk, G.temp, G.trait, i), cr = E('critForMass')(mv.sk, cfg, G.temp, i);
      if(!rolls) continue;
      const roll = rolls[Math.floor(R('r', s, k) * rolls.length)], crit = R('c', s, k) < cr, before = m.current;
      // 会心は理想値を通り越す時だけ理想値で止まる。既に理想値以上なら動かない(ゲームでは miss と出る)
      m.current = crit ? (before < ideal[i] ? Math.min(before + 2*roll, ideal[i]) : before) : before + roll;
      if(m.current >= m.zoneLow){
        const boost = E('isBoostTurn')(G.temp) || (lit === i);
        const pink = before + rolls[rolls.length-1] <= m.zoneHigh && before + 2*rolls[0] >= m.zoneHigh;
        fin.push({ i, aim: !!mv.sk.crit, boost, pink, exact: m.current === ideal[i] });
      }
      // みだれ打ちは画面で打つ前と後の値だけを入れるので、理想値の推定には使わない
      if(!mv.sk.random) seen.push({ i, before, rolls, cr, crit });
    }
    // 必殺: 使うと効果中、叩くと効果が消える。叩いた後、まだなら確率でチャージする
    if(mv.sk.hs){ E('HS = 2;'); hsUsed = true; hsFire = s; hsZone = G.masses.filter(m => !m.off && m.current >= m.zoneLow).length; hsZoneBad = G.masses.filter((m, j) => !m.off && m.current >= m.zoneLow && m.current !== ideal[j]).length; }
    else if(E('HS') === 2 && mv.sk.key) E('HS = 0;');
    else if(mv.sk.key && !hsUsed && E('HS') === 0 && o.hsp > 0 && R('H', s, 1) < o.hsp){ E('HS = 1;'); hsAt = s + 1; }
    const prevId = G.hist.length ? G.hist[G.hist.length - 1] : null;
    if((prevId === 'karyoku' && mv.sk.id === 'hiyashikomi') || (prevId === 'hiyashikomi' && mv.sk.id === 'karyoku')) undoOps++;
    G.focus -= mv.c; G.temp = mv.nt; G.hist.push(mv.sk.id); moves++;
    const md = E('applyModori')(G.masses, G.temp, G.trait, () => R('m', s, 0));   // 戻り
    if(md) modori.push(md);
    // 画面では戻りの後の値を入れるので、戻ったマスはそのように扱う
    for(const o of seen) E('updatePost')(o.i, o.before, o.rolls, o.cr, G.masses[o.i].current, o.crit,
                                         md && md.i === o.i ? E('modoriRange')() : undefined);
  }
  E('litMassIndex = null;');
  const res = result();
  if(o.fork){ res.base = forkBase || { great: res.great, err: res.err, reached: res.reached, over: res.over }; P.er = 0; }
  return res;
  function result(){
  const errs = G.masses.map((m,i) => m.off ? null : E('massError')(m.current, ideal[i], m.zoneLow, m.zoneHigh));
  const reached = G.masses.every(m => m.current >= m.zoneLow);
  const over = G.masses.some(m => m.current > m.zoneHigh);
  const err = errs.reduce((a,e) => a + (e || 0), 0);
  return { g, great: reached && err <= E('SUCCESS_THRESHOLD'), reached, over, err, errs,
           overBy: G.masses.map(m => m.current > m.zoneHigh), focusLeft: G.focus, moves, fin: fin.slice(), modori: modori.slice(), redoN, hsAt, hsFire, hsZone, hsZoneBad, undoOps };
  }
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
  const hsC = rows.filter(r => r.hsAt >= 0), hsF = rows.filter(r => r.hsFire >= 0);
  if(hsC.length) console.log(`  必殺: チャージ ${hsC.length}局 / 使用 ${hsF.length}局(使った手番の平均 ${(hsF.reduce((a,r)=>a+r.hsFire,0)/Math.max(1,hsF.length)).toFixed(1)})`
    + ` / チャージした局の大成功 ${(hsC.filter(r=>r.great).length/hsC.length*100).toFixed(1)}%`);
  const uo = rows.filter(r => r.undoOps > 0).length;
  if(uo) console.log(`  火力上げと冷やし込みを続けて打った局 ${uo}局(${(uo/n*100).toFixed(1)}%)`);
  const rdn = rows.reduce((a, r) => a + (r.redoN || 0), 0);
  if(rdn) console.log(`  仕上げのやり直し ${(rdn/n).toFixed(2)}回/局`);
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
  for(let g = o.from; g < o.games; g++){
    if(done.has(g)) continue;
    const r = await playGame(E, o, g);
    rows.push(r);
    if(o.log) fs.appendFileSync(o.log, JSON.stringify(r) + '\n');
  }
  summarize(rows, `${o.preset} ${o.mode}`);
})().catch(e => { console.error(e); process.exit(1); });
