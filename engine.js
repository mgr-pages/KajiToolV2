/* =====================================================================
   計算エンジン(超素材をつくろう!)
   ・画面(DOM)には一切触れない。状態 G を読み書きし、推奨手と手順を計算する。
   ・ui.js より先に読み込む(ui.js はここで定義した関数と変数を使う)。
   ・tests/sim.js から Node でも読み込み、成績の確認に使う。
   ===================================================================== */
/* ====== 状態 ====== */
const G = {
  temp: 1000,
  focus: 253,
  masses: [],
  level: 80, hammerId:'light', star:3, trait:'shuchu',
  rec: null, plan: [], barSkill:'tataku', preset:'kagayaki', barMax:null,
  customThreshold: 7,   // 手動設定の大成功の許容誤差(プリセットは素材ごとの値を使う)
  // 実行済み反映で「数値の手入力待ち」になっているマス番号
  pending: [], undoSnap: null, showRange: true, hist: [], posts: null, obs: null,
  fx: null   // 値が変わった直後のマスに一度だけ動きを付ける
};
// 素材ごとのプリセット。zones は各マスの成功ゾーン[下限,上限]、
// trait はその素材が持つ地金特性(選択時に自動で切り替える)。
const PRESETS = {
  kagayaki: {
    name: '超かがやきの樹液',
    trait: 'shuchu',
    threshold: 7,
    zones: [[155,161],[220,230],[155,161],[220,230],[140,150],[140,150]]
  },
  // ブルームシールド(防具鍛冶・盾、地金特性:集中力変化)
  //   盤面は2×2の4マス。縦3×横2の盤面の上2段を使い、下段(マス5・6)は使わない。
  //   ゾーンは公開の数値まとめより。許容誤差は盾の値3(公式ガイドブック準拠の表)。
  //   地金表記「集中力変化(会心半減)」は「会心アップ・集中力半減」の略で、樹液と同じ特性。
  bloom: {
    name: 'ブルームシールド',
    trait: 'shuchu',
    threshold: 3,
    off: [4, 5],
    // 評価の重みの上書き。既定の重みは6マス・許容誤差7の素材で調整したもので、
    // 許容誤差3のこの盤面では会心で理想値を捉える価値が足りなかった。
    // tests と同じモデルの貪欲エンジンで座標探索し(3000局・種7)、別の種(5000局・種101)で
    // 大成功 33.5% → 39.9% を確認した。
    params: { cap:24, adv:0.375, land:4.5, save:0, center:0, pr:0.4, boostPlan:0 },
    zones: [[207,213],[255,267],[255,267],[207,213],[0,0],[0,0]]
  },
  // 虹色のオーブ(道具鍛冶、地金特性:戻り)
  //   盤面は縦3×横2で A:左上 B:右上 / C:左中 D:右中 / E:左下 F:右下。
  //   ゾーンは公開の攻略情報(複数で一致)より。大成功はずれ合計7以下(6マスの商材と同じ)。
  //   戻る量は 12〜16 の範囲から乱数(利用者の情報)。
  //   重みは tools/tune.js(種7・3000局)で探し、探索に使っていない種で確かめた。
  //   貪欲で 5000局: 種101 53.7% → 60.1%、種202 53.3% → 60.2%(未到達は 0.4% → 4〜5% に増える)。
  //   探索で見つかった他の5項目(pr slack rush te pairSnipe)は、1つずつ戻しても差が誤差の範囲だったので入れていない。
  orb: {
    name: '虹色のオーブ',
    trait: 'modori',
    threshold: 7,
    modori: { min: 12, max: 16 },
    params: { cap:18, heat:10, ov:8 },
    zones: [[85,95],[140,148],[115,121],[140,148],[115,121],[85,95]]
  },
  // 超あまつゆのいと(地金特性:たたき変化)
  //   400℃の倍数で威力2倍、その±200℃で威力半減。
  //   ゾーンは 左上・左下・右中が180〜190(幅11)、右上・右下が245〜251(幅7)、
  //   左中が150〜156(幅7)。盤面は縦3×横2で [1][2] / [3][4] / [5][6]。
  amatsuyu: {
    name: '超あまつゆのいと',
    trait: 'tataki',
    threshold: 7,
    zones: [[180,190],[245,251],[150,156],[180,190],[180,190],[245,251]]
  },
  // 超ようせいのひだね(地金特性:威力会心率上昇)
  //   200℃の倍数のたび、ゾーン未到達のマスからランダムに1つが点灯。
  //   点灯マスは威力2倍・会心率+500%(37.2%)。非点灯マスは特性なしと同じ。
  //   ゾーンは3つの情報源で一致。ロール値と消費集中力は公開数値表と完全一致を確認済み。
  hidane: {
    name: '超ようせいのひだね',
    trait: 'kaishin',
    threshold: 7,
    // 評価の重みの上書き。ゾーン超過(16.6%)が多く、会心で理想値を捉える価値も足りていなかった。
    // tools/tune.js で座標探索し(3000局・種7、3巡目で改善なし)、別の種(5000局・種101)で
    // 大成功 45.7% → 52.5%、超過 16.6% → 10.8% を確認した(いずれも貪欲エンジン)。
    params: { cap:24, adv:1.5, heat:1, ov:6, rush:0, center:4.5, pr:2.4, te:7.5 },
    zones: [[180,190],[250,258],[210,216],[250,258],[210,216],[145,155]]
  }
};

/* ===================== 演算エンジン ===================== */
// ---- 特技定義(みだれ打ちは対象がランダムで狙えないため除外) ----
// 開始直後(まだ1手も打っていない状態)は地金特性が発動しない。
// 開始温度1000℃は本来なら会心率+400%のタイミングだが、1手目だけは適用されない。
// 手動フラグにすると外し忘れで以降ずっと無効になってしまうため、
// 「開始温度のまま、かつ全マスが0」という盤面の状態から自動判定する。
// シミュレーション中は simFirstMove で明示的に制御する。
let simFirstMove = null;   // null=自動判定 / true,false=強制

function isStartState(){
  if(simFirstMove !== null) return simFirstMove;
  // 開始温度のまま、かつ全マスが0なら「まだ1手も打っていない」状態
  if(G.temp !== START_TEMP) return false;
  return G.masses.every(m => m.current === 0);
}

const START_TEMP = 1000;   // 鍛冶開始時の温度

const SKILLS = [
  {id:'tataku', name:'たたく', lv:1, cost:5, key:'tataku', masses:1, shape:'single', tempDelta:-50},
  {id:'jouge', name:'上下打ち', lv:2, cost:8, key:'joge', masses:2, shape:'vertical', tempDelta:-50},
  {id:'tekagen', name:'てかげん打ち', lv:3, cost:10, key:'tekagen', masses:1, shape:'single', precision:true, tempDelta:-50},
  {id:'nibai', name:'2倍打ち', lv:5, cost:8, key:'nibai', masses:1, shape:'single', tempDelta:-50},
  {id:'karyoku', name:'火力上げ', lv:7, cost:10, key:null, masses:0, shape:'none', tempDelta:300},
  {id:'yonren', name:'4連打ち', lv:11, cost:12, key:'joge', masses:4, shape:'square', tempDelta:-50},
  {id:'sanbai', name:'3倍打ち', lv:16, cost:11, key:'sanbai', masses:1, shape:'single', tempDelta:-50},
  {id:'nerai', name:'ねらい打ち', lv:23, cost:16, key:'tataku', masses:1, shape:'single', crit:true, tempDelta:-50},
  {id:'chouyonren', name:'超4連打ち', lv:27, cost:18, key:'nibai', masses:4, shape:'square', tempDelta:-50},
  {id:'hiyashikomi', name:'冷やし込み', lv:33, cost:12, key:null, masses:0, shape:'none', tempDelta:-300},
  {id:'naname', name:'ななめ打ち', lv:38, cost:7, key:'joge', masses:2, shape:'diagonal', tempDelta:-50},
  {id:'reppuu', name:'熱風おろし', lv:47, cost:6, key:'reppu', masses:1, shape:'single', tempDelta:-150},
  {id:'jouge_nerai', name:'上下ねらい打ち', lv:52, cost:25, key:'joge', masses:2, shape:'vertical', crit:true, tempDelta:-50},
  {id:'yowanerai', name:'弱ねらい打ち', lv:75, cost:20, key:'tekagen', masses:1, shape:'single', crit:true, precision:true, tempDelta:-50},
  {id:'sayuu', name:'左右打ち', lv:80, cost:8, key:'joge', masses:2, shape:'horizontal', tempDelta:-50},
];


// ---- 鍛冶職人の集中力上限(Lv1〜75、Lv76〜80はデータなし) ----
const FOCUS_CAP = {
  1:50,2:52,3:53,4:56,5:57,6:60,7:61,8:64,9:67,10:67,
  11:70,12:73,13:73,14:76,15:79,16:79,17:82,18:84,19:87,20:87,
  21:90,22:93,23:93,24:96,25:98,26:101,27:101,28:104,29:109,30:109,
  31:112,32:113,33:113,34:115,35:119,36:122,37:123,38:123,39:125,40:129,
  41:132,42:134,43:137,44:139,45:139,46:142,47:142,48:144,49:147,50:149,
  51:152,52:152,53:154,54:157,55:159,56:162,57:162,58:164,59:167,60:169,
  61:171,62:171,63:173,64:175,65:177,66:180,67:182,68:184,69:186,70:188,
  71:189,72:191,73:193,74:195,75:197,
  // Lv76〜80は公開データが無いため、Lv80=208(実測の集中力253から
  // 光のハンマーの集中度45を引いた値)に向けて等間隔で補間した推定値。
  76:199,77:201,78:203,79:206,80:208,
};

// ---- 職人道具(ハンマー):集中度(開始時集中力加算)とできのよさ(★)ごとの会心率加算 ----
const HAMMERS = {
  copper:  {name:'銅の鍛冶ハンマー',   focusBonus:0,  critByStar:[1.0,1.1,1.2,2.0]},
  iron:    {name:'鉄の鍛冶ハンマー',   focusBonus:10, critByStar:[1.5,1.6,1.7,2.5]},
  silver:  {name:'銀の鍛冶ハンマー',   focusBonus:15, critByStar:[2.0,2.1,2.2,3.0]},
  platinum:{name:'プラチナ鍛冶ハンマー',focusBonus:25, critByStar:[2.5,2.6,2.7,3.5]},
  super:   {name:'超鍛冶ハンマー',     focusBonus:35, critByStar:[3.0,3.1,3.2,4.0]},
  miracle: {name:'奇跡のハンマー',     focusBonus:50, critByStar:[3.3,3.4,3.5,4.3]},
  light:   {name:'光のハンマー',       focusBonus:45, critByStar:[3.6,3.7,3.8,4.6]},
};

// ---- 会心率の計算 ----
// 最終会心率 = 基礎会心率(パッシブ累積+ハンマー★) × (1 + 地金特性ボーナス[0/4.0] + 狙い打ちボーナス[0/6.0])
function getPassiveCritPercent(level){
  let p = 0;
  if(level>=10) p += 0.1;
  if(level>=20) p += 0.2;
  if(level>=30) p += 0.3;
  return p;
}
let LIT_BONUS = 5.0;        // 点灯マスの会心率ボーナス(+500%)。実測値が無いための推定値。
function computeCritRate(skill, level, hammerId, star, trait, temp, isLit){
  const passive = getPassiveCritPercent(level);
  const hammer = HAMMERS[hammerId];
  // 道具会心率 = 職人スキル(パッシブ) + コツをつかんでいる + ハンマーのできのよさ
  // 「コツをつかんでいる」は同じ品を作り続けると常時付く +1.0%。
  const KOTSU = 1.0;
  const base = passive + KOTSU + (hammer ? hammer.critByStar[star] : 0); // %
  const st = traitTempState(temp);
  // 開始直後は地金特性が発動しないため、会心率ボーナスも乗らない
  const active = (typeof isStartState==='function') ? !isStartState() : true;
  const traitBonus = (trait==='shuchu' && st.mod200 && active) ? 4.0 : 0;
  // 威力会心率上昇(kaishin)の点灯マス。公開された検証値が存在しないため +500% を採用した。
  // 根拠: 会心率の計算式をまとめた情報源が「ねらい打ち程度か+500%くらい」と予測していること、
  // および実プレイヤーの打ち方が「集中効率の悪いねらい打ち(+600%)を捨てて点灯で会心を取る」
  // となっており、点灯がねらい打ちと同程度でなければ成立しないこと。
  // 実測ではないので、第5段階で公開されている大成功率(5〜8割)と突き合わせて検証する。
  const litBonus  = (trait==='kaishin' && isLit && (st.mod400 || st.mod200) && active) ? LIT_BONUS : 0;
  const naraiBonus = skill && skill.crit ? 6.0 : 0;
  const finalPct = base * (1 + traitBonus + litBonus + naraiBonus);
  return Math.max(0, Math.min(1, finalPct/100));
}

// ---- 地金特性ロジック ----
// 前提(判明分):
// ・効果は「打撃前の温度」で判定され、次に温度が変わるまで持続する(4連打ちなど複数マス同時ヒットにも同じ効果が適用される)
// ・集中力変化(shuchu):温度が400の倍数→集中力消費0.5倍。200の倍数かつ400の倍数でない→集中力消費1.5倍+会心率+400%(5倍)。威力の数値そのものへの影響はなし。
// ・たたき変化(tataki):温度が400の倍数→威力2倍。200の倍数かつ400の倍数でない→威力0.5倍(端数切り上げ)。会心が乗る場合は「たたき変化補正→切り上げ→会心の2倍」の順。
// ・威力会心率上昇(kaishin):温度が200の倍数になるたびに、ゾーン未到達のマスがランダムに1つ点灯(再抽選)。点灯マスは威力2倍+会心率大幅上昇。非点灯マスは特性なしと同じ。
// ・メーター減少・戻り(modori):温度が200の倍数になった時(始まりの1000℃は除く)、1マスの値が減る。
//   対象は、ゾーンを超えたマスがあれば上限から最も離れたマス、無ければ未到達のうちゾーンに最も近いマス。
//   値が0のマスは減らせないので対象にならない。値のあるマスが1つも無ければ戻りは起きない
//   (利用者の情報: 何かしら値が入っているマスが候補になる。全マス0のまま火力上げ2回で1600℃に着いても起きない)。
//   減る量は素材ごとに決まった範囲の中から乱数(PRESETS の modori)。超過したマスもこれで取り戻せる。
/* ---- 戻り(modori) ---- */
const MODORI_DEFAULT = { min: 12, max: 16 };      // 素材に指定が無い時の仮の範囲
function modoriRange(){
  const p = PRESETS[G.preset];
  return (p && p.modori) || MODORI_DEFAULT;
}
// 戻りの対象マス。ゾーンを超えたマスがあれば上限から最も離れたマス、無ければ未到達で値のある(0でない)
// マスのうちゾーンに最も近いマス。距離が同じなら番号の小さいマス(ゲームでの扱いは未確認)。
// 使わないマス(ゾーン 0〜0)は対象にしない。対象が無ければ null(戻りは起きない)。
function modoriTarget(ms){
  let oi = -1, od = 0;
  for(let i = 0; i < ms.length; i++){
    const m = ms[i]; if(m.zoneHigh <= 0) continue;
    const d = m.current - m.zoneHigh;
    if(d > od){ od = d; oi = i; }
  }
  if(oi >= 0) return oi;
  let ci = -1, cd = Infinity;
  for(let i = 0; i < ms.length; i++){
    const m = ms[i]; if(m.zoneHigh <= 0) continue;
    if(m.current <= 0) continue;               // 0のマスは減らせないので候補にならない
    const d = m.zoneLow - m.current;
    if(d > 0 && d < cd){ cd = d; ci = i; }
  }
  return ci >= 0 ? ci : null;
}
// 手を打った後に呼ぶ。温度が200の倍数になっていれば戻りを起こし、{マス, 量} を返す。
// 対象になるマスが無い時(超過が無く、値のある未到達のマスも無い。全マス0の時など)は起きないので null。
// 始まりの1000℃では起きないが、この関数は打った後にしか呼ばないので自然にそうなる。
function applyModori(ms, temp, trait, rnd){
  if(trait !== 'modori' || temp <= 0 || temp % 200 !== 0) return null;
  const i = modoriTarget(ms);
  if(i === null) return null;
  const r = modoriRange();
  const amt = r.min + Math.floor(rnd() * (r.max - r.min + 1));
  ms[i].current = Math.max(0, ms[i].current - amt);
  return { i, amt };
}
// 1マスを打った直後に取りうる値(通常・会心)。
// 会心は理想値を通り越すと理想値で止まるので、ゾーンの上限を超えることは無い。
// 会心の値は「理想値の手前で止まった 前の値+2×ロール(ゾーン未満)」か「ゾーン内の値」。
function hitOutcomes(before, rolls, zoneLow, zoneHigh){
  const normal = new Set(), crit = new Set();
  for(const r of rolls){ normal.add(before + r); if(before + 2*r < zoneLow) crit.add(before + 2*r); }
  const top = before + 2*rolls[rolls.length-1];
  for(let v = Math.max(zoneLow, before + 1); v <= zoneHigh && v <= top; v++) crit.add(v);
  return { normal: [...normal].sort((a,b)=>a-b), crit: [...crit].sort((a,b)=>a-b) };
}
// 打った結果の全ての組み合わせについて戻りの対象を求める。
// outcomes は {マス番号: 取りうる値の配列}。打っていないマスは今の値のまま。
// 返り値の Set は対象になりうるマス。付随して、打ったマスごとに
//   asTarget[i]: そのマスが対象になる時の、打った直後の値
//   asOther[i] : そのマスが対象にならない時の、打った直後の値
// を持たせる(入力の候補を、実際に起こりうるものだけに絞るため)。
// none は「戻りが起きない組み合わせがある」(全マスがゾーンに入った・値のあるマスが無い)。
function possibleModoriTargets(ms, outcomes){
  const idx = Object.keys(outcomes).map(Number);
  const vals = idx.map(i => [...new Set(outcomes[i])]);
  const cur = ms.map(m => ({ current: m.current, zoneLow: m.zoneLow, zoneHigh: m.zoneHigh }));
  const found = new Set(), asTarget = {}, asOther = {};
  let none = false;
  for(const i of idx){ asTarget[i] = new Set(); asOther[i] = new Set(); }
  let budget = 400000;                 // 組み合わせが多すぎる時の打ち切り(4マス×25通りでも収まる)
  (function rec(k){
    if(budget-- <= 0){ none = true; return; }      // 数え切れない時は「起きないかも」として扱う
    if(k === idx.length){
      const t = modoriTarget(cur);
      if(t !== null) found.add(t); else none = true;
      for(const i of idx) (i === t ? asTarget : asOther)[i].add(cur[i].current);
      return;
    }
    for(const v of vals[k]){ cur[idx[k]].current = v; rec(k + 1); }
  })(0);
  found.asTarget = asTarget; found.asOther = asOther; found.none = none;
  return found;
}
// 盤面が仕上がったか。戻りの地金では超過も取り戻せるので、超過が残る間は仕上がりとしない。
function boardDone(ms, trait){
  if(!ms.every(m => m.current >= m.zoneLow)) return false;
  return trait !== 'modori' || ms.every(m => m.current <= m.zoneHigh);
}
// 戻りの地金で、全マスがゾーンに届いたのに超過が残っている時の手。
// 戻りを起こすには温度を200の倍数に合わせる必要があり、打てるマスが無いので温度操作だけで合わせる。
// 火力上げ・冷やし込みを最大2手組み合わせ、200の倍数に着く最安の1手目を返す。着けなければ null。
function modoriRecover(ms, f, t, cfg){
  const ops = SKILLS.filter(s => s.masses === 0 && s.lv <= cfg.level);
  let best = null, bc = Infinity;
  for(const a of ops){
    const ca = actualCostOf(a, t, cfg.trait), ta = t + a.tempDelta;
    if(ca > f || ta <= 0) continue;
    if(ta % 200 === 0){ if(ca < bc){ bc = ca; best = { sk: a, tg: [], c: ca, nt: ta, overP: 0 }; } continue; }
    for(const b of ops){
      const cb = actualCostOf(b, ta, cfg.trait), tb = ta + b.tempDelta;
      if(ca + cb > f || tb <= 0 || tb % 200 !== 0) continue;
      if(ca + cb < bc){ bc = ca + cb; best = { sk: a, tg: [], c: ca, nt: ta, overP: 0 }; }
    }
  }
  return best;
}

function traitTempState(temp){
  const mod400 = temp % 400 === 0;
  const mod200 = temp % 200 === 0 && !mod400;
  return { mod400, mod200 };
}

function getPowerMultiplier(trait, temp, isLitMass){
  if(!traitActive(temp)) return 1;      // 1手目は地金特性が乗らない
  const st = traitTempState(temp);
  if(trait === 'tataki'){
    if(st.mod400) return 2;
    if(st.mod200) return 0.5;
    return 1;
  }
  if(trait === 'kaishin' && isLitMass && (st.mod400 || st.mod200)){
    return 2;
  }
  return 1;
}

// 点灯しているマスの番号。kaishin 以外では常に null なので、
// 下の2つの入口は既存2商材では getRollCandidates(...,false) と完全に同じ値を返す。
let litMassIndex = null;
// ロールアウトの中で、200℃の倍数に来るたびに点灯マスを引き直す。
// 実機は未到達マスからランダムに1つ選ぶ(再抽選)。
// 現在の手番だけは実際に光っているマスが分かっているので触らない。
function rollLit(ms, temp, trait, rnd){
  if(trait !== 'kaishin'){ litMassIndex = null; return; }
  if(temp % 200 !== 0 || temp <= 0){ litMassIndex = null; return; }
  const cand = [];
  for(let i = 0; i < ms.length; i++) if(ms[i].current < ms[i].zoneLow) cand.push(i);
  litMassIndex = cand.length ? cand[(rnd()*cand.length)|0] : null;
}
function clearLit(){ litMassIndex = null; }
function isLitAt(trait, i){
  return trait === 'kaishin' && litMassIndex !== null && litMassIndex === i;
}
function rollsForMass(skill, temp, trait, i){
  return getRollCandidates(skill, temp, trait, isLitAt(trait, i));
}
function critForMass(skill, cfg, temp, i){
  return computeCritRate(skill, cfg.level, cfg.hammerId, cfg.star, cfg.trait, temp, isLitAt(cfg.trait, i));
}

/* 威力の計算式(検証済み)
   1000℃時の基準値 n に対して   値 = ceil( n × (0.0005 × min(温度,2000) + 0.5) )
   係数は 350℃で0.675、1000℃で1.0、2000℃で1.5。2000℃を超えても頭打ち。
   候補は「最小と最大を等分」ではなく、基準 n の整数を1つずつ当てはめた結果になる。
   実測テーブル(tests/power-table.js)の最大・最小248点はすべてこの式で再現できる。
   照合は tests/sim.js が毎回行う。 */
/* ロールは常に7通り。計算式は
     会心 × ceil( 特性 × ceil( (0.5 + 0.0005×温度) × ceil(n × 技倍率) ) )
   n は「たたく」の 12〜18。温度は2000℃で頭打ち。
   技倍率 y は てかげん0.5 / みだれ0.8 / 通常1 / 上下・4連・ななめ1.2 /
   2倍・超4連2 / 熱風2.5 / 3倍3。端数はいずれも切り上げ。
   特性(たたき変化)は 1・2・0.5、会心は最後に2倍する。
   6系列すべての最小値と最大値が実測テーブルと一致することを確認済み。 */
const SKILL_MULT = { tataku:1, tekagen:0.5, joge:1.2, nibai:2, sanbai:3, reppu:2.5, midare:0.8 };
const BASE_N = {};   // 1000℃時の7通り
(function(){
  for(const key of Object.keys(SKILL_MULT)){
    const m = SKILL_MULT[key], v = [];
    for(let n = 12; n <= 18; n++) v.push(Math.ceil(n * m));
    BASE_N[key] = v;
  }
  // 上下系(上下打ち・4連打ち・ななめ打ち・左右打ち・上下ねらい打ち)の4番目を実測で補正。
  // 式では 15×1.2 = 18.0 ちょうどとなり切り上げても18だが、実機は19。
  // 根拠となった観測(いずれも1000℃時の基準19が必要):
  //   2050℃ 4連打ち → 29 / 1800℃ 上下ねらい打ち → 27
  // 最小15・最大22は変わらないため、実測テーブルとの照合には影響しない。
  BASE_N.joge = [15, 16, 17, 19, 20, 21, 22];
})();
// 係数 (0.5 + 0.0005x) は (1000 + x) / 2000 と同じ。
// 小数で計算すると 0.0005*1400 が 0.7000000000000001 になり、
// 切り上げの結果が1ずれるため、整数の分子分母で扱う。
function tempNum(temp){ return 1000 + Math.max(50, Math.min(2000, temp)); }
function scaleUp(base, temp){ return Math.ceil(base * tempNum(temp) / 2000); }
function baseValues(key){ return BASE_N[key] || null; }

const GRID_ROWS = 3, GRID_COLS = 2; // 縦3×横2(超かがやきの樹液)
// 大成功の許容誤差(誤差合計)。商材の盤面の形で決まるため、素材を切り替えるたびに設定し直す。
// 出典: 公式ガイドブックを元にした種別ごとの表(6マスの練金ツボ・家具=7、盾・アタマ=3 など)。
// 手動設定では盤面の形が分からないので、設定の「許容誤差」(G.customThreshold)を使う。
let SUCCESS_THRESHOLD = 7;
const DEFAULT_THRESHOLD = 7;
function isValidThreshold(v){ return Number.isInteger(v) && v >= 0 && v <= 99; }
// 素材ごとの設定(許容誤差と、評価の重みの上書き)を反映する。素材を切り替えた時に呼ぶ。
function applyThreshold(){
  // 評価の重みは既定値に戻してから、素材に上書きがあれば重ねる
  if(typeof BASE_PARAMS !== 'undefined'){
    for(const k of Object.keys(PARAMS)) delete PARAMS[k];
    Object.assign(PARAMS, BASE_PARAMS);
    const pp = PRESETS[G.preset];
    if(pp && pp.params) Object.assign(PARAMS, pp.params);
  }
  if(G.preset === 'custom'){
    SUCCESS_THRESHOLD = isValidThreshold(G.customThreshold) ? G.customThreshold : DEFAULT_THRESHOLD;
    return;
  }
  const p = PRESETS[G.preset];
  SUCCESS_THRESHOLD = (p && typeof p.threshold === 'number') ? p.threshold : DEFAULT_THRESHOLD;
}
const MAX_ERR = 4;                  // ゾーン内の誤差キャップ
// ゾーンを超えたマスの誤差の下限。公開情報「成功ゾーン内は差が5以上でも4扱い、
// 逆に成功ゾーン外は必ず誤差9以上扱い」に基づく。許容7の6マス商材では、
// 1マスでも超過すれば大成功にならない。
const OVER_ERR_MIN = 9;
// 1マスの誤差。成功判定・期待誤差の計算はすべてこの関数を通す。
// (以前は箇所ごとに書き方が違い、超過マスを実差のまま数える箇所が残っていた)
function massError(current, ideal, zoneLow, zoneHigh){
  const raw = Math.abs(current - ideal);
  if(current >= zoneLow && current <= zoneHigh) return Math.min(raw, MAX_ERR);
  if(current > zoneHigh) return Math.max(raw, OVER_ERR_MIN);
  return raw;                        // 未到達。成功判定では別途「失敗」として扱う
}

// 推奨手の重み。すべて実測(各数千〜1.5万回のシミュレーション)で決めた値。
//   cap  : 会心が理想値を捉える見込み
//   adv  : 前進量あたりの効率
//   land : 特殊温度に着地することの価値
//   heat : 温度不足で火力上げに切り替える閾値
//   ov   : ゾーン超過のリスク(超過は回復不能)
//   pr   : 遅れているマスを優先する度合い
//   te   : 本会心ゾーンにいるマスを狙い打つ価値
//   rush : 会心の見込みが無いマスをゾーンへ押し込む手の抑制
//   save : 消費半減ターンで、節約額の大きい技を選ぶ度合い
//   turn : 特殊温度(会心+400% / 消費半減)に乗る手を優先する度合い
/* 評価パラメータ。素材ごとの効き方は検証済み(0にした時に結果が変わる対局の割合)。
   両方       cap adv land heat ov pr tmax te center far mpm slack effK slackMax
              rush wideAim pairSnipe
   樹液のみ    save(39.7%) turn(8.4%) boostPlan(3.6%) saveCap boostAim boostRes
   いとのみ    opening(51.0%) center(16.4%) tatakiFit(5.1%) x2turn aimNow aimRes
   ※ 樹液=超かがやきの樹液(集中力変化) / いと=超あまつゆのいと(たたき変化) */
const PARAMS = { cap:12, adv:0.75, land:3, heat:4, ov:4, pr:0.8, tmax:2200,
                 te:5, rush:0.6, save:25, turn:5, tatakiFit:1.5, boostPlan:1, center:3, opening:1, wideAim:2, pairSnipe:1, far:5, mpm:16, slack:1, effK:4, slackMax:2, saveCap:0.7, boostAim:0.7, boostRes:24, x2turn:10, aimNow:1, aimRes:2.2 };
// 既定の重み。素材ごとの上書き(PRESETS の params)は applyThreshold が重ねる。
const BASE_PARAMS = Object.freeze(Object.assign({}, PARAMS));

function rcToIdx(r,c){
  if(r<0||r>=GRID_ROWS||c<0||c>=GRID_COLS) return null;
  return r*GRID_COLS+c;
}

// 技ごとの対象マスの組み合わせを、盤面の隣接関係に沿って列挙する
// 盤面に存在しないマス(使わないマス)にはみ出す形は打てない(実ゲームの挙動)。
// 例: 2×2の盾で、超4連打ちを下段2マスだけに当てることはできない。
// ※以前は「残ったマスだけを対象に打てる」としていたが、実際には打てないとの指摘を受けて戻した
//   (引き継ぎ資料 v116)。ゾーンに到達済みのマスを含む形は、盤面上に存在するので打てる。
let ACTIVE = null;                       // null = 全マス有効
function setActiveMask(list){
  ACTIVE = (Array.isArray(list) && list.some(v => !v)) ? list.slice() : null;
}
function isActive(i){ return !ACTIVE || ACTIVE[i]; }
function enumerateTargetSets(skill){
  const sets = [];
  if(skill.masses===0) return [[]];
  if(skill.masses===1){
    for(let i=0;i<GRID_ROWS*GRID_COLS;i++) if(isActive(i)) sets.push([i]);
    return sets;
  }
  for(let r=0;r<GRID_ROWS;r++){
    for(let c=0;c<GRID_COLS;c++){
      const base = rcToIdx(r,c);
      if(base===null) continue;
      if(skill.shape==='vertical'){
        const b = rcToIdx(r+1,c);
        if(b!==null) sets.push([base,b]);
      } else if(skill.shape==='horizontal'){
        const b = rcToIdx(r,c+1);
        if(b!==null) sets.push([base,b]);
      } else if(skill.shape==='diagonal'){
        const b = rcToIdx(r+1,c-1);
        if(b!==null) sets.push([base,b]);
      } else if(skill.shape==='square'){
        const a=rcToIdx(r,c), b=rcToIdx(r,c+1), d=rcToIdx(r+1,c), e=rcToIdx(r+1,c+1);
        if(a!==null&&b!==null&&d!==null&&e!==null) sets.push([a,b,d,e]);
      }
    }
  }
  if(!ACTIVE) return sets;
  // 存在しないマスを1つでも含む形は、盤面からはみ出すので打てない
  return sets.filter(g => g.every(i => ACTIVE[i]));
}

// 地金特性「集中力変化」による消費の増減
//  400の倍数 → 消費半減 / 200の倍数(400除く) → 消費1.5倍だが会心率+400%
function traitActive(temp){
  return !isStartState();
}
function actualCostOf(sk, temp, trait){
  if(trait!=='shuchu') return sk.cost;
  if(!traitActive(temp)) return sk.cost;     // 開始直後は特性が乗らない
  if(temp%400===0) return Math.max(1, Math.round(sk.cost*0.5));
  if(temp%200===0) return Math.round(sk.cost*1.5);
  return sk.cost;
}
// 消費半減 / 会心率+400% は地金特性「集中力変化」でのみ発生する。
// 他の特性(たたき変化など)では、同じ温度でも別の効果になるため false を返す。
const isHalfTurn  = t => traitActive(t) && G.trait==='shuchu' && t%400===0;
const isBoostTurn = t => traitActive(t) && G.trait==='shuchu' && t%200===0 && t%400!==0;

// たたき変化:400の倍数で威力2倍、200の倍数(400除く)で威力半減
const isPowerUpTurn   = t => traitActive(t) && G.trait==='tataki' && t%400===0;
const isPowerDownTurn = t => traitActive(t) && G.trait==='tataki' && t%200===0 && t%400!==0;

// その温度・技での7候補のロール値(整数、四捨五入)
function getRollCandidates(skill, temp, trait, isLit){
  if(!skill.key) return null;
  const ns = baseValues(skill.key);
  if(!ns) return null;
  const mult = getPowerMultiplier(trait, temp, isLit);
  const out = [];
  for(let k=0;k<7;k++){                        // 候補は常に7通り
    const v = scaleUp(ns[k], temp);
    out.push((mult === 1) ? v : Math.ceil(v * mult));
  }
  return out;
}

// 超過リスクのあるマスは「今は触らない」のが正解。
// 全体の温度を下げると他マスの効率まで落ちるが、そのマスを後回しにして
// 他を進めれば、打撃のたびに温度は自然に下がり、やがて安全圏に入る。
// 冷やし込みが要るとしても、他が片付いた最後の場面に限られる。
function moves(ms,f,t,cfg){
  const strict=[], loose=[];
  for(const sk of SKILLS){
    if(sk.lv>cfg.level||sk.id==='midare')continue;
    const c=actualCostOf(sk,t,cfg.trait);
    if(c>f)continue;
    const nt=Math.max(0,t+sk.tempDelta);
    if(nt<=0)continue;
    if(sk.masses===0){ strict.push({sk,tg:[],c,nt,overP:0}); continue; }
    if(!getRollCandidates(sk,t,cfg.trait,false))continue;
    for(const tg of enumerateTargetSets(sk)){
      if(tg.some(i=>ms[i].current>=ms[i].zoneLow))continue;
      let maxOver=0;
      for(const i of tg){
        // 点灯マスはロールが2倍。共通のロールで判定すると超過を見逃す
        const r=rollsForMass(sk,t,cfg.trait,i);
        if(!r) continue;
        let cnt=0;
        for(const x of r) if(ms[i].current+x>ms[i].zoneHigh) cnt++;
        maxOver=Math.max(maxOver,cnt/r.length);
      }
      const mv={sk,tg,c,nt,overP:maxOver};
      if(maxOver===0) strict.push(mv);
      else loose.push(mv);
    }
  }
  if(strict.some(m=>m.sk.masses>0)) return strict;
  // 安全に打てる打撃手が無い = 未到達マスがすべて超過圏にある状態。
  // ここまで来て初めて冷やし込みに価値が出る(他マスへの巻き添えがないため)。
  // たたき変化では火力上げも同じ役に立つ。半減ターン(200の倍数)に上げればロールが縮む
  // (例: 700℃で残り1のマスは、火力上げで1000℃にすればてかげん打ち3〜5で収まる)。
  const cool=[];
  for(const sk of SKILLS){
    if(sk.lv>cfg.level||sk.masses!==0||sk.tempDelta===0)continue;
    const c=actualCostOf(sk,t,cfg.trait);
    if(c>f)continue;
    const nt=Math.max(0,t+sk.tempDelta);
    if(nt<=0)continue;
    // 下げた先で安全に打てるようになるか
    let ok=false;
    for(const s2 of SKILLS){
      if(s2.lv>cfg.level||s2.masses===0||s2.id==='midare')continue;
      const r2=getRollCandidates(s2,nt,cfg.trait,false);
      if(!r2||actualCostOf(s2,nt,cfg.trait)>f-c)continue;
      for(const tg2 of enumerateTargetSets(s2)){
        if(tg2.some(i=>ms[i].current>=ms[i].zoneLow))continue;
        let safe=true;
        for(const i of tg2) if(ms[i].current+r2[r2.length-1]>ms[i].zoneHigh){safe=false;break;}
        if(safe){ok=true;break;}
      }
      if(ok)break;
    }
    if(ok) cool.push({sk,tg:[],c,nt,overP:0,cooling:true});
  }
  if(cool.length>0) return strict.concat(cool);
  // ここに来た = 安全に打てる手も冷却で解決する手も無く、
  // 超過覚悟で撃つしかない状態。だがその前に、温度を下げれば
  // ロール値そのものが縮んで収まる可能性がある。
  // 残り1のマスは500℃以下、残り2は700℃以下でないと収まらないため、
  // 冷却が複数回必要なこともある。集中力が許すなら冷却を優先する。
  const rescue=[];
  for(const sk of SKILLS){
    if(sk.lv>cfg.level||sk.id==='midare')continue;
    if(sk.tempDelta>=0)continue;
    const c=actualCostOf(sk,t,cfg.trait);
    if(c>f)continue;
    const nt=Math.max(0,t+sk.tempDelta);
    if(nt<=0)continue;
    // 下げ続ければ最終的に収まるか(集中力が尽きるまで試算)
    let tt=nt, ff=f-c, reachable=false;
    for(let k=0;k<8;k++){
      let ok=false;
      for(const m of ms){
        if(m.current>=m.zoneLow)continue;
        for(const s2 of SKILLS){
          if(s2.lv>cfg.level||s2.masses===0||s2.id==='midare')continue;
          const r2=getRollCandidates(s2,tt,cfg.trait,false);
          if(!r2)continue;
          if(actualCostOf(s2,tt,cfg.trait)>ff)continue;
          if(m.current+r2[r2.length-1]<=m.zoneHigh){ok=true;break;}
        }
        if(ok)break;
      }
      if(ok){reachable=true;break;}
      const c2=actualCostOf(sk,tt,cfg.trait);
      if(c2>ff||tt+sk.tempDelta<=0)break;
      ff-=c2; tt=Math.max(0,tt+sk.tempDelta);
    }
    if(!reachable)continue;
    if(sk.masses===0){ rescue.push({sk,tg:[],c,nt,overP:0,cooling:true}); }
    else{
      if(!getRollCandidates(sk,t,cfg.trait,false))continue;
      let added=false;
      for(const tg of enumerateTargetSets(sk)){
        if(tg.some(i=>ms[i].current>=ms[i].zoneLow))continue;
        let safe=true;
        for(const i of tg){
          const r=rollsForMass(sk,t,cfg.trait,i);
          if(r&&ms[i].current+r[r.length-1]>ms[i].zoneHigh){safe=false;break;}
        }
        if(safe){ rescue.push({sk,tg,c,nt,overP:0,cooling:true}); added=true; }
      }
      // 対象マスを持つ技を「対象なし」で出してはいけない。
      // 熱風おろしはロールがたたくの約2.5倍あり、実際に撃てば必ずどこかのマスが伸びる。
      // 対象なしで出すと、その前進量が計算から消えたまま推奨されることになり、
      // プレイヤーが実行した瞬間に盤面と予測がずれる。
      // 安全な対象が無い場合は、超過が最も小さい対象を選び、その超過リスクを明示する。
      // ただし必ず超過する手は救いにならない(超過は大成功を失う)ので出さない。
      // 出すと、超過の確率がもっと低い手(下の loose)が候補から消えてしまう。
      if(!added){
        let bestTg = null, bestOv = Infinity;
        for(const tg of enumerateTargetSets(sk)){
          if(tg.some(i=>ms[i].current>=ms[i].zoneLow))continue;
          let ov = 0;
          for(const i of tg){
            const r = rollsForMass(sk, t, cfg.trait, i);
            if(!r) continue;
            let cnt = 0;
            for(const x of r) if(ms[i].current+x>ms[i].zoneHigh) cnt++;
            ov = Math.max(ov, cnt/r.length);
          }
          if(ov < bestOv){ bestOv = ov; bestTg = tg; }
        }
        if(bestTg && bestOv < 1) rescue.push({sk,tg:bestTg,c,nt,overP:bestOv,cooling:true});
      }
    }
  }
  if(rescue.length>0) return strict.concat(rescue);
  loose.sort((a,b)=>a.overP-b.overP);
  return strict.concat(loose.slice(0,12));
}
function needTotal(ms){return ms.reduce((a,m)=>a+Math.max(0,m.zoneLow-m.current),0);}

// --- 戦術B: リズム戦術 ---
// 熱風(-150)+通常(-50)=-200 で特殊温度を渡り歩く。
// 半減ターンは消費が1/3なので狙い打ちを連打、会心ターンは高会心率の一撃。
// たたき変化(超あまつゆのいと)の開幕定跡。
// 実プレイヤーが共有している手順で、倍加ターンに大技を合わせ、
// 半減ターンを一度も踏まずに進める。
//   1600★ 熱風(最遠マス) → 2050まで加熱 → 2000★ 超4連 → 1600★ 4連
// 現状のエンジンは効率だけで選ぶため、半減ターンで打撃したり
// 通常ターンで超4連を撃ったりと、倍加の恩恵を取りこぼしていた。
let P_OPEN_TH = 0.65;

// 上下ねらい打ちは2マス同時に本会心を狙える唯一の技。
// 消費25で2マス分なので、単発のねらい打ち(16×2=32)より安い。
function pairSnipe(ms, f, t, cfg){
  const jn = SKILLS.find(s => s.id === 'jouge_nerai' && s.lv <= cfg.level);
  if(!jn) return null;
  const c = actualCostOf(jn, t, cfg.trait);
  if(c > f) return null;
  const r = getRollCandidates(jn, t, cfg.trait, false);
  if(!r) return null;
  for(const tg of enumerateTargetSets(jn)){
    if(tg.some(i => ms[i].current >= ms[i].zoneLow)) continue;
    const ok = tg.every(i => {
      const m = ms[i];
      // 点灯マスはロール2倍なので、本会心の成立帯がマスごとに違う
      const rI = rollsForMass(jn, t, cfg.trait, i) || r;
      return m.current + rI[rI.length-1] <= m.zoneHigh && m.current + 2*rI[0] >= m.zoneHigh;
    });
    if(ok) return { sk: jn, tg, c, nt: Math.max(0, t + jn.tempDelta), overP: 0 };
  }
  return null;
}

function tatakiOpening(ms, f, t, cfg){
  if(cfg.trait !== 'tataki') return null;
  const K  = SKILLS.find(s => s.id === 'karyoku'    && s.lv <= cfg.level);
  const R  = SKILLS.find(s => s.id === 'reppuu'     && s.lv <= cfg.level);
  const C4 = SKILLS.find(s => s.id === 'chouyonren' && s.lv <= cfg.level);
  const Y4 = SKILLS.find(s => s.id === 'yonren'     && s.lv <= cfg.level);
  const NN = SKILLS.find(s => s.id === 'naname'     && s.lv <= cfg.level);
  const TK = SKILLS.find(s => s.id === 'tataku'     && s.lv <= cfg.level);
  if(!K || !R || !C4 || !Y4 || !NN || !TK) return null;
  const mk = (sk, tg) => {
    // 定跡はマス番号を直接指定するので、存在しないマスを含む形はここで弾く
    if(ACTIVE && tg.some(i => !ACTIVE[i])) return null;
    const c = actualCostOf(sk, t, cfg.trait);
    if(c > f) return null;
    const r = sk.masses > 0 ? getRollCandidates(sk, t, cfg.trait, false) : null;
    if(sk.masses > 0){
      if(!r) return null;
      for(const i of tg) if(ms[i].current + r[r.length-1] > ms[i].zoneHigh) return null;
    }
    return { sk, tg, c, nt: Math.max(0, t + sk.tempDelta), overP: 0 };
  };
  const untouched = ms.every(m => m.current === 0);

  // --- 手1〜3: 1600℃(倍加)まで加熱し、最も遠いマスへ熱風 ---
  if(untouched){
    if(t < 1600) return mk(K, []);
    // 実プレイヤーの定跡では、この熱風は必ず A(左上) に入れる。
    // A は幅11で本会心の価値が高く、超4連の対象[C,D,E,F]から漏れるため、
    // ここで先に進めておかないと後半で追いつかなくなる。
    if(t === 1600){
      const mv = mk(R, [0]);
      if(mv) return mv;
    }
  }

  // 定跡は序盤のみ。盤面が進んだら通常評価へ委ねる。
  const progress = ms.reduce((a,m)=>a+Math.min(m.current, m.zoneLow), 0);
  const need = ms.reduce((a,m)=>a+m.zoneLow, 0);
  if(progress > need * (P_OPEN_TH || 0.65)) return null;

  // --- 超4連の直後: Bをたたき、BとFへ順に熱風を入れる ---
  // 2000℃の超4連は C・D・E・F を叩くため、A と B が取り残される。
  // B は最も遠いゾーン(245)なので、たたく+熱風で追い上げる。
  // 熱風2回で -300℃ となり、次の倍加ターン(1600℃)にちょうど乗る。
  // この処理は「2000℃の超4連を撃ち終えた直後」に限る。
  // 判定: C・D・E・F が進んでいて、かつ温度が2000℃未満に落ちている。
  if(t < 2000 && t >= 1600 && ms[2].current > 50 && ms[3].current > 50
     && ms[4].current > 0 && ms[5].current > 0){
    const B = 1, F = 5;
    // --- 位相補正 ---
    // ここから熱風(-150)だけで400の倍数(=威力2倍ターン)に着けるかを確認し、
    // 着けないなら先に打撃(-50)を挟んで温度格子を合わせる。
    // 従来は「Bが0ならたたく」という条件が偶然この補正を兼ねていた。
    // そのためBが先に進んでいる盤面では補正が飛び、以降の温度が50℃ずれた
    // 格子(1650/1500/1350…)に乗って威力2倍ターンを外していた。
    // 実測: 開幕でマス2を1回叩くだけで倍加ターン -0.53回/game、手数 +2.7手、
    // 熱風 +3.55回・火力上げ +1回で31集中力を余分に消費していた。
    // 検証: 位相が崩れた盤面で大成功 +6.02/+4.93pt、失敗 4.50%→2.32% / 4.80%→2.48%。
    // 本線(マス2が0のまま)では従来と同じ手を選ぶため 50.11%→50.13% / 49.66%→49.68% と無変化。
    let onGrid = false;
    for(let k = 0; k <= 2; k++){
      const n = t - 150 * k;
      if(n >= 1600 && n % 400 === 0){ onGrid = true; break; }
    }
    if(!onGrid){
      for(const i of [B, F, 0, 2, 3, 4]){
        if(ms[i].current >= ms[i].zoneLow) continue;
        const mv = mk(TK, [i]);
        if(mv) return mv;
      }
    }
    // BとFのうち低い方へ熱風。目標(zoneHigh-60)に届くまで
    const rr = getRollCandidates(R, t, cfg.trait, false);
    if(rr){
      const order = ms[B].current <= ms[F].current ? [B, F] : [F, B];
      for(const i of order){
        if(ms[i].current >= ms[i].zoneHigh - 60) continue;
        if(ms[i].current + rr[rr.length-1] > ms[i].zoneHigh) continue;
        const mv = mk(R, [i]);
        if(mv) return mv;
      }
    }
  }

  // --- 倍加ターン: 4マス技を安全に撃つ ---
  if(isPowerUpTurn(t)){
    for(const sk of [C4, Y4]){
      const r = getRollCandidates(sk, t, cfg.trait, false);
      if(!r) continue;
      for(const tg of enumerateTargetSets(sk)){
        if(!tg.every(i => ms[i].current < ms[i].zoneLow && ms[i].current + r[r.length-1] <= ms[i].zoneHigh)) continue;
        const mv = mk(sk, tg);
        if(mv) return mv;
      }
    }
  }

  // --- 倍加ターンの1手前: 4連打ちで軽く詰める ---
  // 超4連をここで撃つと次の倍加ターンで突き抜けて撃てなくなる。
  if(isPowerUpTurn(t - 50)){
    // まずは ななめ打ち[マス4,5] を試す。
    // 上下・左右のペアは必ず幅11と幅7が1つずつの混成だが、ななめ[4,5]だけは
    // 幅11を2マス叩ける。ここで4連打ちを使うとマス3(幅7)が先に進み、
    // 2000℃の超4連の直後に残距離35 ---「1600℃倍加のねらい打ち(最大48)では超過、
    // 1500℃通常(距離帯23〜30)では届かない」という技の窓の谷間 --- に落ちる。
    // ななめ[4,5]ならマス3の残距離は62に収まり、集中力も5安い。
    // 検証: 3シード系列で大成功 +3.20〜+3.50pt (t=4.85〜5.26)。
    // 位相合わせの他候補(上下[2,4] / 左右[5,6] / たたく[2] / 2倍[2] / 3倍[2] / 上下[4,6])は
    // いずれも劣るか非有意。特にマス2を先に進める案は失敗率が2.4%→4.3%に悪化する。
    if(NN){
      const r = getRollCandidates(NN, t, cfg.trait, false);
      const tg = [3, 4];
      if(r && tg.every(i => ms[i].current < ms[i].zoneLow && ms[i].current + r[r.length-1] <= ms[i].zoneHigh)){
        const rc = getRollCandidates(C4, t - 50, cfg.trait, false);
        if(!(rc && tg.some(i => ms[i].current + r[r.length-1] + rc[rc.length-1] > ms[i].zoneHigh))){
          const mv = mk(NN, tg);
          if(mv) return mv;
        }
      }
    }
    for(const sk of [Y4, NN, SKILLS.find(s=>s.id==='sayuu'), TK]){
      if(!sk || sk.lv > cfg.level) continue;
      const r = getRollCandidates(sk, t, cfg.trait, false);
      if(!r) continue;
      for(const tg of enumerateTargetSets(sk)){
        if(!tg.every(i => ms[i].current < ms[i].zoneLow && ms[i].current + r[r.length-1] <= ms[i].zoneHigh)) continue;
        const rc = getRollCandidates(C4, t - 50, cfg.trait, false);
        if(rc && tg.some(i => ms[i].current + r[r.length-1] + rc[rc.length-1] > ms[i].zoneHigh)) continue;
        const mv = mk(sk, tg);
        if(mv) return mv;
      }
    }
  }

  // --- 加熱: 次の倍加ターンへ乗せる ---
  if(t + 300 <= 2400){
    const after = t + 300;
    if(isPowerUpTurn(after) || isPowerUpTurn(after - 50)) return mk(K, []);
  }
  return null;
}

function stratB(ms,f,t,P,cfg){
  // ---- 戻りで超過を取り戻す(全マスがゾーンに届いた後) ----
  if(cfg.trait === 'modori' && ms.every(m => m.current >= m.zoneLow) && ms.some(m => m.current > m.zoneHigh))
    return modoriRecover(ms, f, t, cfg);
  // ---- 2マス同時の本会心を最優先 ----
  if(P.pairSnipe > 0){
    const ps = pairSnipe(ms, f, t, cfg);
    if(ps) return ps;
  }

  // ---- 会心ターンは本会心の回収に使う ----
  // 会心率が5倍になるこのターンの価値は、本会心を取れる時にしか出ない。
  // 実測では会心ターンの打撃3.77回のうち超4連打ちが1.61回を占め、
  // 会心1.97回を発生させながら本会心は0.44回(22%)しか拾えていなかった。
  // 捕捉できる見込みがあるマスがあるなら、狙い打ち系を優先する。
  if(P.boostAim > 0 && isBoostTurn(t)){
    const cand = moves(ms, f, t, cfg);
    let bA = null, bV = -1;
    for(const x of cand){
      if(!x.sk.crit || !x.sk.key || f < x.c) continue;
      const tg = x.tg.filter(i => ms[i].current < ms[i].zoneLow);
      if(!tg.length) continue;
      if(!getRollCandidates(x.sk, t, cfg.trait, false)) continue;
      let sum = 0;
      for(const i of tg){
        const r = rollsForMass(x.sk, t, cfg.trait, i);
        if(!r) continue;
        const m = ms[i], zn = m.zoneHigh - m.zoneLow + 1;
        let c = 0;
        for(const rv of r){
          const reach = m.current + 2*rv; let n = 0;
          for(let id = m.zoneLow; id <= m.zoneHigh; id++) if(id > m.current && id <= reach) n++;
          c += (n/zn)/r.length;
        }
        sum += c;
      }
      if(sum / tg.length < P.boostAim) continue;      // 捕捉の見込みが薄いなら見送る
      // 残るマスを仕上げる集中力を確保できる時だけ撃つ
      const rest = ms.filter(m => m.current < m.zoneLow).length - tg.length;
      if(f - x.c < rest * (P.boostRes === undefined ? 24 : P.boostRes)) continue;
      const cr = tg.reduce((a,i)=>a+critForMass(x.sk, cfg, t, i), 0) / tg.length;
      const v = sum * cr / x.c;
      if(v > bV){ bV = v; bA = x; }
    }
    if(bA) return bA;
  }

  // ---- 成立している狙い打ちを拾う(会心ターンの無い素材向け) ----
  // たたき変化には会心率が上がるターンが無いため、上の boostAim が一度も働かない。
  // 実測では狙い打ちが成立する局面が8.82手/gameあり、そのうち5.17手を別の手に
  // 使っていた。集中力不足は0.15手、温度計画上やむを得ない局面は0手だったので、
  // 制約ではなく評価で負けているだけと判断した。
  if(P.aimNow > 0 && cfg.trait !== 'shuchu'){
    const cand = moves(ms, f, t, cfg);
    let bA = null, bV = -1;
    for(const x of cand){
      if(!x.sk.crit || !x.sk.key || f < x.c) continue;
      const tg = x.tg.filter(i => ms[i].current < ms[i].zoneLow);
      if(!tg.length) continue;
      if(!getRollCandidates(x.sk, t, cfg.trait, false)) continue;
      // 本会心が成立する距離にあるか(最大ロールで届き、2倍で越えられる)。
      // 点灯マスはロールが2倍なので成立帯も変わる。マスごとに引く。
      if(!tg.every(i => {
        const r = rollsForMass(x.sk, t, cfg.trait, i);
        if(!r) return false;
        const d = ms[i].zoneHigh - ms[i].current;
        return d >= r[r.length-1] && d <= 2*r[0];
      })) continue;
      // 残るマスを仕上げる集中力を確保できる時だけ撃つ
      let restAdv = 0, restN = 0;
      for(let i=0;i<ms.length;i++){
        if(x.tg.indexOf(i) >= 0) continue;
        const d = ms[i].zoneLow - ms[i].current;
        if(d > 0){ restAdv += d; restN++; }
      }
      const need = Math.max(restN * (P.mpm === undefined ? 16 : P.mpm),
                            restAdv / (P.effK === undefined ? 4 : P.effK))
                 * (P.aimRes === undefined ? 1 : P.aimRes);
      if(f - x.c < need) continue;
      const cr = tg.reduce((a,i)=>a+critForMass(x.sk, cfg, t, i), 0) / tg.length;
      const v = tg.length * cr / x.c;
      if(v > bV){ bV = v; bA = x; }
    }
    if(bA) return bA;
  }

  // ---- たたき変化の開幕定跡 ----
  if(P.opening > 0 && cfg.trait === 'tataki'){
    const open = tatakiOpening(ms, f, t, cfg);
    if(open) return open;
  }

  // ---- 会心ターン活用モード ----
  // 集中力に余裕があり、全未到達マスを会心ターンで仕留める計画が
  // 成立する局面では、その計画に沿って動く。
  // 通常ターンで狙い打ちを撃つと会心率36%だが、会心ターンまで待てば57%。
  // ただし温度が下がるとロール値が落ち、届かなくなるマスが出るため、
  // 「どのマスをどの会心ターンで仕留めるか」まで含めて検算した上で発動する。
  // 計画が成立しない(集中力が足りない等)なら、以降の通常評価に落ちる。
  if(P.boostPlan > 0){
    const bp = buildBoostPlan(ms, f, t, cfg);
    if(bp){
      const step = bp.seq[0];
      if(step){
        if(step.type === 'kill'){
          // 今この温度で仕留められるマスがある
          const sets = enumerateTargetSets(step.sk).filter(g =>
            g.includes(step.mass) && g.every(i => ms[i].current < ms[i].zoneLow));
          if(sets.length){
            const c = actualCostOf(step.sk, t, cfg.trait);
            if(c <= f) return {sk: step.sk, tg: sets[0], c, nt: Math.max(0, t + step.sk.tempDelta), overP: 0};
          }
        } else {
          // 次の会心ターンへ温度を下げる
          const hiya = SKILLS.find(s => s.id === 'hiyashikomi' && s.lv <= cfg.level);
          if(hiya && t - step.to >= 300){
            const c = actualCostOf(hiya, t, cfg.trait);
            if(c <= f) return {sk: hiya, tg: [], c, nt: Math.max(0, t - 300), overP: 0};
          }
          // 端数は、未到達マスを進めすぎない最安の打撃で刻む
          let pick = null, pc = Infinity;
          for(const s of SKILLS){
            if(s.lv > cfg.level || s.masses !== 1 || s.id === 'midare') continue;
            if(s.tempDelta !== -50) continue;
            const c = actualCostOf(s, t, cfg.trait);
            if(c < pc){ pc = c; pick = s; }
          }
          if(pick && pc <= f){
            // 進めても計画が崩れないマスを選ぶ(最も遅れているマス)
            const r = getRollCandidates(pick, t, cfg.trait, false);
            let idx = -1, worst = -1;
            for(let i = 0; i < ms.length; i++){
              if(ms[i].current >= ms[i].zoneLow) continue;
              if(r && ms[i].current + r[r.length-1] > ms[i].zoneHigh) continue;   // 超過させない
              const gap = ms[i].zoneLow - ms[i].current;
              if(gap > worst){ worst = gap; idx = i; }
            }
            if(idx >= 0) return {sk: pick, tg: [idx], c: pc, nt: Math.max(0, t - 50), overP: 0};
          }
        }
      }
    }
  }

  const mv=moves(ms,f,t,cfg);
  if(mv.length===0)return null;
  const need=needTotal(ms);
  const steps=Math.floor(t/50);
  // 消費半減ターン(400の倍数)では重い技が半額で撃てる。
  // ここで火力上げを使うのは、その機会を捨てることになる。
  // 打撃で前進できる場面なら、火力上げは半減ターン以外に回す。
  // ただし温度が本当に足りない時は火力上げを優先する。
  // 半減ターンを守って温度切れになれば元も子もない。
  // 会心+400%ターン(200の倍数)で火力上げを撃つのは無駄。
  // 消費が1.5倍になるうえ、火力上げは会心の恩恵を一切受けないため。
  // 一方、消費半減ターン(400の倍数)なら火力上げも半額で撃てるので問題ない。
  // ただし温度切れが目前なら、機会損失より到達を優先する。
  const urgentHeat = need/28 > steps-3;
  // 除外するのは会心+400%ターンのみ。
  // 半減ターンは火力上げ自体も半額(消費5)で撃てるので、むしろ有利。
  const specialTurn = isBoostTurn(t) && !urgentHeat
                      && ms.some(m=>m.current<m.zoneLow);

  // 温度が足りなければ火力上げ
  if(!specialTurn && need/28 > steps-P.heat && t < (P.tmax||2200)){
    const k=mv.find(x=>x.sk.id==='karyoku');
    if(k)return k;
  }

  // 到達は絶対条件。未到達マスを全部ゾーンに入れるのに必要な集中力を見積もり、
  // それを下回る余剰しかない場合は、会心狙いをやめて最安の確実な手に切り替える。
  // (実測では弱ねらい打ちを連打して残り1で集中力が尽きる失敗が多発していた)
  let reserve=0;
  for(let mi=0; mi<ms.length; mi++){
    const m=ms[mi];
    if(m.current>=m.zoneLow) continue;
    const gap=m.zoneLow-m.current;
    // そのマスをゾーンに入れられる最安の手を探す
    let cheapest=Infinity;
    for(const sk of SKILLS){
      if(sk.lv>cfg.level||sk.masses===0||sk.id==='midare')continue;
      const c=actualCostOf(sk,t,cfg.trait);
      const r=rollsForMass(sk,t,cfg.trait,mi);
      if(!r)continue;
      // 最小ロールで届き、最大ロールで超過しないこと
      if(m.current+r[0]>=m.zoneLow && m.current+r[r.length-1]<=m.zoneHigh){
        cheapest=Math.min(cheapest,c);
      }
    }
    if(!isFinite(cheapest)){
      // 一撃で入らないなら、必要打数ぶんの概算
      let bestEff=0, cost1=8;
      for(const sk of SKILLS){
        if(sk.lv>cfg.level||sk.masses===0||sk.id==='midare')continue;
        const r=rollsForMass(sk,t,cfg.trait,mi);
        if(!r)continue;
        const c=actualCostOf(sk,t,cfg.trait);
        const e=((r[0]+r[r.length-1])/2)/c;
        if(e>bestEff){bestEff=e;cost1=c;}
      }
      cheapest = bestEff>0 ? Math.ceil(gap/bestEff) : gap;
    }
    reserve += cheapest;
  }
  const spare = f - reserve;          // 会心狙いに使える余剰
  const tight = spare < 0;            // 到達すら危うい

  let best=null,bs=-1;
  for(const x of mv){
    if(x.sk.masses===0){
      if(x.cooling){
        const sc=1.2+((isHalfTurn(x.nt)||isBoostTurn(x.nt))?P.land:0);
        if(sc>bs){bs=sc;best=x;}
        continue;
      }
      continue;
    }
    const r=getRollCandidates(x.sk,t,cfg.trait,false);
    // 会心率はマスごとに critForMass で引く(技単位の値を使うと点灯マスを見誤る)
    let adv=0,cap=0,prio=0;
    for(const i of x.tg){
      const m=ms[i];
      // 点灯マスはロールも会心率も違う
      const rI=rollsForMass(x.sk,t,cfg.trait,i) || r;
      const v=rI[Math.floor(rI.length/2)];
      adv+=Math.min(v,m.zoneLow-m.current);
      // 多マス技の対象になりにくいマスは最後に取り残され、
      // 低温・低集中力で処理する羽目になって誤差が膨らむ。
      // 残り距離が大きいマスほど優先して片付ける。
      prio += (m.zoneLow-m.current)/Math.max(1,m.zoneLow);
      // 会心が理想値を捉える確率。
      // 「会心の伸びが理想値を通過する」割合なので、これがそのまま
      // 本会心になる見込みを表す。ゾーンから遠ければ自然に0に近づく。
      const zn=m.zoneHigh-m.zoneLow+1;
      let c2=0;
      for(const rr of rI){const reach=m.current+2*rr;let n=0;
        for(let id=m.zoneLow;id<=m.zoneHigh;id++)if(id>m.current&&id<=reach)n++;
        c2+=(n/zn)/rI.length;}
      // 会心率もマス単位で掛ける。点灯マスは +500% で技単位の値の6倍になる。
      // (ロールだけマス単位にして会心率を技単位のままにしていたため、
      //  点灯マスの最大の価値=高確率で理想値ちょうどに止まることが評価に出ず、
      //  エンジンが点灯マスを避けているように見えていた)
      cap+=critForMass(x.sk,cfg,t,i)*c2;
    }
    // 次が特殊温度になるかを評価に入れる
    const landBonus=(isHalfTurn(x.nt)||isBoostTurn(x.nt))?P.land:0;
    // 会心を捉える価値を主軸に、前進効率と特殊温度到達を加える
    // 余剰が無い局面では会心を狙わず、到達を確実にする手を選ぶ。
    // 高コストの狙い打ちは、余剰で賄える時だけ価値がある。
    // 実測では、余剰がほぼ無いのに弱ねらい打ち(消費20〜30)を連打して
    // 残り1〜7で集中力が尽きる失敗が支配的だった。
    // 「その手を打った後も、残る全マスを最安手で入れ切れるか」を厳格に判定する。
    const afterCost = f - x.c;
    // 残るマス数 × 最安の一撃(温度が下がると変わるので保守的に8とみなす)
    let openAfter = 0;
    for(let i=0;i<ms.length;i++){
      if(ms[i].current>=ms[i].zoneLow) continue;
      // この手で入る見込みがあるマスは除く
      if(x.tg.includes(i)){
        const r3=rollsForMass(x.sk,t,cfg.trait,i);
        if(r3 && ms[i].current+r3[0]>=ms[i].zoneLow) continue;
      }
      openAfter++;
    }
    // 未到達1マスあたりに残しておく集中力。実測で16が最適(失敗率を有意に下げ、大成功率は不変)
    const MIN_PER_MASS = (P.mpm === undefined ? 16 : P.mpm);
    const safeAfter = afterCost >= openAfter*MIN_PER_MASS;
    const affordable = safeAfter;
    const capW = (tight||!safeAfter) ? 0 : P.cap;
    // 前進効率は「集中力が足りない時にだけ」意味を持つ指標。
    // 余剰が大きい局面では、安くて伸びる技が本会心の価値を押し流してしまうため、
    // 余剰の大きさに応じて効率項の重みを落とす。
    // 残りに必要な集中力の見積り。マス数だけで測ると、まだ遠いマスが多い中盤を
    // 「余裕あり」と誤判定するため、残り前進量そのものから見積もる。
    let restAdv = 0;
    for(let i=0;i<ms.length;i++){
      const d = ms[i].zoneLow - ms[i].current;
      if(d > 0) restAdv += d;
    }
    const effK = (P.effK === undefined ? 4 : P.effK);
    const needF = Math.max(openAfter * MIN_PER_MASS, restAdv / effK, 1);
    const slack = Math.max(0, afterCost - needF);
    // 余剰が確実に見えるのは終盤(残りマスが少ない時)だけ。中盤で緩めると
    // 集中力を使い切って失敗が増えるため、残りマス数で発動を絞る。
    const slackOn = openAfter > 0 && openAfter <= (P.slackMax === undefined ? 1 : P.slackMax);
    const advW  = slackOn ? P.adv / (1 + (P.slack||0) * slack / needF) : P.adv;
    // ゾーンに確実に入る手(最小ロールで届き最大ロールで超えない)を優遇
    let sureIn=0;
    {
      for(const i of x.tg){
        const r2=rollsForMass(x.sk,t,cfg.trait,i);
        if(!r2) continue;
        const m=ms[i];
        if(m.current+r2[0]>=m.zoneLow && m.current+r2[r2.length-1]<=m.zoneHigh) sureIn++;
      }
    }
    // 会心率が上がるターンは消費も1.5倍になるため、
    // 会心そのものに価値があるわけではない。
    // 価値があるのは「本会心ゾーンにいるマスを、会心で理想値ちょうどに止める」時だけ。
    // ゾーンから遠いマスに会心が出ても、ただ2倍伸びるだけで大成功には寄与しない。
    //
    // 逆に、本会心ゾーンに入っているマスを通常技で撃つのは機会損失になる。
    // 実測では1ゲームあたり1.6回もこの取りこぼしが起きていた。
    // 誤差0のマスを4つ揃えれば大成功率は81%に達するため、
    // 本会心ゾーンのマスは狙い打ち系で仕留めることを強く優先する。
    let turnEff = 0;
    if(x.sk.masses>0 && x.sk.key){
      let pinkVal = 0;
      for(const i of x.tg){
        const m = ms[i];
        if(m.current >= m.zoneLow) continue;
        // 点灯マスはロール2倍・会心率+500%なので、本会心の成立帯も価値もマスごとに違う。
        const rP = rollsForMass(x.sk, t, cfg.trait, i) || r;
        const critRate = critForMass(x.sk, cfg, t, i);
        // 今まさに使おうとしている技で、この位置から本会心が成立するか。
        // 判定は技ごとに行う(倍率が違えば成立範囲も違うため)。
        if(m.current + rP[rP.length-1] > m.zoneHigh) continue;      // 条件1:はみ出す
        if(m.current + 2*rP[0] < m.zoneHigh) continue;    // 条件2:会心でも届かない

        // 成立していても、位置によって価値は大きく違う。
        // 外した時にゾーン手前で止まれば撃ち直せるが、
        // ゾーン内に着弾すると誤差がその場で確定してしまう。
        // 実測では同じ本会心ゾーン内でも期待誤差が1.18〜6.36と5倍以上開くため、
        // 二値で数えず、期待誤差の小ささを価値として使う。
        let e = 0, n = 0;
        for(let id = m.zoneLow; id <= m.zoneHigh; id++){
          for(const rv of rP){
            const land = m.current + rv;
            const inZ = land >= m.zoneLow && land <= m.zoneHigh;
            const eN = massError(land, id, m.zoneLow, m.zoneHigh);
            e += (1 - critRate) * eN;   // 会心なら誤差0なので加算しない
            n++;
          }
        }
        const expErr = e / n;
        // 会心率をマスごとに掛けてから足す。全マス同じ会心率なら従来の
        // 「会心率 × 合計」と同じ値になるので、既存2商材の評価は変わらない。
        pinkVal += critRate * Math.max(0, MAX_ERR - expErr) / MAX_ERR;   // 誤差が小さいほど高評価
      }
      // ゾーン幅によって狙い打ちの価値が変わる。
      // 幅11のマスは中央に入れても誤差4が出るため、本会心で誤差0にする価値が高い。
      // 幅7のマスは中央着弾で誤差3以下に収まるので、高コストの狙い打ちは割に合わない。
      // (実プレイヤーも「本会心を狙うのは幅11の3箇所」としている)
      // 幅11の3マスだけ本会心を取れば期待誤差5.14で大成功圏に入る。
      let widthW = 1;
      if(P.wideAim > 0){
        let wide = 0, narrow = 0;
        for(const i of x.tg){
          const m = ms[i];
          if(m.current >= m.zoneLow) continue;
          if(m.zoneHigh - m.zoneLow + 1 >= 10) wide++; else narrow++;
        }
        if(wide + narrow > 0) widthW = (wide * P.wideAim + narrow) / (wide + narrow);
      }
      // 幅11のマス(A・D・E)は本会心の価値が高いが、
      // A と E は2マス技のペア相手が限られ(A:[AB][AC] E:[EF][CE])、
      // 相手の必要前進量が大きく離れるため同時に本会心圏へ入れにくい。
      // 実測では本会心圏での射撃が A/E は38%、他マスは50%前後だった。
      // 単発のねらい打ちで拾えるよう、これらへの狙いを後押しする。
      // 幅11マスへの単発優遇(lone)は検証で効果なしと判明したため撤去した。
      turnEff = pinkVal / x.c * P.te * widthW;

    }







    // ---- 飛び込み抑制 ----
    // 実測では、ゾーンに入ったマスの56%が「遠方から一気に飛び込んだ」もので、
    // 撃ち直し圏を経由したのはわずか1.5%だった。
    // 本会心ゾーンに"置く"ことを加点しても、そもそも通過せず飛び越えているため効かない。
    // そこで逆に、まだ撃ち直し圏より手前にいるマスを、
    // 会心の見込みなくゾーンへ押し込む手を抑制する。
    let rushPenalty = 0;
    if(x.sk.masses>0 && x.sk.key && P.rush>0 && !x.sk.crit){
      const rt4 = getRollCandidates(SKILLS.find(s=>s.id==='tataku'), t, cfg.trait, false);
      if(rt4){
        for(const i of x.tg){
          const m = ms[i];
          if(m.current >= m.zoneLow) continue;
          // 本会心を狙える位置の下限(技ごとに求めた範囲の和)
          const cz2 = critZoneRange(m.zoneLow, m.zoneHigh, t, cfg.level, cfg.trait, i);
          if(!cz2) continue;
          const rlo = cz2[0];
          if(m.current >= rlo) continue;      // 既に圏内なら関係ない
          // この手でゾーンに飛び込んでしまう確率(=会心チャンスを失う)
          let jump = 0;
          const rJ = rollsForMass(x.sk, t, cfg.trait, i) || r;   // 点灯マスは2倍で飛び込みやすい
          for(const rv of rJ){ if(m.current + rv >= m.zoneLow) jump++; }
          rushPenalty += jump / rJ.length;
        }
      }
    }
    turnEff -= rushPenalty * P.rush;


    // ---- 特殊温度への到達(案B) ----
    // 実測では手番の59%が特性の乗らない通常ターンだった。
    // 熱風おろし(-150)と通常打撃(-50)を組み合わせれば -200 で
    // 2手ごとに特殊温度へ行けるので、その回数自体を増やす価値がある。
    let turnVal = 0;
    if(P.turn>0){
      const nt = x.nt;
      if(isBoostTurn(nt) || isHalfTurn(nt)) turnVal += 1;
      else {
        // 次の一手で特殊温度に届くなら、それも評価する
        for(const s2 of SKILLS){
          if(s2.lv>cfg.level || s2.id==='midare') continue;
          const n2 = Math.max(0, nt + s2.tempDelta);
          if(n2>0 && (isBoostTurn(n2) || isHalfTurn(n2))){ turnVal += 0.4; break; }
        }
      }
    }
    turnEff += turnVal * P.turn;

    // ---- 威力2倍ターンへ運ぶ(たたき変化) ----
    // 実測では威力2倍ターンの前進効率が13.03、通常ターンが3.43で3.8倍の差がある。
    // それなのに2倍ターンで撃てている打撃は4.03回/game しかない。
    // isBoostTurn/isHalfTurn は集中力変化専用なので、上の turn 評価は
    // たたき変化では一度も働いていなかった。ここで別に評価する。
    if(P.x2turn > 0 && cfg.trait === 'tataki'){
      let v = 0;
      if(isPowerUpTurn(x.nt)) v = 1;
      else {
        // 次の一手で威力2倍に届くなら、その手前として評価する
        for(const s2 of SKILLS){
          if(s2.lv > cfg.level || s2.id === 'midare') continue;
          const n2 = Math.max(0, x.nt + s2.tempDelta);
          if(n2 > 0 && n2 % 400 === 0){ v = 0.4; break; }
        }
      }
      // まだ遠いマスが多いほど、前進の主戦場を2倍ターンへ寄せる価値が高い
      let far = 0;
      for(const m of ms) if(m.current < m.zoneLow) far += m.zoneLow - m.current;
      turnEff += v * P.x2turn * Math.min(1, far / 400);
    }

    // ---- たたき変化への対応 ----
    // この特性では威力そのものが変わる(400の倍数で2倍、その中間で半減)。
    // 威力2倍ターンは遠いマスを一気に詰めるのに向き、
    // 威力半減ターンはゾーン間近の微調整に向く。
    // 温度によって「今どちらの用途に適した局面か」が変わるため、
    // マスの残り距離と噛み合っているかを評価する。

    if(P.tatakiFit>0 && x.sk.masses>0 && x.sk.key){
      let fit = 0;
      const up = isPowerUpTurn(t), down = isPowerDownTurn(t);
      if(up || down){
        for(const i of x.tg){
          const m = ms[i];
          if(m.current >= m.zoneLow) continue;
          const gap = m.zoneLow - m.current;
          const mean = (r[0] + r[r.length-1]) / 2;
          // 旧実装は「残り距離が平均ロールの1.5倍を超えるか」で判定していたため、
          // 威力の大きい技ほど平均ロールが大きくなり、常に減点される欠陥があった。
          // (実測では倍加ターンで超4連が一度も選ばれず、4連打ちに負けていた)
          // 倍加ターンの価値は「大技を安全に撃てること」なので、
          // 超過しない範囲でどれだけ前進できるかで評価する。
          if(up){
            const over = m.current + r[r.length-1] > m.zoneHigh;
            fit += over ? -1 : Math.min(1, mean / Math.max(1, gap));
          }
          if(down) fit += gap < mean*2.5 ? 1 : -0.3;   // 半減は近いマス向き
        }
      }
      turnEff += fit * P.tatakiFit;
    }

    // ---- 着弾位置の最適化 ----
    // 会心で理想値を捉えられない場合でも、ゾーン内のどこに着弾するかで
    // 期待誤差が変わる(幅11なら端3.09、中央2.55)。
    // 実測では着弾がゾーン全体にほぼ均一に散らばっており、
    // 6マス合計で理論最良13.61に対し15.09と1.48損していた。
    // 誤差0が3マスの局面では、この差が大成功の可否を分ける。
    // 幅7のマスは中央着弾で誤差3以下に収まる(幅11は中央でも誤差4)。
    // 狙い打ちに頼らず中央へ入れるだけで大成功圏に近づくため、
    // 狭いゾーンほど着弾位置の最適化を重く見る。
    let center = 0;
    if(P.center>0 && x.sk.masses>0 && x.sk.key){
      for(const i of x.tg){
        const m = ms[i];
        if(m.current >= m.zoneLow) continue;
        // 本会心が成立する位置なら、会心で誤差0を狙う方が優先。
        // 着弾位置の最適化は「会心では捉えられない」場合の次善策なので、
        // 本会心を狙える局面では評価しない(競合して会心狙いを潰すため)。
        const rC = rollsForMass(x.sk, t, cfg.trait, i) || r;     // 点灯マスは2倍
        if(m.current + rC[rC.length-1] <= m.zoneHigh && m.current + 2*rC[0] >= m.zoneHigh) continue;
        // さらに「この一手でゾーンに入る」場合だけに限定する。
        // 遠い位置から中央を狙おうとすると、多マス技で一度に進める効率を捨てて
        // 集中力が足りなくなる(実測で確認)。
        // ゾーンに入る最後の一手なら、他マスへの影響なく位置を選べる。
        if(m.current + rC[0] < m.zoneLow) continue;
        // この技のロールごとに、着弾位置の期待誤差を平均する
        let sum = 0, cnt = 0;
        for(const rv of rC){
          const land = m.current + rv;
          if(land < m.zoneLow || land > m.zoneHigh) continue;   // ゾーン外は別評価
          let e = 0, n = 0;
          for(let id = m.zoneLow; id <= m.zoneHigh; id++){
            e += Math.min(Math.abs(land - id), MAX_ERR); n++;
          }
          sum += e/n; cnt++;
        }
        if(cnt > 0){
          // ゾーン内に入るロールの割合が高く、その期待誤差が小さいほど良い
          const avgErr = sum / cnt;
          const inRate = cnt / r.length;
          center += (MAX_ERR - avgErr) * inRate;
        }
      }
    }
    turnEff += center * P.center;

    // ---- 消費半減ターンの活用 ----
    // 半減ターンの価値は「本来高コストな技を安く撃てる」点にある。
    // ただし節約額だけで加点すると、本会心が成立しない位置でも
    // 狙い打ち系(節約額が大きい)を選んでしまう。
    // 実測では狙い打ち6回中3回が本会心圏外で撃たれ、集中力43を空費していた。
    // 価値があるのは「撃つべき技が、たまたま半減ターンで安い」時だけなので、
    // その技を撃つ意味がある場合に限って節約額を評価する。
    if(isHalfTurn(t) && x.sk.masses>0){
      let worth = false;
      if(x.sk.crit){
        // 狙い打ち系は、会心が理想値を捉える見込みがある時に意味がある。
        // 「最大ロールでもゾーンをはみ出さない」ことまで求めると、
        // ゾーン直前まで詰めたマスでは、どの技を使ってもはみ出す局面で
        // 狙い打ちだけが失格になる。判定は cap 項と同じ捕捉確率に揃える。
        const th = (P.saveCap === undefined ? 0.7 : P.saveCap);
        for(const i of x.tg){
          const m = ms[i];
          if(m.current >= m.zoneLow) continue;
          const zn = m.zoneHigh - m.zoneLow + 1;
          let c3 = 0;
          for(const rv of r){
            const reach = m.current + 2*rv; let n = 0;
            for(let id = m.zoneLow; id <= m.zoneHigh; id++) if(id > m.current && id <= reach) n++;
            c3 += (n/zn)/r.length;
          }
          if(c3 >= th){ worth = true; break; }
        }
      } else {
        // 通常技は前進が仕事なので、未到達マスを叩けるなら意味がある
        worth = x.tg.some(i => ms[i].current < ms[i].zoneLow);
      }
      if(worth) turnEff += ((x.sk.cost - x.c) / 10) * P.save;
    }

    // ---- 会心+400%ターンの活用(案A) ----
    // 半減ターンと対になる考え方。会心率が5倍になるこのターンの価値は、
    // 「本会心ゾーンにいるマスを狙い打って仕留める」時にしか発揮されない。
    // 実測では会心ターンの58%が本会心ゾーンを狙えておらず、
    // 最多の超4連打ちに至っては一度も狙えていなかった。
    // そこで、狙い打ち系で本会心ゾーンを撃つ手を強く優先し、

    // ---- 特殊温度への到達(案B) ----
    // 実測では全手数の59%が特性の乗らない通常ターンだった。
    // 熱風おろし(-150)と通常打撃(-50)を組み合わせれば2手で次の特殊温度に届くので、
    // 通常ターンにいる間は、次が特殊温度になる手を優先して特殊ターンの回数を増やす。
    // 局面ごとに重みを切り替える案は検証したが、
    // 単体テストでは有効に見えても実プレイでは前進が止まり到達率が落ちた。
    // 到達は大成功の絶対条件なので、重みは全局面で共通とする。
    // ゾーンが遠いマスほど到達に手数がかかる。
    // 超あまつゆのいとの B・F は必要前進量が245と最大なのに、
    // 4マス技[ABCD][CDEF]では片方ずつしか叩けず取り残されやすい。
    // 実測では未到達の91%がこの2マスだった。
    let farBonus = 0;
    if(P.far > 0){
      let maxGap = 0, myGap = 0;
      for(let i = 0; i < ms.length; i++){
        const gp = ms[i].zoneLow - ms[i].current;
        if(gp > maxGap) maxGap = gp;
      }
      for(const i of x.tg){
        const gp = ms[i].zoneLow - ms[i].current;
        if(gp > myGap) myGap = gp;
      }
      if(maxGap > 0) farBonus = (myGap / maxGap) * P.far;
    }
    const score=cap*capW + (adv/x.c)*advW + landBonus + prio*P.pr + farBonus
              + sureIn*(tight?3.0:1.0) + turnEff - (x.overP||0)*P.ov;
    if(RANK) RANK.push({x, s:score});
    if(score>bs){bs=score;best=x;}
  }
  return best;
}

/* ====== 先読み探索(モンテカルロ) ======
   評価関数は代理指標にすぎないので、決定のたびに大成功率そのものを
   ロールアウトで直接推定する。手順は次の通り。
     1. 貪欲エンジンの候補スコアを取り出して上位K手に絞る
     2. 貪欲スコアが独走している局面はMCを省く(実測で44〜66%の手を省ける)
     3. 各候補を「その手を打った後は貪欲で打ち切る」試行でS回評価
     4. 全候補に同じ乱数列を使い、貪欲手との対応のある差を検定
     5. t>MC_TH で有意に上回る候補だけへ乗り換える
   4と5が無いと、候補の推定値の最大値を取る操作で
   「たまたま良く出た手」が選ばれる(winner's curse)。
   実測: S=48では -2.67pt・失敗率0.7%→3.3%と悪化し、S=256で符号が反転した。
   検証: いと +4.42/+4.69pt (t=2.37/2.39)、樹液 +12.90/+6.88pt (t=3.11/2.02)。
   いずれも2系列で採否基準(t>=2かつ別シードで再現)を満たす。 */
// 設定値は決定局面80件(いと)/45件(樹液)を固定し、各候補の真の価値を
// 1000〜1200試行で確定させたうえで、設定ごとの選択ミス(リグレット)を比較して決めた。
//   先読みなし 2.73pt(いと) / 2.20pt(樹液) ← 取れる余地の全量
//   旧設定     2.19pt / 1.61pt   (回収率 20% / 27%)
//   現設定     0.46pt / 0.67pt   (回収率 83% / 70%)
// 最大の損失源はゲートだった。旧設定 GATE=0.05 はいとで64%の局面を省略しており、
// そこで1.65pt/局面を捨てていた。S・Kは大きいほど、THは低いほど良い。
// 実局検証: いと +19.54/+13.64pt (t=2.93/2.24)、樹液 +20.00/+23.91pt (t=2.58/2.72)。
const MC_K = 8, MC_S = 640, MC_GATE = 0.2, MC_TH = 0.5;
// 素材ごとの先読みの設定(PRESETS の mc で上書き)。gate を 0 にすると独走局面でも先読みする。
function mcConf(){
  const p = PRESETS[G.preset], o = (p && p.mc) || {};
  return { K: o.K || MC_K, S: o.S || MC_S, gate: o.gate === undefined ? MC_GATE : o.gate,
           th: o.th === undefined ? MC_TH : o.th };
}
const MC_CHUNK = 32;                 // この件数ごとに描画へ譲る
let RANK = null;
function rankedMoves(ms, f, t, P, cfg, K){
  RANK = [];
  const ret = stratB(ms, f, t, P, cfg);
  let r = RANK; RANK = null;
  // 貪欲エンジンは2マス同時本会心などの優先処理で、評価ループに入る前に手を返すことがある。
  // その場合は候補一覧が空になり先読みが走らない(点灯中の見送り局面の54%がこれだった)。
  // 点灯マスがある局面に限り、返ってきた手を先頭に据えて候補を作り直す。
  if(!r.length && ret && cfg.trait === 'kaishin' && litMassIndex !== null){
    r = [{ x: ret, s: 1 }];
    for(const x of moves(ms, f, t, cfg)) r.push({ x, s: 0 });
  }
  r.sort((a,b)=>b.s-a.s);
  const out = [], seen = new Set();
  out.scores = [];
  for(const e of r){
    const k = e.x.sk.id+'|'+(e.x.tg||[]).join(',');
    if(seen.has(k)) continue;
    seen.add(k); out.push(e.x); out.scores.push(e.s);
    if(out.length >= K) break;
  }
  // 点灯マスを叩く手は、貪欲の評価関数が過小評価するため上位Kに残りにくい。
  // 実測: 安全に叩けるのに見送った局面の46%で、点灯マスの手が候補から漏れていた。
  // その局面で叩いた場合は +5.09pt/局面 良く(叩くほうが3pt以上良い67%、見送りが良い3%)、
  // 先読みは評価する機会すら無かった。評価関数は他商材と共通なので触らず、
  // 候補に加えるだけにして、選ぶかどうかは先読みのロールアウトに任せる。
  out.extra = [];
  if(cfg.trait === 'kaishin' && litMassIndex !== null){
    for(const e of r){
      if(out.extra.length >= 2) break;
      const k = e.x.sk.id+'|'+(e.x.tg||[]).join(',');
      if(seen.has(k)) continue;
      if(!(e.x.tg||[]).includes(litMassIndex)) continue;
      if((e.x.overP||0) > 0) continue;          // 超過しうる手は入れない
      seen.add(k); out.extra.push(e.x);
    }
  }
  return out;
}
let MC_RNG = Math.random;
function mcRand(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
// 1回の試行。first を打ったあとは貪欲手順で打ち切り、大成功なら1を返す。
function mcRollout(ms0, f, t, cfg, first){
  const ms = ms0.map((m,i)=>({ current:m.current, zoneLow:m.zoneLow, zoneHigh:m.zoneHigh,
                               ideal: sampleIdeal(i, m) }));
  let fo = f, to = t, mv = first;
  const saved = simFirstMove, savedLit = litMassIndex;
  for(let s = 0; s < 70; s++){
    if(boardDone(ms, cfg.trait)) break;
    if(to <= 0) break;
    if(s > 0) rollLit(ms, to, cfg.trait, MC_RNG);   // 現在の手番の点灯は既知なので触らない
    if(!mv){ mv = stratB(ms, fo, to, PARAMS, cfg); if(!mv || fo < mv.c) break; }
    // 点灯マスだけ威力2倍・会心率+500%なので、ロールと会心率はマスごとに引く
    if(mv.sk.key) mv.tg.forEach(i=>{
      const m = ms[i];
      if(m.current >= m.zoneLow) return;
      const r  = rollsForMass(mv.sk, to, cfg.trait, i);
      const cr = critForMass(mv.sk, cfg, to, i);
      if(!r) return;
      const roll = r[(MC_RNG()*r.length)|0];
      if(MC_RNG() < cr){ if(m.current < m.ideal) m.current = Math.min(m.current + 2*roll, m.ideal); }
      else m.current += roll;
    });
    fo -= mv.c; to = mv.nt; simFirstMove = false;
    applyModori(ms, to, cfg.trait, MC_RNG);        // 温度が200の倍数になれば戻り
    mv = null;
  }
  simFirstMove = saved; litMassIndex = savedLit;
  let e = 0, rc = 0;
  for(const m of ms){
    if(m.current >= m.zoneLow) rc++;
    e += massError(m.current, m.ideal, m.zoneLow, m.zoneHigh);
  }
  return (rc === GRID_ROWS*GRID_COLS && e <= SUCCESS_THRESHOLD) ? 1 : 0;
}
// 同じ盤面で計算し直すと違う手が出る(実測87.5%)のは助言として不安定なので、
// 乱数の種を盤面・温度・集中力から決めて、同じ局面には同じ答えを返す。
function stateSeed(ms, f, t){
  let h = 2166136261 ^ (f | 0) ^ ((t | 0) << 7);
  for(const m of ms){
    h = Math.imul(h ^ (m.current | 0), 16777619);
    h = Math.imul(h ^ (m.zoneLow | 0), 16777619);
    h = Math.imul(h ^ (m.zoneHigh | 0), 16777619);
  }
  h = Math.imul(h ^ ((G.trait || '').length * 31 + (G.level | 0)), 16777619);
  return h >>> 0;
}
function mcYield(){ return new Promise(r => setTimeout(r, 0)); }

// 探索はメインスレッドを占有するので、MC_CHUNK 件ごとに描画へ譲りながら進める。
// 1手あたり いと約0.5秒 / 樹液約1.6秒 かかるため、固定表示だと止まって見える。
// 先読みの準備。先読みが要らない局面(候補が1つ・貪欲が独走)なら {move} を、
// 要るなら {pool, seedBase} を返す。
function mcPrepare(ms, f, t, P, cfg){
  const mc = mcConf();
  const pool = rankedMoves(ms, f, t, P, cfg, mc.K);
  const extra = pool.extra || [];
  // 評価関数が過小評価した点灯マスの手があるなら、貪欲が独走していても先読みで比べる
  if(!extra.length){
    if(pool.length <= 1) return { move: pool[0] || stratB(ms, f, t, P, cfg) };
    const s0 = pool.scores[0], s1 = pool.scores[1];
    if(mc.gate > 0 && s0 - s1 > mc.gate * Math.max(1, Math.abs(s0))) return { move: pool[0] };
  }
  if(!pool.length) return { move: extra[0] || stratB(ms, f, t, P, cfg) };
  for(const x of extra) pool.push(x);
  return { pool, seedBase: stateSeed(ms, f, t) };
}
// 試行 j0〜j1-1 を回し、候補ごとの「基準手との差」を sd・sd2 に足し込む。
// 試行 j の乱数は seedBase と j だけで決まり、差は -1/0/1 の整数なので、
// 試行をどう分割して(複数の Worker で)足しても合計は完全に一致する。
function mcAccumulate(ms, f, t, cfg, pool, seedBase, j0, j1, sd, sd2){
  const n = pool.length;
  for(let j = j0; j < j1; j++){
    const seed = (seedBase + Math.imul(j, 2654435761)) | 0;
    MC_RNG = mcRand(seed);
    const base = mcRollout(ms, f, t, cfg, pool[0]);
    for(let a = 1; a < n; a++){
      MC_RNG = mcRand(seed);                 // 共通乱数で候補間の差の分散を下げる
      const d = mcRollout(ms, f, t, cfg, pool[a]) - base;
      sd[a] += d; sd2[a] += d*d;
    }
  }
  MC_RNG = Math.random;
}
// 画面と同じスレッドで先読みする版。Worker が使えない時(ファイルを直接開いた時など)と
// 成績テスト(tests/sim.js)はこちらを使う。
async function stratMCAsync(ms, f, t, P, cfg, onProgress){
  const prep = mcPrepare(ms, f, t, P, cfg);
  if(prep.move !== undefined) return prep.move;
  const { pool, seedBase } = prep;
  const n = pool.length, sd = new Array(n).fill(0), sd2 = new Array(n).fill(0);
  const S = mcConf().S;
  for(let j0 = 0; j0 < S; j0 += MC_CHUNK){
    const j1 = Math.min(S, j0 + MC_CHUNK);
    mcAccumulate(ms, f, t, cfg, pool, seedBase, j0, j1, sd, sd2);
    if(onProgress) onProgress(j1, S, n);
    await mcYield();
  }
  return mcPick(pool, sd, sd2);
}

/* ---- Worker との受け渡し ----
   先読みの試行は G の一部と点灯マス・開始直後の判定を読むので、それを丸ごと写す。
   手(move)は技オブジェクトを含むため、技はIDで送って受け側で引き直す。 */
function mcSnapshot(){
  return { G: { trait:G.trait, posts:G.posts, temp:G.temp, focus:G.focus, masses:G.masses, level:G.level,
                hammerId:G.hammerId, star:G.star, preset:G.preset, customThreshold:G.customThreshold },
           lit: litMassIndex, simFirstMove };
}
function mcRestore(snap){
  Object.assign(G, snap.G);
  litMassIndex = snap.lit;
  simFirstMove = snap.simFirstMove;
  setActiveMask(G.masses.map(m => !m.off));
  applyThreshold();
}
function moveToWire(mv){ return { sk: mv.sk.id, tg: mv.tg.slice(), c: mv.c, nt: mv.nt,
                                  overP: mv.overP || 0, cooling: !!mv.cooling }; }
function moveFromWire(w){ const sk = SKILLS.find(s => s.id === w.sk);
  const mv = { sk, tg: w.tg, c: w.c, nt: w.nt, overP: w.overP };
  if(w.cooling) mv.cooling = true;
  return mv; }
function mcPick(pool, sd, sd2){
  const { S, th } = mcConf();
  let bi = 0, bt = 0;
  for(let a = 1; a < pool.length; a++){
    const md = sd[a]/S, vr = sd2[a]/S - md*md;
    const se = Math.sqrt(Math.max(vr, 1e-9)/S);
    const tt = md/se;
    if(tt > th && tt > bt){ bt = tt; bi = a; }
  }
  return pool[bi];
}

/* ====== 理想値の事後分布 ======
   打撃のたびに「打撃前の値・技のロール候補・会心の有無・打撃後の値」から
   理想値の確率分布を絞り込む。会心が通常ロールと同じ値で止まって理想値に
   はまる場合があるため、会心の有無は必ず観測値として受け取る。 */
// 事後分布から理想値を1つ引く。分布が無ければゾーン内の一様乱数に戻す。
function sampleIdeal(i, m){
  const p = (G.posts && G.posts[i] && G.posts[i].length === m.zoneHigh - m.zoneLow + 1)
          ? G.posts[i] : null;
  // MC_RNG は探索・手順生成の中だけ盤面から決めた種で固定されている。
  // 外では Math.random のままなので、ここを MC_RNG にするだけで
  // 「同じ盤面なら同じ答え」が理想値の抽選まで含めて成立する。
  if(!p) return m.zoneLow + Math.floor(MC_RNG()*(m.zoneHigh - m.zoneLow + 1));
  let r = MC_RNG(), acc = 0;
  for(let k=0;k<p.length;k++){ acc += p[k]; if(r <= acc) return m.zoneLow + k; }
  return m.zoneHigh;
}
function freshPost(m){ const n = m.zoneHigh - m.zoneLow + 1; return new Array(n).fill(1/n); }
function ensurePosts(){
  if(!Array.isArray(G.posts) || G.posts.length !== G.masses.length){
    G.posts = G.masses.map(freshPost);
  }
  for(let i=0;i<G.masses.length;i++){
    const need = G.masses[i].zoneHigh - G.masses[i].zoneLow + 1;
    if(!Array.isArray(G.posts[i]) || G.posts[i].length !== need) G.posts[i] = freshPost(G.masses[i]);
  }
}
// red を渡すと、after は「打った後にさらに戻りで減った値」とみなす。
// 戻る量は範囲 red.min〜red.max の一様乱数なので、打った直後の値 after+量 の各場合を平均する。
function updatePost(i, before, rolls, critRate, after, wasCrit, red){
  ensurePosts();
  const m = G.masses[i], lo = m.zoneLow, post = G.posts[i], out = [];
  const amts = [];
  if(red) for(let a = red.min; a <= red.max; a++) amts.push(a); else amts.push(0);
  for(let k=0;k<post.length;k++){
    const v = lo + k;
    let L = 0;
    for(const a of amts){
      const hitAfter = after + a;           // 打った直後の値
      let n1 = 0, n2 = 0;
      for(const r of rolls){
        if(before + r === hitAfter) n1++;
        if(Math.min(before + 2*r, v) === hitAfter) n2++;
      }
      if(wasCrit === true)       L += n2 / rolls.length;
      else if(wasCrit === false) L += n1 / rolls.length;
      else                       L += (1-critRate) * n1 / rolls.length + critRate * n2 / rolls.length;
    }
    out.push(post[k] * L / amts.length);
  }
  const sum = out.reduce((a,b)=>a+b, 0);
  if(sum > 0) G.posts[i] = out.map(x => x / sum);
}

/* ====== 状態から計算条件を取り出す ====== */
function cfgOf(){
  return {level:G.level, hammerId:G.hammerId, star:G.star, trait:G.trait};
}

// ===== 会心ターン活用プランの動的計算 =====
// 所要集中力は局面によって変わる。
//   ・残りマス数、各マスの残り距離
//   ・現在温度から各会心ターンまでの距離
//   ・どのマスがどの会心ターンで仕留められるか
// これらから毎回計算し、収まる場合のみ発動する。

// そのマスをその温度で仕留められる最安の技(なければ null)
function killerAt(m, temp, cfg){
  let best = null, bc = Infinity;
  for(const s of SKILLS){
    if(!s.crit || s.lv > cfg.level) continue;
    const r = getRollCandidates(s, temp, cfg.trait, false);
    if(!r) continue;
    if(m.current + r[r.length-1] > m.zoneHigh) continue;      // はみ出す
    if(m.current + 2*r[0] < m.zoneHigh) continue;    // 会心でも届かない
    // 多マス技を1マスにしか使わないなら割高。1マスあたりで比較する。
    const c = actualCostOf(s, temp, cfg.trait);
    if(c < bc){ bc = c; best = s; }
  }
  return best ? {sk: best, cost: bc} : null;
}

// 現在温度から到達しうる会心ターンを列挙(近い順)
function boostTempsFrom(t){
  const out = [];
  for(let tt = t; tt >= 100; tt -= 50){
    if(tt % 200 === 0 && tt % 400 !== 0) out.push(tt);
  }
  return out;
}

// 温度Aから温度Bへ下げるコスト(冷やし込み優先、端数は最安の打撃で刻む)
function coolCost(from, to, cfg){
  if(from <= to) return {cost: 0, steps: 0};
  const hiya = SKILLS.find(s => s.id === 'hiyashikomi' && s.lv <= cfg.level);
  let cur = from, cost = 0, steps = 0, guard = 0;
  while(cur > to && guard++ < 30){
    const diff = cur - to;
    if(diff >= 300 && hiya){
      cost += actualCostOf(hiya, cur, cfg.trait);
      cur -= 300; steps++;
    } else {
      // 打撃で刻む。最安の単発技(前進してしまうが仕方ない)
      let cheap = Infinity;
      for(const s of SKILLS){
        if(s.lv > cfg.level || s.masses !== 1 || s.id === 'midare') continue;
        if(s.tempDelta !== -50) continue;
        cheap = Math.min(cheap, actualCostOf(s, cur, cfg.trait));
      }
      if(!isFinite(cheap)) return null;
      cost += cheap; cur -= 50; steps++;
    }
  }
  return cur === to ? {cost, steps} : null;
}

// 会心ターンを使い切る計画を立て、総コストを返す。
// 各マスは「仕留められる会心ターンのうち最も遅いもの」に割り当てる。
// 高温でしか撃てないマスを先に処理しないと取りこぼすため。
function buildBoostPlan(masses, focus, temp, cfg){
  if(cfg.trait !== 'shuchu') return null;
  const open = masses.map((m,i)=>({m, i})).filter(x => x.m.current < x.m.zoneLow);
  if(open.length === 0) return null;

  const boosts = boostTempsFrom(temp);
  if(boosts.length === 0) return null;

  // 各マスについて、仕留められる会心ターンを調べる
  const cand = [];
  for(const {m, i} of open){
    const list = [];
    for(const bt of boosts){
      const k = killerAt(m, bt, cfg);
      if(k) list.push({temp: bt, ...k});
    }
    if(list.length === 0) return null;      // どの会心ターンでも仕留められない
    cand.push({i, m, list});
  }

  // 仕留められる機会が少ないマスから順に割り当てる。
  // 機会が1つしかないマスはそこへ固定するしかないため、先に確保する。
  cand.sort((a,b) => a.list.length - b.list.length);
  const assign = new Map();                 // temp -> [{i, cost, sk}]
  for(const c of cand){
    // 割り当て先は「仕留めコスト + そこまでの移動コスト」が最小の会心ターン。
    // 単に最も低温を選ぶと、移動コストが膨らんで成立しなくなる。
    let best = null, bestCost = Infinity;
    for(const opt of c.list){
      // 既にその温度へ行く予定があるなら移動コストは追加で要らない
      const already = assign.has(opt.temp);
      const mv = already ? {cost: 0} : coolCost(temp, opt.temp, cfg);
      if(!mv) continue;
      const total = opt.cost + mv.cost;
      if(total < bestCost){ bestCost = total; best = opt; }
    }
    if(!best) return null;
    if(!assign.has(best.temp)) assign.set(best.temp, []);
    assign.get(best.temp).push({i: c.i, cost: best.cost, sk: best.sk});
  }

  // 温度が高い順に巡り、移動コストと仕留めコストを積む
  const used = [...assign.keys()].sort((a,b) => b - a);
  let cur = temp, total = 0;
  const seq = [];
  for(const bt of used){
    const mv = coolCost(cur, bt, cfg);
    if(!mv) return null;
    total += mv.cost;
    if(mv.steps > 0) seq.push({type: 'move', to: bt, cost: mv.cost});
    cur = bt;
    for(const a of assign.get(bt)){
      total += a.cost;
      seq.push({type: 'kill', mass: a.i, sk: a.sk, cost: a.cost, temp: bt});
      cur -= 50;                            // 撃つたびに温度が下がる
    }
    if(total > focus) return null;
  }
  return {cost: total, seq, spare: focus - total};
}

// 本会心を狙える位置の条件は技ごとに異なる:
//   条件1「その技の最大ロールでもゾーンをはみ出さない」 pos + max ≦ zoneHigh
//   条件2「その技の会心(2倍)最小でゾーン上限まで届く」   pos + 2×min ≧ zoneHigh
// 倍率が違えば成立範囲も変わるため、技を合成して1つの範囲にしてはいけない。
// 例(幅6・1200℃):上下ねらい127〜136 / ねらい133〜141 / 弱ねらい147〜151。
// 上下ねらいの上限を超えても、弱ねらいならまだ本会心を狙える。
// そのマスで本会心を狙える位置の全体範囲(どれか1つでも技が成立する範囲)
// massIdx を渡すと、そのマスが点灯中ならロール2倍で計算する。
// 現在の温度で使うときだけ渡すこと(未来の温度では点灯マスが引き直されるため渡さない)。
function critZoneRange(zoneLow, zoneHigh, temp, level, trait, massIdx){
  let lo = Infinity, hi = -Infinity;
  for(const s of SKILLS){
    if(!s.crit || s.lv > level) continue;
    const r = (massIdx === undefined) ? getRollCandidates(s, temp, trait, false)
                                      : rollsForMass(s, temp, trait, massIdx);
    if(!r) continue;
    const a = zoneHigh - 2*r[0];     // この位置以上なら会心で届く
    const b = zoneHigh - r[r.length-1];       // この位置以下ならはみ出さない
    if(a > b) continue;              // その技では成立しない
    lo = Math.min(lo, a);
    hi = Math.max(hi, b);
  }
  if(!isFinite(lo)) return null;
  return [Math.max(0, lo), hi];
}

/* 地金特性マーク(手順の各手と盤面のバッジに出す)。
   isBoostTurn/isHalfTurn は集中力変化の評価にしか使われないため、
   たたき変化では常に false になる。表示用はこちらで素材ごとに出し分ける。
   手順(buildPlan)に載せるためエンジン側に置く。 */
function traitMark(t){
  if(!traitActive(t)) return null;
  if(G.trait === 'shuchu'){
    if(t%400 === 0) return {k:'half',  l:'◆ 消費半減'};
    if(t%200 === 0) return {k:'boost', l:'★ 会心率+400%'};
  }else if(G.trait === 'tataki'){
    if(t%400 === 0) return {k:'boost', l:'◎ 威力2倍'};
    if(t%200 === 0) return {k:'weak',  l:'▽ 威力1/2'};
  }
  return null;
}
// 手順は先読みのロールアウトそのものから作る。
// 旧実装(buildPlan)はロールの平均値(小数)で盤面を進めていたため、
// 実際には存在しない位置が並び、そこで打てる手が無くなって
// 冷やし込み→火力上げの往復(集中力22を捨てて温度は元通り)が表示されていた。
// 実測: 手順の50.6%が温度操作を含み、5.3%で相殺の往復が出ていた。
// ロールアウトは実際に出うる離散値で進み、勝率を出した根拠そのものなので、
// その最頻経路を手順として見せる。過半を割った時点で打ち切る。
// 手順に出すのは「ロールがある手(マスを叩く手)」を2手まで。
// 温度操作は結果が確定していて新しい情報が出ないため、その手を挟んでも
// 次の推奨手は変わらない。確度は落ちないので、何手続いても表示する。
// 実測の確度: 叩く手は1手目100% / 2手目79% / 3手目60% / 4手目47%。
const PLAN_TRIALS = 200, PLAN_MIN = 0.5, PLAN_MIN_SAMPLE = 8, PLAN_RANDOM = 2;

function tracedRollout(ms0, f, t, cfg, first, out){
  // 乱数は呼び出し側(buildPlan)が盤面から決めた種で固定している
  const ms = ms0.map((m,i)=>({ current:m.current, zoneLow:m.zoneLow, zoneHigh:m.zoneHigh,
                               ideal: sampleIdeal(i, m) }));
  let fo = f, to = t, mv = first;
  for(let s = 0; s < 24; s++){
    if(boardDone(ms, cfg.trait)) break;
    if(to <= 0) break;
    if(!mv){ mv = stratB(ms, fo, to, PARAMS, cfg); if(!mv || fo < mv.c) break; }
    out.push({ key: mv.sk.name + '|' + mv.tg.join(','),
               name: mv.sk.name, tg: mv.tg.slice(), temp: to,
               cost: mv.c, tempAfter: mv.nt, traitOn: !simFirstMove, mk: traitMark(to) });
    // 点灯マスだけ威力2倍・会心率+500%なので、ロールと会心率はマスごとに引く
    if(mv.sk.key) mv.tg.forEach(i=>{
      const m = ms[i];
      if(m.current >= m.zoneLow) return;
      const r  = rollsForMass(mv.sk, to, cfg.trait, i);
      const cr = critForMass(mv.sk, cfg, to, i);
      if(!r) return;
      const roll = r[(MC_RNG()*r.length)|0];
      if(MC_RNG() < cr){ if(m.current < m.ideal) m.current = Math.min(m.current + 2*roll, m.ideal); }
      else m.current += roll;
    });
    fo -= mv.c; to = mv.nt; simFirstMove = false;
    applyModori(ms, to, cfg.trait, MC_RNG);        // 温度が200の倍数になれば戻り
    mv = null;
  }
}

function buildPlan(ms0, cfg, first){
  G.plan = [];
  if(!first) return;
  planFromTraces(ms0, planTraces(ms0, cfg, first, 0, PLAN_TRIALS));
}
// 手順用の試行 i0〜i1-1。試行 i の乱数は盤面と i だけで決まるので、
// 範囲を分けて(複数の Worker で)回し、順に繋げば一度に回した場合と同じになる。
function planTraces(ms0, cfg, first, i0, i1){
  const saved = simFirstMove;
  const seedBase = stateSeed(ms0, G.focus, G.temp) ^ 0x5bf03635;
  const traces = [];
  for(let i = i0; i < i1; i++){
    simFirstMove = isStartState();
    MC_RNG = mcRand((seedBase + Math.imul(i, 2654435761)) | 0);
    const out = [];
    tracedRollout(ms0, G.focus, G.temp, cfg, first, out);
    traces.push(out);
  }
  MC_RNG = Math.random;
  simFirstMove = saved;
  return traces;
}
// 試行の束から最頻の経路を手順(G.plan)にする。束の順番は同点の扱いに効くので変えないこと。
function planFromTraces(ms0, traces){
  G.plan = [];
  let live = traces, rnd = 0;
  for(let s = 0; s < 24; s++){
    const tally = new Map();
    for(const tr of live){
      if(s >= tr.length) continue;
      const e = tally.get(tr[s].key);
      if(e) e.n++; else tally.set(tr[s].key, { n:1, st:tr[s] });
    }
    if(!tally.size) break;
    let best = null;
    for(const v of tally.values()) if(!best || v.n > best.n) best = v;
    const st = best.st;
    const rolls = st.tg.length > 0;                 // マスを叩く手＝ロールがある
    // 1手目は推奨手そのものなので必ず出す。
    if(s > 0){
      if(rolls && rnd >= PLAN_RANDOM) break;        // 叩く手は2手まで
      if(best.n / live.length < PLAN_MIN) break;    // 最頻手が過半を割ったら止める
    }
    G.plan.push({ name:st.name, tg:st.tg.slice(), temp:st.temp, cost:st.cost,
                  tempAfter:st.tempAfter, traitOn:st.traitOn, mk:st.mk });
    if(rolls) rnd++;
    live = live.filter(tr => s < tr.length && tr[s].key === st.key);
    if(live.length < PLAN_MIN_SAMPLE) break;   // 標本が薄いと最頻に意味が無い
    // 威力会心率上昇の地金は200℃の倍数で点灯マスが引き直される。
    // どこが光るかで次の手が変わるので、その温度に着いた手で手順を止め、
    // 点灯マスを選んでもらってから計算し直す。
    // (止めないと、例えば火力上げ4回の先に、点灯を無視した超4連まで並んでしまう)
    if(G.trait === 'kaishin' && st.tempAfter > 0 && st.tempAfter % 200 === 0
       && ms0.some(m => m.current < m.zoneLow)) break;
    // 戻りの地金も同じ。200℃の倍数に着いた手の後で戻りが起き、減る量は乱数なので、
    // その先の手順は当てにならない。入力してもらってから計算し直す。
    // ただし値のあるマスが1つも無い間(始まりの火力上げなど)は減らせないので戻りは起きない。
    if(G.trait === 'modori' && st.tempAfter > 0 && st.tempAfter % 200 === 0
       && (ms0.some(m => m.current > 0) || G.plan.some(p => p.tg.length > 0))) break;
  }
}

