/* =====================================================================
   先読みを複数の Worker(mc-worker.js)に分担させる。
   ・試行(MC_S 回)を Worker の数で分け、各 Worker が返した差の合計を足してから選ぶ。
     差は整数なので、分け方によらず画面側だけで計算した場合と同じ手になる。
   ・推奨手に続く想定手順の試行(buildPlan)も同じように分担する。
   ・計算中も画面のスレッドは空くので、画面が固まらない。
   ・Worker が作れない(ファイルを直接開いた時は多くのブラウザで作れない)、
     または途中で失敗した場合は、engine.js の stratMCAsync(画面側で計算)に切り替える。
   engine.js の後、ui.js の前に読み込む。
   ===================================================================== */
const MCPool = (function(){
  let workers = null;        // 作成済みの Worker
  let disabled = false;      // 作れなかった/失敗した。以降は画面側で計算する
  let broken = false;        // 読み込みに失敗した Worker がある(次の計算で切り替える)
  let seq = 0;

  // 使う Worker の数。端末の論理コア数に合わせ、多すぎる端末でも8で止める
  function size(){
    const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
    return Math.max(1, Math.min(8, hc));
  }
  function init(){
    if(workers || disabled) return;
    if(typeof Worker === 'undefined'){ disabled = true; return; }
    try{
      workers = [];
      for(let k = 0; k < size(); k++){
        const w = new Worker('mc-worker.js');
        // 読み込みの失敗は計算を頼む前に届くことがある。取りこぼすと次の計算が終わらないので控える
        w.onerror = e => { e.preventDefault(); broken = true; };
        workers.push(w);
      }
    }catch(e){
      shutdown();
    }
  }
  function shutdown(){
    if(workers) workers.forEach(w => { try{ w.terminate(); }catch(e){} });
    workers = null; disabled = true;
  }

  // 1つの Worker に試行 j0〜j1-1 を頼む
  function job(w, msg, onDone){
    return new Promise((resolve, reject) => {
      const id = ++seq;
      w.onmessage = e => {
        const r = e.data;
        if(r.id !== id) return;
        if(r.type === 'progress') onDone(r.done);
        else if(r.type === 'done') resolve(r);
        else reject(new Error(r.message));
      };
      w.onerror = e => { e.preventDefault(); reject(new Error(e.message || 'Worker error')); };
      w.postMessage(Object.assign({ id }, msg));
    });
  }

  async function strat(ms, f, t, P, cfg, onProgress){
    init();
    if(broken) shutdown();
    if(!workers) return stratMCAsync(ms, f, t, P, cfg, onProgress);
    const prep = mcPrepare(ms, f, t, P, cfg);
    if(prep.move !== undefined) return prep.move;
    const { pool, seedBase } = prep;
    const n = pool.length;
    const base = { snap: mcSnapshot(), pool: pool.map(moveToWire), ms, f, t, cfg, seedBase };
    // 試行を均等に分ける
    const k = Math.min(workers.length, MC_S);
    const per = Math.ceil(MC_S / k);
    let done = 0;
    const tick = d => { done += d; if(onProgress) onProgress(done, MC_S, n); };
    let parts;
    try{
      parts = await Promise.all(Array.from({ length: k }, (_, i) => {
        const j0 = i * per, j1 = Math.min(MC_S, j0 + per);
        return job(workers[i], Object.assign({ j0, j1 }, base), tick);
      }));
    }catch(e){
      // 途中で失敗したら Worker をやめ、画面側で最初から計算し直す(同じ手になる)
      console.warn('先読みの並列計算に失敗したため、画面側で計算します:', e.message);
      shutdown();
      return stratMCAsync(ms, f, t, P, cfg, onProgress);
    }
    const sd = new Array(n).fill(0), sd2 = new Array(n).fill(0);
    for(const p of parts) for(let a = 0; a < n; a++){ sd[a] += p.sd[a]; sd2[a] += p.sd2[a]; }
    return mcPick(pool, sd, sd2);
  }

  // 推奨手に続く想定手順(engine.js の buildPlan と同じ結果)を、試行を分担して作る
  async function plan(ms, cfg, first){
    G.plan = [];
    if(!first) return;
    init();
    if(broken) shutdown();
    if(!workers){ buildPlan(ms, cfg, first); return; }
    const base = { type: 'plan', snap: mcSnapshot(), first: moveToWire(first), ms, cfg };
    const k = Math.min(workers.length, PLAN_TRIALS);
    const per = Math.ceil(PLAN_TRIALS / k);
    let parts;
    try{
      parts = await Promise.all(Array.from({ length: k }, (_, i) => {
        const i0 = i * per, i1 = Math.min(PLAN_TRIALS, i0 + per);
        return job(workers[i], Object.assign({ i0, i1 }, base), () => {});
      }));
    }catch(e){
      console.warn('手順の並列計算に失敗したため、画面側で計算します:', e.message);
      shutdown();
      buildPlan(ms, cfg, first);
      return;
    }
    planFromTraces(ms, [].concat(...parts.map(p => p.traces)));   // 試行の順に繋ぐ
  }

  // 状態の確認用(画面の表示とテストで使う)
  function info(){ return { workers: workers ? workers.length : 0, disabled }; }

  return { strat, plan, info };
})();
