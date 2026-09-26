/* =====================================================================
   先読みの試行を画面とは別のスレッドで回す Worker。
   engine.js をそのまま読み込み、mc-pool.js から割り当てられた範囲の試行だけを回す。
   ・先読み: 候補ごとの差の合計(sd・sd2)を返す。選ぶのは画面側(mc-pool.js)。
   ・手順: 手順用の試行の記録を返す。集計は画面側。
   ===================================================================== */
importScripts('engine.js');

self.onmessage = function(e){
  const q = e.data;
  try{
    mcRestore(q.snap);
    if(q.type === 'plan'){
      // 手順用の試行(buildPlan の前半)。集計は画面側で順に繋いでから行う
      const traces = planTraces(q.ms, q.cfg, moveFromWire(q.first), q.i0, q.i1);
      self.postMessage({ id: q.id, type: 'done', traces });
      return;
    }
    const pool = q.pool.map(moveFromWire);
    const n = pool.length, sd = new Array(n).fill(0), sd2 = new Array(n).fill(0);
    // 進み具合を返しながら、MC_CHUNK 件ずつ回す
    for(let j0 = q.j0; j0 < q.j1; j0 += MC_CHUNK){
      const j1 = Math.min(q.j1, j0 + MC_CHUNK);
      mcAccumulate(q.ms, q.f, q.t, q.cfg, pool, q.seedBase, j0, j1, sd, sd2);
      self.postMessage({ id: q.id, type: 'progress', done: j1 - j0 });
    }
    self.postMessage({ id: q.id, type: 'done', sd, sd2 });
  }catch(err){
    self.postMessage({ id: q.id, type: 'error', message: String(err && err.message || err) });
  }
};
