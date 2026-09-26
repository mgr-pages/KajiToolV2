/* =====================================================================
   画面(超素材をつくろう!)
   ・描画、テンキー、設定、保存、起動処理。
   ・計算は engine.js の関数を呼ぶ。engine.js の後に読み込む。
   ===================================================================== */

/* ====== 点灯マスの選択(威力会心率上昇) ====== */
// 点灯マスの選択が必要な局面か。
// 威力会心率上昇の地金は200℃の倍数のたびに未到達マスから1つが光る。
// どのマスが光ったかで威力も会心率も変わるので、選んでもらわないと計算できない。
// 数値の入力待ちが残っている間は、入力を先に済ませてもらう(同時に2つ求めない)。
function needLitPick(){
  if(G.trait !== 'kaishin') return false;
  if(isStartState()) return false;            // 開始直後は地金特性が乗らない
  if(G.temp <= 0 || G.temp % 200 !== 0) return false;
  if(G.pending && G.pending.length) return false;
  if(litMassIndex !== null) return false;
  return G.masses.some(m => !m.off && m.current < m.zoneLow);
}
// 点灯マスを選べる状態か。未選択のときだけでなく、選んだ後も計算するまでは
// 別のマスをタップして選び直せるようにする(押し間違えの取り返しがつくように)。
function litPickMode(){
  if(G.trait !== 'kaishin') return false;
  if(isStartState()) return false;
  if(G.temp <= 0 || G.temp % 200 !== 0) return false;
  if(G.pending && G.pending.length) return false;
  if(G.rec) return false;                     // 計算した後は通常の盤面操作に戻す
  return G.masses.some(m => !m.off && m.current < m.zoneLow);
}
function pickLit(i){
  const m = G.masses[i];
  if(!m || m.off || m.current >= m.zoneLow) return;
  litMassIndex = i;
  G.rec = null; G.plan = [];                  // 点灯が決まると推奨手が変わる
  G.msg = null;                               // 「タップしてください」の案内を消す
  renderAll(); save();
}

/* ====== 描画 ====== */
// バーの最大値(全マス共通)。設定で手入力された値があればそれを使い、
// 無ければ全マスのゾーン上限の最大値に少し余裕を足した値を自動で決める。
function barScaleMax(){
  if(G.barMax && G.barMax > 0) return G.barMax;
  let hi = 0;
  for(const m of G.masses) if(m.zoneHigh > hi) hi = m.zoneHigh;
  return Math.max(50, Math.ceil((hi * 1.15) / 10) * 10);
}

// そのマスについて、バー上の各マーカー位置を求める。
// 推奨技の有無にかかわらず常に表示する(基準técは G.barSkill で切り替え)。
//   緑   = 成功ゾーン
//   ピンク = ここから狙い打てば、会心時に確実に本会心になる範囲
//   青   = 選んだ技を通常ロールで打った時の到達範囲(最小〜最大)
//   赤   = 同じ技で会心(2倍)が出た時の到達範囲(最小〜最大)
//   白   = 現在値
function markersFor(m, skill, massIdx){
  const lo = m.zoneLow, hi = m.zoneHigh;
  // バーの左端は常に0に固定する。ゾーン付近だけを拡大すると
  // 「どこまで進んだか」の実感が持てないため、0からの絶対位置で示す。
  // バーの目盛りは全マス共通にする。
  // マスごとに終点が違うと、同じ長さでも意味が変わって比較できないため。
  // 既定は全マスのゾーン上限のうち最大値に余裕を持たせた値。設定で変更できる。
  const scaleMin = 0;
  const scaleMax = barScaleMax();
  const pct = v => Math.max(0, Math.min(100, (v-scaleMin)/(scaleMax-scaleMin)*100));

  const out = {
    zone:[pct(lo), pct(hi)], cur:pct(m.current),
    pink:null, blue:null, red:null,
    raw:{ lo, hi, cur:Math.round(m.current) }
  };

  // 本会心ゾーン:技ごとに成立範囲が違うので、その和をとる
  const cz = critZoneRange(lo, hi, G.temp, G.level, G.trait, massIdx);
  if(cz){
    out.pink = [pct(cz[0]), pct(cz[1])];
    out.raw.pink = [Math.round(cz[0]), Math.round(cz[1])];
  }

  if(skill && skill.key){
    // 点灯マスは前進量が2倍。共通のロールで描くと、盤面のバーが実際の半分の幅になる
    const r = (massIdx === undefined) ? getRollCandidates(skill, G.temp, G.trait, false)
                                      : rollsForMass(skill, G.temp, G.trait, massIdx);
    if(r){
      const n0=m.current+r[0], n1=m.current+r[r.length-1];
      const c0=m.current+2*r[0], c1=m.current+2*r[r.length-1];
      out.blue = [pct(n0), pct(n1)];
      out.red  = [pct(c0), pct(c1)];
      out.raw.blue = [Math.round(n0), Math.round(n1)];
      out.raw.red  = [Math.round(c0), Math.round(c1)];
    }
  }
  return out;
}

// バー下の数値列。右向き(右列)は 通常最小→通常最大→会心最小→会心最大 の順、
// 左向き(左列)はその鏡像になるよう並べ替える。
function scaleLabel(mk, flip){
  const r = mk.raw;
  if(!G.showRange) return '';
  if(!r.blue) return '<span style="color:var(--dim)">技を選ぶと表示</span>';
  const items = [
    {v:r.blue[0], c:'var(--blue)'},
    {v:r.blue[1], c:'var(--blue)'},
    {v:r.red[0],  c:'var(--red)'},
    {v:r.red[1],  c:'var(--red)'}
  ];
  const arr = flip ? items.slice().reverse() : items;
  return arr.map(x=>`<span style="color:${x.c}">${x.v}</span>`).join('<span style="color:#a89268">〜</span>');
}

function traitNote(){
  if(G.trait === 'shuchu') return `<div class="mk-note">
      <div><b class="mk-boost">★ 会心率+400%</b> 温度が200の倍数(400の倍数を除く)。
           会心率が5倍になる代わりに消費集中力が1.5倍。狙い打ちを撃つ好機。</div>
      <div><b class="mk-half">◆ 消費半減</b> 温度が400の倍数。
           消費集中力が半分になる。超4連打ちなど重い技を撃つ好機。</div></div>`;
  if(G.trait === 'tataki') return `<div class="mk-note">
      <div><b class="mk-boost">◎ 威力2倍</b> 温度が400の倍数。
           前進量が倍になる。超4連打ちなど多マス技を乗せたい。</div>
      <div><b class="mk-weak">▽ 威力1/2</b> 温度が200の倍数(400の倍数を除く)。
           前進量が半分。仕上げの微調整には使えるが、大きく進めたい時は避ける。</div></div>`;
  if(G.trait === 'kaishin') return `<div class="mk-note">
      <div><b class="mk-boost">✦ 点灯</b> 温度が200の倍数。未到達のマスから1つが光る。
           光ったマスだけ威力2倍・会心率+500%。盤面でタップして指定する。</div></div>`;
  return '';
}

function renderBoard(){
  const el = document.getElementById('board');
  const hiTg = G.rec ? G.rec.tg : [];
  // バーの基準技:推奨手が出ていればその技の伸び幅を表示する。
  // まだ計算していない(または温度操作が推奨された)場合は「たたく」を既定とする。
  const skill = (G.rec && G.rec.sk && G.rec.sk.key) ? G.rec.sk
              : SKILLS.find(s=>s.id==='tataku');
  let html = '';
  for(let row=0; row<3; row++){
    html += '<div class="brow">';
    for(let col=0; col<2; col++){
      const i = row*2+col;
      const m = G.masses[i];
      const mk = markersFor(m, skill, i);
      const flip = (col===0);
      const st = m.off ? ''
               : m.current > m.zoneHigh ? 'over'
               : m.current >= m.zoneLow ? 'done' : '';
      const pick = litPickMode();
      const pickable = pick && !m.off && m.current < m.zoneLow;
      const cls = (m.off ? ' off' : '')
                + (!m.off && hiTg.includes(i)?' hi':'') + (st?' '+st:'')
                + (!m.off && G.pending.includes(i)?' need':'')
                + (pickable ? ' litpick' : '')
                + (pick && !pickable && !m.off ? ' litdim' : '')
                + (litMassIndex === i ? ' lit' : '');
      const zoneTxt = flip ? `${m.zoneHigh} 〜 ${m.zoneLow}` : `${m.zoneLow} 〜 ${m.zoneHigh}`;
      const barBlock = m.off ? `<div class="bar-wrap ${flip?'left':'right'}"></div>` :
        `<div class="bar-wrap ${flip?'left':'right'}">
           <div class="zone-lbl">${zoneTxt}</div>
           ${buildBar(mk, flip)}
           <div class="pw-lbl">${scaleLabel(mk, flip)}</div>
         </div>`;
      const cell =
        `<div class="cell${cls}${G.fx && G.fx.i===i ? ' fx-'+G.fx.k : ''}"${
            m.off ? '' : (pick ? (pickable ? ` onclick="pickLit(${i})"` : '')
                               : ` onclick="openPad('mass',${i})"`)}>
           <div class="idx">マス${i+1}</div>
           <div class="cur">${Math.round(m.current)}</div>
           <div class="zn"><span>${m.zoneLow}</span><span>${m.zoneHigh}</span></div>
         </div>`;
      html += flip ? barBlock+cell : cell+barBlock;
    }
    html += '</div>';
  }
  el.innerHTML = html;
}

function buildBar(mk, flip){
  // マーカーごとに座標を反転させると重なり順や位置がずれるため、
  // 座標計算は常に左→右で行い、左列だけバー全体をCSSでミラーする。
  const band = (a,b,cls) => {
    const lo=Math.min(a,b), hi=Math.max(a,b);
    return `<i class="${cls}" style="left:${lo}%;width:${Math.max(hi-lo,1)}%"></i>`;
  };
  const line = (v,cls) => `<i class="${cls}" style="left:${v}%"></i>`;
  let s = '';
  // 本会心ゾーンを先に敷き、成功ゾーンを上に重ねる。
  // 成功ゾーンの方が判断上重要なので、重なっても必ず見えるようにする。
  if(mk.pink) s += band(mk.pink[0], mk.pink[1], 'm-pink');
  if(mk.zone) s += band(mk.zone[0], mk.zone[1], 'm-green');
  if(G.showRange && mk.blue) s += band(mk.blue[0], mk.blue[1], 'm-blue');
  if(G.showRange && mk.red)  s += band(mk.red[0],  mk.red[1],  'm-red');
  // 現在値は0から今の位置までを塗り、右端に白線を立てる
  s += `<i class="m-cur" style="width:${Math.max(mk.cur,0.5)}%"></i>`;
  s += line(mk.cur,'m-curline');
  return `<div class="bar${flip?' flip':''}">${s}</div>`;
}

const TRAIT_LABEL = {shuchu:'集中力変化', none:'特性なし', tataki:'たたき変化',
                     modori:'メーター減少(未対応)', kaishin:'威力会心率上昇'};
function traitLabel(t){ return TRAIT_LABEL[t] || t; }

function renderHeader(){
  // 複数商材を扱うので、今どれを打っているかを最上段に常時出す
  const sel = document.getElementById('s-preset');
  if(sel && sel.value !== G.preset) sel.value = G.preset;
  // 手動設定のときだけ、使用中のマス数と地金特性をヘッダに出す
  const chip = document.getElementById('v-cust');
  if(chip){
    if(G.preset === 'custom'){
      const on = G.masses.filter(m=>!m.off).length;
      const set = G.masses.some(m=>!m.off && m.zoneHigh > 0);
      chip.textContent = set ? (on + 'マス/' + traitLabel(G.trait)) : '要設定';
      chip.style.display = '';
    }else chip.style.display = 'none';
  }
  const hm = HAMMERS[G.hammerId];
  document.getElementById('v-gear').textContent =
    (hm ? hm.name : G.hammerId) + '★' + G.star + ' / Lv' + G.level;
  document.getElementById('v-temp').textContent = G.temp;
  document.getElementById('v-focus').textContent = G.focus;
  const b = [];
  const tm = traitMark(G.temp);
  if(tm) b.push(`<span class="badge ${tm.k}">${tm.l}</span>`);
  else b.push('<span class="badge off">通常</span>');
  if(isStartState()) b.push('<span class="badge off">開始直後(特性なし)</span>');
  // メーター減少は計算に組み込んでいない。選べるが「特性なし」と同じ手が出ることを明示する
  if(G.trait === 'modori') b.push('<span class="badge weak">メーター減少は未対応(特性なしとして計算)</span>');
  // 到達数・誤差・大成功率は見ても打ち方が変わらないので出さない。
  // 残すのはターン表示(威力2倍/半減)だけ ― 今どの手を打っているかの確認に使う。
  if(G.pending.length) b.push(`<span class="badge wait">数値の入力待ち</span>`);
  else if(needLitPick()) b.push(`<span class="badge wait">光ったマスをタップしてください</span>`);
  else if(litMassIndex !== null)
    b.push(`<span class="badge rate">マス${litMassIndex+1}が点灯中${litPickMode()?'(別のマスをタップで選び直し)':''}</span>`);
  document.getElementById('badges').innerHTML = b.join('');
}

function renderSkills(){
  const rows = ['<tr><th>技</th><th>ロール</th><th class="cst">消費</th><th class="cst">会心</th></tr>'];
  for(const s of SKILLS){
    if(s.lv>G.level || s.id==='midare') continue;
    const r = s.key ? getRollCandidates(s, G.temp, G.trait, false) : null;
    const c = actualCostOf(s, G.temp, G.trait);
    const cr = s.key ? computeCritRate(s,G.level,G.hammerId,G.star,G.trait,G.temp) : 0;
    rows.push(`<tr><td>${s.name}</td><td class="rolls">${r?r.join(' '):'—'}</td>`
      + `<td class="cst">${c}</td><td class="cst">${s.key?(cr*100).toFixed(0)+'%':'—'}</td></tr>`);
  }
  // 表は技ごとなのでマス単位の値を出せない。点灯中はその旨を添えて、表の値を鵜呑みにさせない
  if(G.trait === 'kaishin' && litMassIndex !== null)
    rows.push(`<tr><td colspan="4" style="font-size:11px;color:var(--dim)">`
      + `上は通常マスの値。点灯中のマス${litMassIndex+1}はロール2倍・会心率+500%</td></tr>`);
  document.getElementById('skTable').innerHTML = rows.join('');
}

function renderRec(){
  const el = document.getElementById('rec');
  if(!G.rec){
    el.innerHTML = '<div class="rec-empty">'+(G.msg||'「次の一手を計算」を押してください')+'</div>';
    return;
  }
  const r = G.rec;
  const tgt = r.tg.length ? r.tg.map(i=>'マス'+(i+1)).join('・') : '温度操作';
  const cr = r.sk.key ? computeCritRate(r.sk,G.level,G.hammerId,G.star,G.trait,G.temp) : 0;
  // 点灯マスを含む手は、そのマスだけ会心率が違う。1つの数字に丸めると誤解を招くので分けて出す
  let critTxt = r.sk.key ? ' / 会心'+(cr*100).toFixed(0)+'%' : '';
  if(r.sk.key && G.trait === 'kaishin' && litMassIndex !== null && r.tg.includes(litMassIndex)){
    const crL = critForMass(r.sk, cfgOf(), G.temp, litMassIndex);
    const others = r.tg.filter(i => i !== litMassIndex);
    critTxt = others.length
      ? ` / 会心${(cr*100).toFixed(0)}%(点灯マス${litMassIndex+1}は${(crL*100).toFixed(0)}%・威力2倍)`
      : ` / 会心${(crL*100).toFixed(0)}%(点灯・威力2倍)`;
  }
  // この手を打った後に残る集中力と温度も出す。
  // 仕上げに何発残せるかの判断に直結するため。
  const leftF = G.focus - r.c;
  const warn = leftF < 40 ? ' style="color:var(--ember)"' : '';
  el.innerHTML = `<div class="rec-main">
      <div class="rec-skill">${r.sk.name}</div>
      <div class="rec-sub">${tgt} / 消費${r.c}${critTxt}</div>
      <div class="rec-sub">実行後 → <b${warn}>集中力 ${leftF}</b> / ${r.nt}℃</div>
    </div>`;
  // 下部は画面に固定されているため、ここにボタンや候補を足すと盤面を覆う。
  // 手を進めるのは手順リストの「ここまで実行」、数値の入力はモーダル側で行う。
}

function renderDetail(){
  const el = document.getElementById('detail');
  if(!G.rec && !G.hist.length){ el.textContent='まだ計算していません'; return; }
  let h = '';
  // 打った手の履歴は出さない。取り消しは「直前の反映を取り消す」で足りる。
  if(G.plan.length){
    h += '<div style="color:var(--dim);font-size:11px;margin-bottom:6px">'
       + 'この先の想定手順 — 実際に打ったところのボタンを押すと温度と集中力に反映されます</div>';
    let f = G.focus;
    // 理想値が絞れるのは「会心が理想値ちょうどで止まりうる位置」で叩いた時だけ。
    // 会心で最大まで伸ばしても成功ゾーンに届かない位置なら、結果は理想値と無関係に
    // 決まるので、何手まとめて実行しても失う情報は無い。
    // 逆に届きうる手を含めてまとめると、その分の判定ができなくなる。
    // 途中の値は分からないので、最大ロールの会心が続いた場合の上限で判定する。
    // 判定が壊れるのは、同じマスを2打以上まとめてしまい、なおかつ
    // そのマスが成功ゾーンに入った場合だけ。
    //   1打しか当たっていない → 前後の値が分かるので何手まとめても分解できる
    //   ゾーンに入っていない   → 本会心が起きていないので失う情報が無い
    // 途中の値は分からないので、最大ロールの会心が続いた場合の上限で判定する。
    const ub = G.masses.map(m => m.current);          // 各マスの取りうる最大値
    const cnt = {};                                   // まとめた中で叩いた回数
    const info = []; let cutAt = -1;
    G.plan.forEach((st,i)=>{
      const sk = SKILLS.find(k => k.name === st.name);
      const rr = (sk && sk.key) ? getRollCandidates(sk, st.temp, G.trait, false) : null;
      let lost = false;
      if(rr){
        st.tg.forEach(j => {
          // 点灯が効くのは今の手番(1手目)だけ。以降は温度が変わっていて点灯は引き直される
          const rj = (i === 0) ? (rollsForMass(sk, st.temp, G.trait, j) || rr) : rr;
          const top = 2 * rj[rj.length-1];
          const m = G.masses[j];
          // 手順に載っている時点で、その手番では未到達のマス。
          // 上限値で対象から外すと、まだ遠いマスの打撃回数を数え落とす。
          cnt[j] = (cnt[j] || 0) + 1;
          ub[j] = Math.min(m.zoneHigh, ub[j] + top);
          // 2打目以降で、かつゾーンに入りうるなら判定不能になる
          if(cnt[j] >= 2 && ub[j] >= m.zoneLow) lost = true;
        });
      }
      if(lost && cutAt < 0) cutAt = i;
      info.push({ safe: cutAt < 0 || i < cutAt });
    });
    h += '<div class="plist-body">' + G.plan.map((st,i)=>{
      f -= st.cost;
      const mark = st.mk ? ` <b class="mk-${st.mk.k}">${st.mk.l}</b>` : '';
      const cls  = (st.mk ? ' on-'+st.mk.k : '') + (i===0?' first':'');
      const tg   = st.tg.length ? st.tg.map(x=>'マス'+(x+1)).join('・') : '温度操作';
      const note = '';
      const btn  = f < 0 ? ''
        : `<button class="pexec" onclick="applyExecuted(${i+1})">
             <span class="t">ここまで実行</span>
             <span class="s">${st.tempAfter}℃ / 集中${f}</span>
             ${note}
           </button>`;
      const bar  = (i === cutAt)
        ? '<div class="dup-line">ここまでで数値の入力を推奨</div>' : '';
      return bar + `<div class="pstep${cls}">
          <span class="n">${i+1}</span>
          <div class="pinfo">
            <div class="pname">${st.name}${mark}</div>
            <div class="ptg">${tg}</div>
          </div>${btn}
        </div>`;
    }).join('') + '</div>';
    h += '<div class="plist-note">数値を入力しなくても手順は進められます。'
       + '入力すると次の推奨手の精度が上がります。</div>';
    h += traitNote();
  }
  el.innerHTML = h || '—';
}

function renderAll(){ renderHeader(); renderBoard(); renderSkills(); renderRec();
  renderExec(); renderDetail(); syncCalcButton(); }

// 数値の入力待ち・点灯待ちの間はボタンを押せなくし、何をすべきかをラベルに出す。
// ボタンの状態はここだけで決める(複数箇所で書き換えると後から呼ばれた側が勝ち、
// 入力待ちなのに押せる状態へ戻っていた)。
function syncCalcButton(){
  const btn = document.getElementById('calcBtn');
  if(!btn || CALC_BUSY) return;
  if(G.pending.length){ btn.disabled = true;  btn.textContent = '数値を入力してください'; }
  else if(needLitPick()){ btn.disabled = true;  btn.textContent = '光ったマスをタップしてください'; }
  else                  { btn.disabled = false; btn.textContent = '次の一手を計算'; }
}

/* ====== 実行済みの反映 ======
   実プレイでは推奨手を何手かまとめて打ってから再計算する。
   何手目まで打ったかを選ぶだけで、温度と集中力は自動で差し引く。
   マスの数値だけはゲーム画面を見ないと分からないので、手入力を促す。 */
function renderExec(){
  const el = document.getElementById('execPanel');

  if(G.pending.length){
    const names = G.pending.map(i=>'マス'+(i+1));
    el.innerHTML =
      `<div class="exec"><div class="need-box">
         <div class="t">${names.join('・')} の数値を入力してください</div>
         <div class="d">温度と集中力は反映済みです。ゲーム画面の数値を入れると計算できます。</div>
         <div class="need-row">`
      + G.pending.map(i=>`<button class="need-btn" onclick="openPad('mass',${i})">マス${i+1}</button>`).join('')
      + `</div>`
      + (G.undoSnap ? `<button class="undo-btn" onclick="undoExec()">この反映を取り消す</button>` : '')
      + `</div></div>`;
    return;                                   // 計算ボタンの状態は syncCalcButton が決める
  }

  el.innerHTML = G.undoSnap
    ? `<div class="exec"><button class="undo-btn" onclick="undoExec()">直前の反映を取り消す</button></div>`
    : '';
}

function applyExecuted(k){
  if(!G.plan.length || k<1 || k>G.plan.length) return;
  const steps = G.plan.slice(0, k);
  const cost = steps.reduce((a,x)=>a+x.cost, 0);
  if(cost > G.focus){ alert('集中力が足りません'); return; }

  // 点灯マスは今の手番だけのもの。温度が変わると引き直されるので、実行前に控える。
  // 手順は200℃の倍数で打ち切っているので、点灯が効くのは1手目だけ。
  const litNow = (G.trait === 'kaishin') ? litMassIndex : null;
  // やり直せるように、変更前の状態を控える
  ensurePosts();
  G.undoSnap = { temp:G.temp, focus:G.focus, lit:litMassIndex,
    masses:G.masses.map(m=>({...m})), pending:G.pending.slice(), histLen:G.hist.length,
    posts:G.posts.map(p=>p.slice()), obs:(G.obs||[]).slice() };
  steps.forEach((st, k) => G.hist.push({name:st.name, tg:st.tg.slice(), tempAfter:st.tempAfter,
                                        lit: k === 0 ? litNow : null}));

  G.focus -= cost;
  G.temp   = steps[steps.length-1].tempAfter;

  // 叩いたマスは値が変わっているはずなので、手入力の対象にする。
  // 温度操作だけの手は対象マスが無いので何も増えない。
  // 理想値を絞り込むには「1回の打撃ごとの前後の値」が要る。
  // まとめて実行して同じマスを2回以上叩いた場合は分解できないので、
  // そのマスの推定は諦めて分布を一様に戻す。
  const cnt = {};
  steps.forEach(st => st.tg.forEach(i => { cnt[i] = (cnt[i]||0) + 1; }));
  ensurePosts();
  if(!G.obs) G.obs = new Array(G.masses.length).fill(null);
  let t2 = G.undoSnap.temp;
  const firstOf = {};
  steps.forEach((st, k) => {
    const sk = SKILLS.find(x => x.name === st.name);
    st.tg.forEach(i => {
      if(firstOf[i] === undefined && sk && sk.key){
        // その手の時点の特性状態を再現してから求める。
        // 点灯マスはロール2倍・会心率+500%なので、候補値もその前提で作る。
        // (これを怠ると、点灯マスを叩いた後の選択肢が通常の値しか出ず、正しく入力できない)
        const saved = simFirstMove;
        simFirstMove = (st.traitOn === undefined) ? saved : !st.traitOn;
        const lit = (k === 0 && litNow !== null && i === litNow);
        firstOf[i] = { before: G.masses[i].current,
                       rolls: getRollCandidates(sk, st.temp, G.trait, lit),
                       cr: computeCritRate(sk, G.level, G.hammerId, G.star, G.trait, st.temp, lit),
                       name: st.name, key: sk.key, temp: st.temp, lit,
                       mult: getPowerMultiplier(G.trait, st.temp, lit) };
        simFirstMove = saved;
      }
    });
  });
  const hit = new Set(G.pending);
  steps.forEach(st => st.tg.forEach(i => hit.add(i)));
  for(const i of hit){
    // 2打以上まとめた場合は分解できないので更新を見送るだけ。
    // それまでに絞り込んだ分布は有効なので捨てない。
    if(cnt[i] > 1 || !firstOf[i]) G.obs[i] = null;
    else if(!G.obs[i]) G.obs[i] = firstOf[i];
    else G.obs[i] = null;
  }
  G.pending = [...hit].sort((a,b)=>a-b);

  G.rec = null; G.plan = []; clearLit();
  // 入力するものが無い手(温度操作だけ)なら、そのまま次の一手まで出す
  if(!G.pending.length){ G.msg = null; renderAll(); doCalc(); save(); return; }
  G.msg = '実行分を反映しました';
  renderAll(); save();
}

function undoExec(){
  if(!G.undoSnap) return;
  const u = G.undoSnap;
  G.temp = u.temp; G.focus = u.focus;
  litMassIndex = (typeof u.lit === 'number') ? u.lit : null;
  G.masses = u.masses.map(m=>({...m}));
  G.pending = u.pending.slice();
  if(typeof u.histLen === 'number') G.hist.length = u.histLen;
  // 理想値の分布も戻す。戻さないと、取り消した打撃の観測が残ったままになる
  if(Array.isArray(u.posts)) G.posts = u.posts.map(p=>p.slice());
  if(Array.isArray(u.obs))   G.obs = u.obs.slice();
  G.undoSnap = null;
  G.rec = null; G.plan = []; G.msg = null;
  renderAll(); save();
}

/* ====== 計算 ====== */
let CALC_BUSY = false;
function setCalcProgress(pct, label){
  const btn = document.getElementById('calcBtn');
  const bar = document.getElementById('calcBar');
  if(btn) btn.textContent = label;
  if(bar){
    bar.style.display = (pct === null) ? 'none' : '';
    if(pct !== null) bar.firstChild.style.width = Math.round(pct*100) + '%';
  }
}
async function doCalc(){
  if(CALC_BUSY) return;                       // 探索中の二重押しを防ぐ
  // 叩いたマスの数値が未入力のまま計算すると、打つ前の値で次の手を決めてしまう
  if(G.pending.length){ renderAll(); return; }
  // 点灯マスが未指定のまま計算すると、威力2倍も会心率+500%も乗らない別物の手が出る
  if(needLitPick()){
    G.msg = '光ったマスをタップしてから計算してください';
    renderAll();
    return;
  }
  CALC_BUSY = true;
  const btn = document.getElementById('calcBtn');
  btn.disabled = true;
  setCalcProgress(0, '先読み中 0%');
  await new Promise(r=>setTimeout(r, 20));
  try{
    const cfg = cfgOf();
    const ms = G.masses.map(m=>({current:m.current, zoneLow:m.zoneLow, zoneHigh:m.zoneHigh}));
    if(ms.every(m=>m.current>=m.zoneLow)){
      G.rec=null; G.plan=[]; G.msg='<span style="color:var(--green)">全マス到達 — 仕上げてください</span>';
    } else if(G.temp<=0){
      G.rec=null; G.plan=[]; G.msg='温度切れ';
    } else {
      G.msg=null;
      G.rec = await stratMCAsync(ms, G.focus, G.temp, PARAMS, cfg, (done, total, n)=>{
        setCalcProgress(done/total, `先読み中 ${Math.round(done/total*100)}% (候補${n}手)`);
      });
      setCalcProgress(1, '手順を組み立て中…');
      await new Promise(r=>setTimeout(r, 0));
      buildPlan(ms, cfg, G.rec);
      // 大成功率は表示しなくなったので推定そのものを止める。1手あたり約0.5秒の削減。
      // estimateOutcome のロールアウトは貪欲エンジンで打ち切る。
      // 先読みで選んだ手の実力は反映されないので、表示は「下限の目安」。
      // 300試行だと1回ごとに±3pt前後ブレて44%と52%が交互に出ていたため増やす。
    }
    renderAll();
  }catch(e){
    document.getElementById('rec').innerHTML =
      '<div class="rec-empty">計算に失敗しました: '+e.message+'</div>';
  }
  setCalcProgress(null, '次の一手を計算');
  CALC_BUSY=false; syncCalcButton();
}

/* ====== テンキー ====== */
// 電卓と同じ操作感にする。
//   数字だけ入力して決定 → その値をそのまま設定
//   ＋ / － を押してから数字を入力 → 現在値に加算 / 減算
let padTarget=null, padIdx=null, padOp=null, padBuf='';

// 打撃後に起こりうる値を全て列挙する。結果は必ずこの中のどれかになる。
function candidateValues(idx){
  const ob = G.obs && G.obs[idx];
  if(!ob || !ob.rolls) return null;
  const m = G.masses[idx], b = ob.before;
  const normal = [], crit = [];
  for(const r of ob.rolls){
    if(normal.indexOf(b + r) < 0) normal.push(b + r);
    if(crit.indexOf(b + 2*r) < 0) crit.push(b + 2*r);
  }
  // 会心が理想値ちょうどで止まる場合。値はゾーン内の任意の位置になりうる
  const cap = [];
  const top = b + 2*ob.rolls[ob.rolls.length-1];
  for(let v = Math.max(m.zoneLow, b + 1); v <= m.zoneHigh && v <= top; v++){
    if(crit.indexOf(v) < 0 && cap.indexOf(v) < 0) cap.push(v);
  }
  normal.sort((a,c)=>a-c); crit.sort((a,c)=>a-c); cap.sort((a,c)=>a-c);
  return { normal, crit, cap, name: ob.name };
}
// 候補を選んだとき。会心の有無まで受け取って理想値の分布を更新する
// 値の変化に応じた合図を1回だけ仕込む。
// ゾーンに入った=緑の波紋、超過=横揺れ、それ以外=一度だけ脈動。
function markFx(idx, before, after){
  const m = G.masses[idx];
  let k = 'pulse';
  if(after > m.zoneHigh) k = 'shake';
  else if(after >= m.zoneLow && before < m.zoneLow) k = 'enter';
  G.fx = { i: idx, k };
  setTimeout(()=>{ if(G.fx && G.fx.i === idx) G.fx = null; }, 700);
}
function pickValue(idx, val, wasCrit){
  if(!Number.isFinite(val)) return;      // 想定外の値では状態を壊さない
  const ob = G.obs && G.obs[idx];
  if(ob && ob.rolls) updatePost(idx, ob.before, ob.rolls, ob.cr, val, wasCrit);
  markFx(idx, G.masses[idx].current, val);
  G.masses[idx].current = val;
  if(G.obs) G.obs[idx] = null;
  G.pending = G.pending.filter(i => i !== idx);
  closePad();
  if(G.pending.length){ renderAll(); save(); return; }   // 残りは盤面から選んでもらう
  G.msg = null;
  // 先に盤面へ反映する。計算が点灯待ちで止まる場合、ここで描かないと
  // 最後に入れた値が盤面に出ないまま点灯選択の案内だけが出てしまう。
  renderAll();
  doCalc();                       // 入力が揃った時点で次の一手は確定できる
  save();
}
function openPad(kind, idx){
  padTarget=kind; padIdx=idx; padBuf=''; padOp=null;
  let title='';
  if(kind==='mass'){
    const m=G.masses[idx];
    title = `マス${idx+1}(ゾーン ${m.zoneLow}〜${m.zoneHigh})`;
  } else if(kind==='temp'){
    title='温度(℃)';
  } else {
    title='残り集中力';
  }
  document.getElementById('padTitle').textContent=title;
  const box = document.getElementById('padCand');
  const keys = document.getElementById('padKeys');
  const cand = (kind === 'mass') ? candidateValues(idx) : null;
  if(box){
    if(cand){
      const btn = (v,c) => `<button class="cand${c?' crit':''}" onclick="pickValue(${idx},${v},${c})">${v}</button>`;
      const critAll = cand.crit.concat(cand.cap).sort((a,b)=>a-b);
      box.innerHTML =
        `<div class="cand-q">マス${idx+1}はいくつになりましたか</div>`
      + `<div class="cand-grp"><span class="cand-h n">会心が出なかった</span>`
      + `<div class="cand-row">${cand.normal.map(v=>btn(v,false)).join('')}</div></div>`
      + `<div class="cand-grp"><span class="cand-h c">会心が出た</span>`
      + `<div class="cand-row">${critAll.map(v=>btn(v,true)).join('')}</div></div>`
      + `<button class="cand-more" onclick="showKeys()">一覧に無い値を自分で入力する</button>`;
      box.style.display = 'block';
      if(keys) keys.style.display = 'none';       // 候補があるならテンキーは畳む
    } else {
      box.innerHTML=''; box.style.display='none';
      if(keys) keys.style.display = '';
    }
  }
  updatePad();
  document.getElementById('modal').classList.add('show');
}

function showKeys(){
  const k = document.getElementById('padKeys');
  const b = document.getElementById('padCand');
  if(k) k.style.display = '';
  if(b) b.style.display = 'none';
}
function closePad(){ document.getElementById('modal').classList.remove('show'); }

function key(k){
  if(k==='del'){
    if(padBuf) padBuf=padBuf.slice(0,-1);
    else padOp=null;               // 数字が無ければ演算子を取り消す
  } else if(k==='plus' || k==='minus'){
    padOp = (padOp===k) ? null : k;  // 同じキーをもう一度押すと解除
    padBuf='';
  } else if(padBuf.length<5){
    padBuf+=k;
  }
  updatePad();
}

function curValue(){
  return padTarget==='mass' ? Math.round(G.masses[padIdx].current)
       : padTarget==='temp' ? G.temp : G.focus;
}

function updatePad(){
  const cur = curValue();
  const n = Number(padBuf||'0');
  let pre='', val=padBuf||'0', res='';
  if(padOp==='plus'){  pre = `${cur} ＋`; res = cur + n; }
  else if(padOp==='minus'){ pre = `${cur} －`; res = Math.max(0, cur - n); }
  document.getElementById('padPre').textContent = pre;
  document.getElementById('padVal').textContent = val;
  const rEl = document.getElementById('padRes');
  if(rEl) rEl.textContent = padOp ? `= ${res}` : `現在 ${cur}`;
  const p=document.getElementById('kPlus'), m=document.getElementById('kMinus');
  if(p) p.classList.toggle('on', padOp==='plus');
  if(m) m.classList.toggle('on', padOp==='minus');
}

function commit(){
  const cur = curValue();
  const n = Number(padBuf||'0');
  let v;
  if(padOp==='plus') v = cur + n;
  else if(padOp==='minus') v = cur - n;
  else v = padBuf==='' ? cur : n;    // 何も入力していなければ現状維持
  v = Math.max(0, v);
  let lastInput = false;                     // この入力で入力待ちが全て埋まったか
  if(padTarget==='mass'){
    markFx(padIdx, G.masses[padIdx].current, v);
    G.masses[padIdx].current = v;
    // 手入力は会心の有無が分からないので理想値の絞り込みには使わないが、
    // 打撃の記録(打つ前の値とロール候補)はここで使い終わったので必ず消す。
    // 残すと、次にこのマスを叩いた時に候補ボタンが出ず、
    // 再びこのマスを開いた時には古い値を元にした候補が並んでしまう。
    if(G.obs) G.obs[padIdx] = null;
    const wasPending = G.pending.includes(padIdx);
    G.pending = G.pending.filter(i => i !== padIdx);
    if(!G.pending.length) G.msg = null;
    lastInput = wasPending && !G.pending.length;
  }
  else if(padTarget==='temp') G.temp = v;
  else G.focus = v;
  // 温度・集中力・マス値を手で直した時点で、前の計算結果は別局面のものになる。
  // 点灯マスは温度で決まるので、温度を直した時だけ消す。
  // (マス値や集中力の修正で消すと、同じ手番なのに点灯の選び直しを求めてしまう)
  G.rec = null; G.plan = [];
  if(padTarget === 'temp') clearLit();
  closePad(); renderAll(); save();
  // 候補ボタンから選んだ時(pickValue)と同じく、入力が揃ったら次の一手まで出す
  if(lastInput) doCalc();
}

/* ====== 設定 ====== */
function readSettings(){
  G.level = Number(document.getElementById('s-level').value)||80;
  G.hammerId = document.getElementById('s-hammer').value;
  G.star = Number(document.getElementById('s-star').value);
  G.trait = document.getElementById('s-trait').value;
}
function applySettings(){
  const before = G.level + '/' + G.hammerId;
  const traitBefore = G.trait;
  readSettings();
  // 地金特性を切り替えたら点灯の記録は意味を失う。
  // 残すと威力会心率上昇に戻したとき、古い点灯が復活する。
  if(G.trait !== traitBefore) clearLit();
  // レベル・ハンマー・★・地金特性はロールにも会心率にも効く。
  // 変更後に古い推奨手と勝率を残すと、別条件の計算結果を見せることになる。
  G.rec = null; G.plan = [];
  const cap = FOCUS_CAP[G.level] || FOCUS_CAP[80];
  const full = cap + (HAMMERS[G.hammerId]?HAMMERS[G.hammerId].focusBonus:0);
  // 打ち始めた後に設定を触っても、進行中の集中力を勝手に満タンへ戻さない。
  // 上限が変わる項目(レベル・ハンマー)を変えた時だけ確認して入れ替える。
  const started = G.hist.length > 0 || G.masses.some(m=>m.current > 0);
  if(!started){
    G.focus = full;
  }else if(before !== G.level + '/' + G.hammerId){
    if(confirm('集中力の上限が変わります。現在値を ' + full + ' に入れ直しますか?\n' +
               'キャンセルすると今の ' + G.focus + ' のまま続けます。')) G.focus = full;
  }
  renderAll(); save();
}
// バーの最大値を変更した時。空欄なら自動計算に戻す。
function onBarMaxChange(){
  const v = Number(document.getElementById('s-barmax').value);
  G.barMax = (isFinite(v) && v > 0) ? v : null;
  renderAll(); save();
}

// 素材の選択が変わった時。手動設定ならゾーン入力欄を出す。
function onPresetChange(){
  const v = document.getElementById('s-preset').value;
  const box = document.getElementById('zoneEdit');
  if(v === 'custom'){
    box.style.display = 'block';
    // 手動設定は今の盤面(直前の素材のゾーン)を引き継いで始まるので、許容誤差も引き継ぐ。
    // 切り替えただけで計算の前提が変わらないようにし、入力欄には実際に使う値を出す。
    G.customThreshold = SUCCESS_THRESHOLD;
    G.preset = 'custom';
    applyThreshold();
    renderZoneRows();
    // ゾーンの入力欄は設定の中にあるので、選んだら開いて見せる
    const acc = document.getElementById('setAcc');
    if(acc) acc.open = true;
    renderAll(); save();
    return;
  }
  const started = G.hist.length > 0 || G.masses.some(m=>m.current > 0);
  if(started && !confirm('素材を変えると盤面と履歴が最初に戻ります。よろしいですか?')){
    // キャンセル時は選択も表示も元に戻す。
    // 先に display='none' にしてしまうと、手動設定のまま入力欄だけ消える。
    document.getElementById('s-preset').value = G.preset;
    if(G.preset === 'custom'){ box.style.display = 'block'; renderZoneRows(); }
    return;
  }
  box.style.display = 'none';
  G.preset = v;
  // 素材ごとに地金特性が決まっているので、選択と同時に切り替える
  const p = PRESETS[v];
  if(p && p.trait){
    const sel = document.getElementById('s-trait');
    if(sel) sel.value = p.trait;
  }
  resetAll();
}

// 各マスのゾーン入力欄を描く
function renderZoneRows(){
  const el = document.getElementById('zoneRows');
  if(!el) return;
  markZoneDirty(false);
  const th = document.getElementById('z-th');
  if(th) th.value = G.customThreshold;
  el.innerHTML = G.masses.map((m,i)=>{
    const on = !m.off;
    // 無効化したマスはゾーンを0にしているので、入力欄には控えを表示する
    const lo = on ? m.zoneLow  : (m.oLo || '');
    const hi = on ? m.zoneHigh : (m.oHi || '');
    return `<div class="zrow${on?'':' zoff'}" id="z-row-${i}">
       <input type="checkbox" class="zchk" id="z-on-${i}" ${on?'checked':''}
              onchange="onZoneToggle(${i})">
       <span class="zl">マス${i+1}</span>
       <input type="number" id="z-lo-${i}" value="${lo}" min="1" max="999"
              oninput="markZoneDirty()">
       <span class="zs">〜</span>
       <input type="number" id="z-hi-${i}" value="${hi}" min="1" max="999"
              oninput="markZoneDirty()">
     </div>`;}).join('');
}

// チェックの入切で行の見た目だけ切り替える(反映はボタンで行う)
function onZoneToggle(i){
  const row = document.getElementById('z-row-'+i);
  const on  = document.getElementById('z-on-'+i).checked;
  if(row) row.classList.toggle('zoff', !on);
  markZoneDirty();
}

// 入力しただけではまだ盤面に入らないので、その旨を出す
function markZoneDirty(on){
  const d = document.getElementById('zoneDirty');
  if(d) d.style.display = (on === false) ? 'none' : '';
}

// 入力されたゾーンを盤面に反映する
function applyZones(){
  const warn = document.getElementById('zoneWarn');
  const next = [];
  for(let i=0;i<G.masses.length;i++){
    const on = document.getElementById('z-on-'+i).checked;
    const lo = Number(document.getElementById('z-lo-'+i).value);
    const hi = Number(document.getElementById('z-hi-'+i).value);
    if(!on){ next.push({i, on:false, lo, hi}); continue; }
    if(!isFinite(lo) || !isFinite(hi) || lo < 1 || hi < lo || hi > 999){
      if(warn){ warn.textContent = 'マス'+(i+1)+': 下限は1以上、上限は下限以上かつ999以下で入れてください。';
                warn.style.display = 'block'; }
      return;                                 // 1つでも不正なら何も反映しない
    }
    next.push({i, on:true, lo, hi});
  }
  if(!next.some(x=>x.on)){
    if(warn){ warn.textContent = '少なくとも1マスは使う設定にしてください。';
              warn.style.display = 'block'; }
    return;
  }
  const thEl = document.getElementById('z-th');
  const th = thEl && thEl.value !== '' ? Number(thEl.value) : NaN;
  if(!isValidThreshold(th)){
    if(warn){ warn.textContent = '許容誤差は0〜99の整数で入れてください。';
              warn.style.display = 'block'; }
    return;
  }
  if(warn) warn.style.display = 'none';
  for(const x of next){
    const m = G.masses[x.i];
    m.oLo = isFinite(x.lo) && x.lo > 0 ? x.lo : m.oLo;   // 控え(再有効化時の初期値)
    m.oHi = isFinite(x.hi) && x.hi > 0 ? x.hi : m.oHi;
    if(x.on){
      m.off = false; m.zoneLow = x.lo; m.zoneHigh = x.hi;
      if(m.current > x.hi + 50) m.current = 0;
    }else{
      // 使わないマスは「幅0のゾーンに到達済み」として扱う。
      // 既存の未到達判定(current < zoneLow)が全て自動で素通りするため、
      // 評価・終局判定・推奨のいずれにも影響しない。
      m.off = true; m.zoneLow = 0; m.zoneHigh = 0; m.current = 0;
    }
  }
  syncActiveMask();
  // 盤面の定義が変わったので点灯は選び直してもらう。
  // 残すと、外したマスや到達済みになったマスが「点灯中」のまま残る。
  clearLit();
  // 使わなくなったマスに実測値の入力要求が残ると、盤面に無いマスのボタンが出る
  G.pending = G.pending.filter(i => !G.masses[i].off);
  if(Array.isArray(G.obs)) G.masses.forEach((m,i)=>{ if(m.off) G.obs[i] = null; });
  G.preset = 'custom';
  G.customThreshold = th;
  applyThreshold();                  // 反映しないと、直前の素材の許容誤差で計算し続ける
  G.rec = null; G.plan = [];
  renderZoneRows(); markZoneDirty(false); renderAll(); save();
}

// G.masses の有効/無効を技の対象計算へ反映する
function syncActiveMask(){
  setActiveMask(G.masses.map(m => !m.off));
}

function confirmReset(){
  const started = G.hist.length > 0 || G.masses.some(m=>m.current > 0);
  if(started && !confirm('盤面・集中力・履歴をすべて初期状態に戻します。よろしいですか?')) return;
  resetAll();
}

function resetAll(){
  readSettings();
  const pre = document.getElementById('s-preset');
  const kind = pre ? pre.value : 'kagayaki';
  // 手動設定なら現在のゾーンを保持し、数値だけ戻す
  // 手動設定はやり直しても、入力したゾーンと使用マスの設定を引き継ぐ
  const keep = (kind === 'custom' && G.masses.length === 6)
    ? G.masses.map(m=>({lo:m.zoneLow, hi:m.zoneHigh, off:!!m.off, oLo:m.oLo, oHi:m.oHi}))
    : (PRESETS[kind] ? PRESETS[kind].zones : PRESETS.kagayaki.zones)
        .map(([lo,hi],i)=>({lo, hi, off: !!(PRESETS[kind] && PRESETS[kind].off && PRESETS[kind].off.includes(i))}));
  // 使わないマスは「幅0のゾーンに到達済み」として保持する(手動設定のマス非表示と同じ扱い)
  G.masses = keep.map(k=>({current:0, zoneLow:k.off?0:k.lo, zoneHigh:k.off?0:k.hi, off:k.off,
                           oLo:k.oLo, oHi:k.oHi}));
  syncActiveMask();
  applyThreshold();
  G.temp = 1000; clearLit();
  const cap = FOCUS_CAP[G.level] || FOCUS_CAP[80];
  G.focus = cap + (HAMMERS[G.hammerId]?HAMMERS[G.hammerId].focusBonus:0);
  G.rec=null; G.plan=[];
  G.pending=[]; G.undoSnap=null; G.msg=null; G.hist=[]; G.posts=null; G.obs=null;
  renderZoneRows();
  renderAll(); save();
}

/* ====== 保存 ====== */
const SKEY='kajiAdvisorStateV1';
function save(){
  try{ localStorage.setItem(SKEY, JSON.stringify({
    temp:G.temp, focus:G.focus, masses:G.masses,
    level:G.level, hammerId:G.hammerId, star:G.star, trait:G.trait, preset:G.preset, barMax:G.barMax, lit:litMassIndex,
    customThreshold:G.customThreshold,
    pending:G.pending, showRange:G.showRange, hist:G.hist, posts:G.posts, obs:G.obs
  })); }catch(e){}
}
function load(){
  try{
    const s=JSON.parse(localStorage.getItem(SKEY));
    if(!s||!s.masses||s.masses.length!==6) return false;
    Object.assign(G,s);
    delete G.mc;                      // 旧版で保存された切り替え設定は使わない
    // 保存データの点灯が今の盤面で成立するか確かめてから戻す
    // (特性が違う・範囲外・使わないマス・到達済みなら捨てる)
    const L = s.lit;
    litMassIndex = (typeof L === 'number' && G.trait === 'kaishin' && G.masses[L]
                    && !G.masses[L].off && G.masses[L].current < G.masses[L].zoneLow) ? L : null;
    delete G.lit;
    G.masses.forEach(m => { if(m.off === undefined) m.off = false; });
    syncActiveMask();
    if(!isValidThreshold(G.customThreshold)) G.customThreshold = DEFAULT_THRESHOLD;
    applyThreshold();                 // 許容誤差は素材で決まる(手動設定は設定値)
    if(!Array.isArray(G.pending)) G.pending = [];
    if(!Array.isArray(G.hist)) G.hist = [];
    // 廃止した素材が保存データに残っていた場合は既定へ戻す
    if(G.preset !== 'custom' && !PRESETS[G.preset]) G.preset = 'kagayaki';
    if(typeof G.showRange !== 'boolean') G.showRange = true;
    G.undoSnap = null;   // 取り消しは同一セッション内だけ
    document.getElementById('s-level').value=G.level;
    document.getElementById('s-hammer').value=G.hammerId;
    document.getElementById('s-star').value=G.star;
    document.getElementById('s-trait').value=G.trait;
    if(G.barMax){
      const bm = document.getElementById('s-barmax');
      if(bm) bm.value = G.barMax;
    }
    if(G.preset){
      const pre = document.getElementById('s-preset');
      if(pre) pre.value = G.preset;
      if(G.preset === 'custom'){
        const box = document.getElementById('zoneEdit');
        if(box) box.style.display = 'block';
        renderZoneRows();
      }
    }
    return true;
  }catch(e){ return false; }
}

/* ====== 起動 ====== */
['s-level','s-hammer','s-star','s-trait'].forEach(id=>{
  document.getElementById(id).addEventListener('change', applySettings);
});

if(!load()) resetAll();
renderAll();

