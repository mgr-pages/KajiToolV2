/* =====================================================================
   鍛冶アドバイザーの対局の記録を受け取る Google Apps Script。
   使い方(docs/記録の集め方.md に手順):
     1. Google スプレッドシートを新しく作り、[拡張機能] → [Apps Script] を開く
     2. このファイルの中身を貼り付けて保存する
        (スプレッドシートのメニューから作らなかった時は、SPREADSHEET_ID に URL の /d/ と /edit の間を入れる)
     3. 関数「testPost」を選んで[実行]し、「記録」シートに試験の行が1行入ることを確かめる(確かめたら消してよい)
     4. [デプロイ] → [新しいデプロイ] → 種類「ウェブアプリ」
        実行するユーザー: 自分 / アクセスできるユーザー: 全員
     5. 表示された URL(…/exec)を gamelog.js の GLOG_ENDPOINT に入れる
   1局ごとに「記録」シートへ1行を足す。手順の細かい中身は最後の列に JSON で入れる。
   doPost はアプリから送られた時に動く。エディタから doPost を直接実行すると、送られた中身が無いので止まる。
   ===================================================================== */
const SPREADSHEET_ID = '';           // 空ならスクリプトを作ったスプレッドシートに書く
const SHEET = '記録';
const HEAD = ['受け取った日時', '記録の番号', '端末の番号(匿名)', '版', '素材', '地金特性', '職人Lv',
              'ハンマー', 'できのよさ', '許容誤差', '結果', '全マス到達', '残り集中力', '最後の温度',
              '最後の値(使うマス)', '手数(打った回数)', '取り消し', '始めた日時', '終えた日時', '手順(JSON)',
              'ブラウザ', 'OS'];

function doPost(e){
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try{
    const d = JSON.parse(e.postData.contents);
    const ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(SHEET);
    if(!sh){ sh = ss.insertSheet(SHEET); sh.appendRow(HEAD); sh.setFrozenRows(1); }
    // 列を足した版に入れ替えた時は、見出しの行も足りない分を書き直す(これまでの行の並びは変えない)
    else if(sh.getLastColumn() < HEAD.length) sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]);
    const steps = Array.isArray(d.steps) ? d.steps : [];
    const fin = d.final || {};
    sh.appendRow([new Date(), d.id, d.device, d.version, d.preset, d.trait, d.level, d.hammer, d.star,
                  d.threshold, d.outcome, d.reached, fin.focus, fin.temp, (fin.masses || []).join(' / '),
                  steps.filter(s => s.t === 'exec').length, steps.filter(s => s.t === 'undo').length,
                  d.started, d.finished, JSON.stringify({ zones: d.zones, steps }),
                  (d.env || {}).browser || '', (d.env || {}).os || '']);
    return ContentService.createTextOutput('ok');
  } finally {
    lock.releaseLock();
  }
}

// エディタから実行する試験。アプリから届いたのと同じ形の記録を1行書く(結果の欄は「試験」)
function testPost(){
  const rec = { id: 'test', device: 'test', version: 'test', preset: 'orb', trait: 'modori', level: 80,
                hammer: 'light', star: 3, threshold: 7, outcome: '試験', reached: false,
                final: { focus: 0, temp: 1000, masses: [0, 0, 0, 0, 0, 0] }, steps: [],
                started: new Date().toISOString(), finished: new Date().toISOString(), zones: [] };
  doPost({ postData: { contents: JSON.stringify(rec) } });
}
