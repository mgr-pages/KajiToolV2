#!/usr/bin/env node
/* =====================================================================
   計算エンジンの成績テスト
   engine.js を Node に読み込み、各素材を乱数の種を固定して最後まで打ち切り、
   大成功率・失敗の内訳を出す。種が固定なので、エンジンを変えていなければ
   何度実行しても同じ結果になる。

   使い方(リポジトリの直下で):
     node tests/sim.js            基準(tests/baseline.json)と照合する。違えば終了コード1
     node tests/sim.js --update   今の結果で基準を書き換える(エンジンを意図して変えた時)
     node tests/sim.js --games 2000 --mc 10 --preset kagayaki,hidane
                                  局数・素材を変えて成績だけを見る(基準とは照合しない)

   2つの打ち方を測る。
     貪欲   : 評価関数(stratB)だけで選ぶ。1局0.05秒程度なので局数を多くできる。
     先読み : アプリと同じく stratMCAsync で選ぶ。1局に数十秒かかる。

   ゲームのモデル(エンジン内部の試行と同じ前提):
     ・理想値はゾーン内の一様乱数。ロールは7通りから等確率。
     ・会心は会心率で発生し、理想値を通り越す場合は理想値で止まる。
     ・威力会心率上昇の点灯は、200℃の倍数ごとに未到達マスから無作為に1つ。
   プレイヤーのモデル:
     ・毎手、候補ボタンで結果を入力する(会心の有無も伝わる)。
     ・装備は 職人Lv80 / 光のハンマー★3(アプリの初期値)。

   実装メモ: engine.js はブラウザと同じく通常のスクリプトとして読み込む
   (vm.runInThisContext)。vm.createContext の隔離環境ではグローバル変数の参照が
   極端に遅くなり、先読みが実用的な時間で終わらなかった。読み込みは1プロセス
   1回に限られるので、素材×打ち方ごとに子プロセスを立て、並列に走らせる。
   ===================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { fork } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(__dirname, 'baseline.json');
// 基準の条件。変えると基準と比べられなくなるので、変えたら --update する。
const DEFAULT = { games: 300, mc: 2, presets: ['kagayaki', 'amatsuyu', 'hidane', 'bloom'], seed: 20260926 };
const NAMES = { kagayaki: '超かがやきの樹液', amatsuyu: '超あまつゆのいと', hidane: '超ようせいのひだね', bloom: 'ブルームシールド' };

// 32bit FNV-1a。全対局の手順から作る指紋。エンジンの挙動が1手でも変われば値が変わる。
function fnv(s, h){
  h = (h === undefined ? 2166136261 : h) >>> 0;
  for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
// engine.js の mcRand と同じ式。エンジンを読み込む前に Math.random を差し替えるために持つ。
function seeded(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ===================== 子プロセス側 ===================== */
function workerMain(task){
  // エンジンのどこかで素の乱数が使われても結果が揺れないよう、読み込み前に種を固定する
  Math.random = seeded(task.seed ^ 0x2545f491);
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8'), { filename: 'engine.js' });
  const E = code => vm.runInThisContext(code);
  if(task.kind === 'power') return checkPowerTable(E);
  return runGames(E, task);
}

// 威力の計算式(getRollCandidates)と実測表の照合
function checkPowerTable(E){
  const { TEMP_POINTS, POWER_TABLE } = require('./power-table.js');
  const out = { points: 0, mismatches: [] };
  for(const key of Object.keys(POWER_TABLE)){
    const sk = E(`SKILLS.find(s => s.key === ${JSON.stringify(key)})`);
    TEMP_POINTS.forEach((temp, k) => {
      const [mx, mn] = POWER_TABLE[key][k];
      if(mx === null) return;
      const r = E('getRollCandidates')(sk, temp, 'none', false);
      for(const [label, want, got] of [['最大', mx, r[r.length-1]], ['最小', mn, r[0]]]){
        out.points++;
        if(want !== got) out.mismatches.push(`${sk.name} ${temp}℃ ${label}: 表${want} / 式${got}`);
      }
    });
  }
  return out;
}

// アプリの resetAll のうち計算に関わる部分と同じ初期化
function newGame(E, preset){
  const p = E('PRESETS')[preset], G = E('G');
  G.preset = preset; G.trait = p.trait;
  G.level = 80; G.hammerId = 'light'; G.star = 3;
  G.masses = p.zones.map(([lo, hi], i) => {
    const off = !!(p.off && p.off.includes(i));
    return { current: 0, zoneLow: off ? 0 : lo, zoneHigh: off ? 0 : hi, off };
  });
  E('setActiveMask')(G.masses.map(m => !m.off));
  E('applyThreshold')();
  G.temp = 1000;
  E('litMassIndex = null; simFirstMove = null;');
  G.focus = E('FOCUS_CAP[80] + HAMMERS.light.focusBonus');
  G.rec = null; G.plan = []; G.pending = []; G.hist = []; G.posts = null; G.obs = null;
}

async function playGame(E, preset, rng, useMC){
  newGame(E, preset);
  const G = E('G'), cfg = E('cfgOf')(), PARAMS = E('PARAMS');
  const stratB = E('stratB'), stratMCAsync = E('stratMCAsync'), isStartState = E('isStartState');
  const rollsForMass = E('rollsForMass'), critForMass = E('critForMass'), updatePost = E('updatePost');
  const ideal = G.masses.map(m => m.zoneLow + Math.floor(rng() * (m.zoneHigh - m.zoneLow + 1)));
  const trace = [];
  for(let step = 0; step < 70; step++){
    if(G.masses.every(m => m.current >= m.zoneLow) || G.temp <= 0) break;
    // 点灯: 200℃の倍数で未到達マスから1つ(開始直後は特性が乗らない)
    let lit = null;
    if(G.trait === 'kaishin' && !isStartState() && G.temp % 200 === 0){
      const c = G.masses.map((m, i) => i).filter(i => !G.masses[i].off && G.masses[i].current < G.masses[i].zoneLow);
      if(c.length) lit = c[Math.floor(rng() * c.length)];
    }
    E(`litMassIndex = ${lit === null ? 'null' : lit};`);
    const ms = G.masses.map(m => ({ current: m.current, zoneLow: m.zoneLow, zoneHigh: m.zoneHigh }));
    const mv = useMC ? await stratMCAsync(ms, G.focus, G.temp, PARAMS, cfg, null)
                     : stratB(ms, G.focus, G.temp, PARAMS, cfg);
    if(!mv || mv.c > G.focus) break;
    trace.push(mv.sk.id + ':' + mv.tg.join(''));
    if(mv.sk.key) for(const i of mv.tg){
      const m = G.masses[i];
      if(m.current >= m.zoneLow) continue;
      const rolls = rollsForMass(mv.sk, G.temp, G.trait, i);
      const cr = critForMass(mv.sk, cfg, G.temp, i);
      if(!rolls) continue;
      const roll = rolls[Math.floor(rng() * rolls.length)];
      const crit = rng() < cr;
      const before = m.current;
      m.current = crit ? Math.min(before + 2 * roll, ideal[i]) : before + roll;
      updatePost(i, before, rolls, cr, m.current, crit);   // 候補ボタンで入力した場合と同じ
    }
    G.focus -= mv.c; G.temp = mv.nt; G.hist.push(mv.sk.id);
  }
  E('litMassIndex = null;');
  const reached = G.masses.every(m => m.current >= m.zoneLow);
  const over = G.masses.some(m => m.current > m.zoneHigh);
  const massError = E('massError');
  let err = 0;
  G.masses.forEach((m, i) => { err += massError(m.current, ideal[i], m.zoneLow, m.zoneHigh); });
  return { great: reached && err <= E('SUCCESS_THRESHOLD'), reached, over, err,
           moves: trace.length, focusLeft: G.focus, trace: trace.join(' ') };
}

async function runGames(E, task){
  const useMC = task.mode === 'mc';
  const rng = seeded(task.seed ^ fnv(task.preset) ^ (useMC ? 0x5a5a : 0));
  let great = 0, unreached = 0, over = 0, errSum = 0, moveSum = 0, focusSum = 0, h;
  const t0 = Date.now();
  for(let g = 0; g < task.games; g++){
    const r = await playGame(E, task.preset, rng, useMC);
    if(r.great) great++;
    if(!r.reached) unreached++;
    if(r.over) over++;
    errSum += r.err; moveSum += r.moves; focusSum += r.focusLeft;
    h = fnv(r.trace + '|', h);
  }
  const n = task.games, pct = x => Math.round(x / n * 1000) / 10;
  return { games: n, great: pct(great), unreached: pct(unreached), over: pct(over),
           avgErr: Math.round(errSum / n * 100) / 100, avgMoves: Math.round(moveSum / n * 10) / 10,
           avgFocusLeft: Math.round(focusSum / n * 10) / 10,
           fingerprint: ((h === undefined ? 0 : h) >>> 0).toString(16).padStart(8, '0'),
           sec: Math.round((Date.now() - t0) / 100) / 10 };
}

/* ===================== 親プロセス側 ===================== */
function parseArgs(argv){
  const o = { update: false, games: null, mc: null, presets: null };
  const num = (v, name) => {
    const n = Number(v);
    if(!Number.isInteger(n) || n < 0){ console.error(`${name} には0以上の整数を指定してください`); process.exit(2); }
    return n;
  };
  for(let i = 0; i < argv.length; i++){
    const a = argv[i];
    if(a === '--update') o.update = true;
    else if(a === '--games') o.games = num(argv[++i], '--games');
    else if(a === '--mc') o.mc = num(argv[++i], '--mc');
    else if(a === '--preset') o.presets = String(argv[++i] || '').split(',');
    else { console.error('不明な引数: ' + a); process.exit(2); }
  }
  return o;
}

function runTask(task){
  return new Promise((resolve, reject) => {
    const cp = fork(__filename, ['--worker', JSON.stringify(task)]);
    let got = null;
    cp.on('message', m => { got = m; });
    cp.on('error', reject);
    cp.on('exit', code => code === 0 && got ? resolve(got) : reject(new Error(`子プロセスが異常終了しました(${code})`)));
  });
}
async function runPool(tasks, limit){
  const out = new Array(tasks.length);
  let next = 0;
  const lane = async () => {
    while(next < tasks.length){
      const k = next++;
      out[k] = await runTask(tasks[k]);
      const t = tasks[k];
      if(t.kind === 'games') process.stderr.write(`  済: ${NAMES[t.preset]} ${t.mode === 'mc' ? '先読み' : '貪欲'}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, lane));
  return out;
}

function line(name, mode, r){
  return `${name.padEnd(10, '　')} ${mode} ${String(r.games).padStart(5)}局  大成功 ${String(r.great).padStart(5)}%  `
       + `未到達 ${String(r.unreached).padStart(4)}%  超過 ${String(r.over).padStart(4)}%  平均誤差 ${String(r.avgErr).padStart(5)}  `
       + `手数 ${String(r.avgMoves).padStart(4)}  残り集中 ${String(r.avgFocusLeft).padStart(5)}  [${r.fingerprint}] ${r.sec}秒`;
}

async function main(){
  const a = parseArgs(process.argv.slice(2));
  const custom = a.games !== null || a.mc !== null || a.presets !== null;
  const cfg = { games: a.games ?? DEFAULT.games, mc: a.mc ?? DEFAULT.mc,
                presets: a.presets ?? DEFAULT.presets, seed: DEFAULT.seed };
  for(const p of cfg.presets) if(!NAMES[p]){ console.error('不明な素材: ' + p + '(' + Object.keys(NAMES).join(', ') + ')'); process.exit(2); }

  // 先読みは時間がかかるので先に投入し、貪欲は空いた枠で回す
  const tasks = [{ kind: 'power', seed: cfg.seed }];
  if(cfg.mc > 0) for(const p of cfg.presets) tasks.push({ kind: 'games', preset: p, mode: 'mc', games: cfg.mc, seed: cfg.seed });
  if(cfg.games > 0) for(const p of cfg.presets) tasks.push({ kind: 'games', preset: p, mode: 'greedy', games: cfg.games, seed: cfg.seed });
  const t0 = Date.now();
  process.stderr.write(`実行中(${tasks.length - 1}組を最大${os.cpus().length}並列)…\n`);
  const res = await runPool(tasks, os.cpus().length);

  const result = { config: cfg, powerTable: res[0], results: {} };
  tasks.forEach((t, k) => {
    if(t.kind !== 'games') return;
    (result.results[t.preset] = result.results[t.preset] || {})[t.mode] = res[k];
  });

  const pt = result.powerTable;
  console.log(`威力の計算式と実測表の照合: ${pt.points}点中 ${pt.points - pt.mismatches.length}点一致`);
  pt.mismatches.forEach(m => console.log('  不一致 ' + m));
  for(const p of cfg.presets){
    const r = result.results[p];
    if(r.greedy) console.log(line(NAMES[p], '貪欲  ', r.greedy));
    if(r.mc)     console.log(line(NAMES[p], '先読み', r.mc));
  }
  console.log(`所要 ${Math.round((Date.now() - t0) / 1000)}秒`);

  // 所要時間は環境で変わるので照合から外す
  const strip = o => JSON.parse(JSON.stringify(o, (k, v) => k === 'sec' ? undefined : v));
  const now = strip(result);
  if(a.update){
    fs.writeFileSync(BASELINE, JSON.stringify(now, null, 2) + '\n');
    console.log('基準を更新しました: tests/baseline.json');
    return 0;
  }
  if(custom){ console.log('(条件を変えて実行したため、基準とは照合していません)'); return 0; }
  if(!fs.existsSync(BASELINE)){ console.log('基準がありません。--update で作成してください。'); return 1; }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  if(JSON.stringify(base) === JSON.stringify(now)){ console.log('基準と一致しました(エンジンの挙動は変わっていません)'); return 0; }
  console.log('基準と一致しません。エンジンの挙動が変わっています:');
  for(const p of Object.keys(now.results)){
    for(const mode of Object.keys(now.results[p])){
      const b = base.results[p] && base.results[p][mode], n = now.results[p][mode];
      if(JSON.stringify(b) !== JSON.stringify(n))
        console.log(`  ${NAMES[p]} ${mode === 'mc' ? '先読み' : '貪欲'}: 大成功 ${b ? b.great : '-'}% → ${n.great}%`
                  + `  (指紋 ${b ? b.fingerprint : '-'} → ${n.fingerprint})`);
    }
  }
  if(JSON.stringify(base.powerTable) !== JSON.stringify(now.powerTable)) console.log('  威力の照合結果が変わっています');
  if(JSON.stringify(base.config) !== JSON.stringify(now.config)) console.log('  基準の条件(局数・種)が変わっています');
  console.log('意図した変更なら、成績を確かめたうえで --update で基準を更新してください。');
  return 1;
}

if(process.argv[2] === '--worker'){
  Promise.resolve(workerMain(JSON.parse(process.argv[3])))
    .then(r => process.send(r, () => process.exit(0)))
    .catch(e => { console.error(e); process.exit(1); });
} else {
  main().then(code => process.exit(code)).catch(e => { console.error(e); process.exit(1); });
}
