// エンドツーエンドの自己テスト:  node tools/selftest.mjs
// builder.html / order-template.html と同じロジック・同じ暗号パラメータを再現し、
// sample-data.csv を 集計 → 暗号化 → 復号 まで通して結果を検証する。
// さらに大きい合成CSVで、逐次リーダ＋チャンク集計が総当たりと一致すること・
// 現実的な時間で終わることを確認する。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webcrypto = globalThis.crypto;

/* ---- builder.html と同一: CSV 逐次リーダ ---- */
function makeCsvReader(text){
  let i=0; const n=text.length;
  function next(){
    if(i>=n) return null;
    let row=[], field='', inQ=false, c, k, q;
    for(;;){
      if(i>=n){ row.push(field); return row; }
      c=text.charCodeAt(i);
      if(inQ){
        if(c===34){
          if(text.charCodeAt(i+1)===34){ field+='"'; i+=2; continue; }
          inQ=false; i++; continue;
        }
        q=text.indexOf('"', i);
        if(q<0){ field+=text.slice(i); i=n; row.push(field); return row; }
        field+=text.slice(i,q); i=q; continue;
      }
      if(c===34){ inQ=true; i++; continue; }
      if(c===44){ row.push(field); field=''; i++; continue; }
      if(c===10){ i++; row.push(field); return row; }
      if(c===13){ i++; if(text.charCodeAt(i)===10) i++; row.push(field); return row; }
      k=i;
      while(k<n){ c=text.charCodeAt(k); if(c===44||c===10||c===13||c===34) break; k++; }
      field+=text.slice(i,k); i=k;
    }
  }
  return { next };
}
const toISO = s => {
  if(s==null) return null; s=String(s).trim(); if(!s) return null;
  let m=s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  if(m) return m[1]+'-'+('0'+m[2]).slice(-2)+'-'+('0'+m[3]).slice(-2);
  m=s.match(/^(\d{4})(\d{2})(\d{2})$/); if(m) return m[1]+'-'+m[2]+'-'+m[3];
  const d=new Date(s); return isNaN(d)?null:d.toISOString().slice(0,10);
};
const toNum = s => {
  if(s==null||s==='') return null;
  const n=parseFloat(String(s).replace(/[^0-9.\-]/g,'')); return isNaN(n)?null:n;
};
const _better = (a,b) => a.d>b.d || (a.d===b.d && a.ord>b.ord);
function _insertTop(groups,key,rec){
  let arr=groups.get(key);
  if(!arr){ groups.set(key,[rec]); return; }
  let pos=arr.length;
  for(let x=0;x<arr.length;x++){ if(_better(rec,arr[x])){ pos=x; break; } }
  if(pos>=3) return;
  arr.splice(pos,0,rec);
  if(arr.length>3) arr.length=3;
}

/* ---- builder.html の aggregateStreamed と同一（同期版） ---- */
function aggregate(text, map, months, base){
  const rdr=makeCsvReader(text);
  const headers=(rdr.next()||[]).map(s=>String(s).trim());
  const col={}; Object.keys(map).forEach(k=>{ col[k]= map[k]? headers.indexOf(map[k]) : -1; });
  const cut=new Date(base); cut.setMonth(cut.getMonth()-months);
  const cutISO=cut.toISOString().slice(0,10);
  const groups=new Map(); const txGroups=new Map(); const custSet={}; let used=0, skipped=0, total=0, ord=0, r;
  for(;;){
    r=rdr.next(); if(r===null) break;
    if(r.length===1 && r[0]==='') continue;
    total++; ord++;
    const dISO=toISO(col.date>=0?r[col.date]:null);
    const price=toNum(col.price>=0?r[col.price]:null);
    if(!dISO||price==null){ skipped++; continue; }
    if(dISO<cutISO) continue;
    const kt=(col.itemCode>=0?String(r[col.itemCode]||'').trim():'');
    const nm=(col.itemName>=0?String(r[col.itemName]||'').trim():'');
    if(!kt&&!nm){ skipped++; continue; }
    if(col.custName>=0){ const cn=String(r[col.custName]||'').trim(); if(cn) custSet[cn]=1; }
    const key=(kt||nm)+''+(nm||kt);
    const rec={ d:dISO, p:price, q:toNum(col.qty>=0?r[col.qty]:null),
      kt:kt||nm, nm:nm||kt,
      mk:(col.maker>=0?String(r[col.maker]||'').trim():''),
      un:(col.unit>=0?String(r[col.unit]||'').trim():''), ord };
    _insertTop(groups, key, rec);
    if(!txGroups.has(key)) txGroups.set(key, []);
    txGroups.get(key).push(rec);
    used++;
  }
  const catalog=[];
  groups.forEach((arr,key)=>{
    const g=arr[0];
    const full=(txGroups.get(key)||[]).slice();
    full.sort((a,b)=> a.d<b.d?1:a.d>b.d?-1:b.ord-a.ord);
    catalog.push({ mk:g.mk, nm:g.nm, kt:g.kt, un:g.un,
      l:{d:arr[0].d,p:arr[0].p,q:arr[0].q},
      h:arr.slice(1).map(x=>({d:x.d,p:x.p,q:x.q})),
      tx:full.map(x=>({d:x.d,p:x.p,q:x.q})) });
  });
  catalog.sort((a,b)=> a.nm.localeCompare(b.nm,'ja')||a.kt.localeCompare(b.kt,'ja'));
  return { payload:{v:1,builtAt:base,months,catalog},
           stats:{used,skipped,groups:groups.size,total,custs:Object.keys(custSet)} };
}

/* ---- 参照実装: 全行をためてから上位3件 ---- */
function aggregateBrute(text, map, months, base){
  const rdr=makeCsvReader(text);
  const headers=(rdr.next()||[]).map(s=>String(s).trim());
  const col={}; Object.keys(map).forEach(k=>{ col[k]= map[k]? headers.indexOf(map[k]) : -1; });
  const cut=new Date(base); cut.setMonth(cut.getMonth()-months);
  const cutISO=cut.toISOString().slice(0,10);
  const buckets=new Map(); let ord=0, r;
  for(;;){
    r=rdr.next(); if(r===null) break;
    if(r.length===1 && r[0]==='') continue;
    ord++;
    const dISO=toISO(col.date>=0?r[col.date]:null);
    const price=toNum(col.price>=0?r[col.price]:null);
    if(!dISO||price==null||dISO<cutISO) continue;
    const kt=(col.itemCode>=0?String(r[col.itemCode]||'').trim():'');
    const nm=(col.itemName>=0?String(r[col.itemName]||'').trim():'');
    if(!kt&&!nm) continue;
    const key=(kt||nm)+''+(nm||kt);
    if(!buckets.has(key)) buckets.set(key,[]);
    buckets.get(key).push({ d:dISO,p:price,ord });
  }
  const out=new Map();
  buckets.forEach((arr,key)=>{
    arr.sort((a,b)=> a.d<b.d?1:a.d>b.d?-1:b.ord-a.ord);
    const top=arr.slice(0,3);
    out.set(key,{ p:top[0].p, d:top[0].d, hist:top.slice(1).map(x=>x.p+'@'+x.d).join(','),
      all:arr.map(x=>x.p+'@'+x.d).join(','), count:arr.length });
  });
  return out;
}

/* ---- 暗号（builder.html と同一） ---- */
const bufToB64 = buf => Buffer.from(new Uint8Array(buf)).toString('base64');
const b64ToBuf = b64 => new Uint8Array(Buffer.from(b64,'base64'));
async function encryptPayload(obj, pass){
  const iter=310000;
  const salt=webcrypto.getRandomValues(new Uint8Array(16));
  const iv=webcrypto.getRandomValues(new Uint8Array(12));
  const kbase=await webcrypto.subtle.importKey('raw', new TextEncoder().encode(pass),'PBKDF2',false,['deriveKey']);
  const key=await webcrypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:iter,hash:'SHA-256'},kbase,{name:'AES-GCM',length:256},false,['encrypt']);
  const ct=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(obj)));
  return { kdf:'PBKDF2',hash:'SHA-256',iter,salt:bufToB64(salt),iv:bufToB64(iv),ct:bufToB64(ct) };
}
async function decrypt(blob, pass){
  const kbase=await webcrypto.subtle.importKey('raw', new TextEncoder().encode(pass),'PBKDF2',false,['deriveKey']);
  const key=await webcrypto.subtle.deriveKey({name:'PBKDF2',salt:b64ToBuf(blob.salt),iterations:blob.iter,hash:'SHA-256'},kbase,{name:'AES-GCM',length:256},true,['decrypt']);
  const pt=await webcrypto.subtle.decrypt({name:'AES-GCM',iv:b64ToBuf(blob.iv)},key,b64ToBuf(blob.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

/* ================= 1) サンプルデータ ================= */
const csv=readFileSync(join(root,'sample-data.csv'),'utf8');
const map={ date:'伝票日付', itemCode:'型式', itemName:'品名', maker:'メーカー',
  unit:'単位', qty:'数量', price:'単価', custName:'得意先名' };
const { payload, stats } = aggregate(csv, map, 3, '2026-09-08');
console.log('rows:', stats.total, ' stats:', { used:stats.used, skipped:stats.skipped, groups:stats.groups, custs:stats.custs });
console.log('catalog:', payload.catalog.length, '件');

assert.ok(payload.catalog.length >= 5, 'カタログが5件以上');
assert.equal(stats.custs.length, 1, '得意先は1社（青山商店のみ）');
const gy20 = payload.catalog.find(c => c.kt==='RUX-A2016');
assert.ok(gy20, 'RUX-A2016 が存在');
assert.ok(gy20.l.p > 0 && gy20.l.d, '直近単価と日付がある');
assert.ok(Array.isArray(gy20.h), '履歴配列がある');
// 逐次 == 総当たり
{
  const brute=aggregateBrute(csv, map, 3, '2026-09-08');
  assert.equal(payload.catalog.length, brute.size, 'サンプル: グループ数一致');
  for(const c of payload.catalog){
    const b=brute.get((c.kt||c.nm)+''+(c.nm||c.kt));
    assert.ok(b, 'サンプル: 総当たりにも同キー');
    assert.equal(c.l.p, b.p, 'サンプル: 直近単価一致');
    assert.equal(c.l.d, b.d, 'サンプル: 直近日付一致');
    assert.equal(c.h.map(x=>x.p+'@'+x.d).join(','), b.hist, 'サンプル: 履歴一致');
    assert.ok(Array.isArray(c.tx), 'サンプル: tx配列がある');
    assert.equal(c.tx.length, b.count, 'サンプル: tx件数が期間内の全取引数と一致');
    assert.equal(c.tx.map(x=>x.p+'@'+x.d).join(','), b.all, 'サンプル: tx内容が総当たりの全件と一致');
  }
}

/* ================= 2) 大きい合成CSV ================= */
{
  const NITEM=400, ROWS=250000, base='2026-09-08';
  const hdr='伝票日付,得意先名,メーカー,品名,型式,単位,数量,単価\n';
  let seed=987654321;
  const rnd=()=>{ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; };
  const parts=[hdr];
  for(let i=0;i<ROWS;i++){
    const k=1+Math.floor(rnd()*NITEM);
    const off=Math.floor(rnd()*200);
    const d=new Date('2026-09-08T00:00:00Z'); d.setUTCDate(d.getUTCDate()-off);
    const ds=d.toISOString().slice(0,10).replace(/-/g,'/');
    const price=8000+Math.floor(rnd()*92000);
    parts.push(`${ds},株式会社青山商店,M${k%7},品目${k},KT-${k},台,1,${price}\n`);
  }
  const big=parts.join('');
  console.log('\n大きいCSV: '+(big.length/1048576).toFixed(1)+'MB / '+ROWS.toLocaleString()+' 行');
  const t0=Date.now();
  const res=aggregate(big, map, 3, base);
  const ms=Date.now()-t0;
  console.log('逐次集計: '+ms+'ms / カタログ '+res.stats.groups.toLocaleString()+' 件 / 採用 '+res.stats.used.toLocaleString()+' 行');
  assert.ok(ms < 15000, '15秒以内に終わる（実測 '+ms+'ms）');
  assert.equal(res.stats.total, ROWS, '全行を読み切っている');
  const brute=aggregateBrute(big, map, 3, base);
  assert.equal(res.payload.catalog.length, brute.size, '大きいCSV: グループ数一致');
  for(const c of res.payload.catalog){
    const b=brute.get((c.kt||c.nm)+''+(c.nm||c.kt));
    assert.equal(c.l.p, b.p, '大きいCSV: 直近単価一致');
    assert.equal(c.h.map(x=>x.p+'@'+x.d).join(','), b.hist, '大きいCSV: 履歴一致');
    assert.equal(c.tx.length, b.count, '大きいCSV: tx件数一致');
    assert.equal(c.tx.map(x=>x.p+'@'+x.d).join(','), b.all, '大きいCSV: tx内容一致');
  }
  console.log('総当たりと突き合わせ: '+res.payload.catalog.length.toLocaleString()+' 件すべて一致（tx全件も一致）');
}

/* ================= 3) 引用符つきCSV ================= */
{
  const q='a,b,c\n"x,1","y ""z""",3\np,"q\nr",s\n';
  const rd=makeCsvReader(q);
  assert.deepEqual(rd.next(), ['a','b','c'], '引用: ヘッダ');
  assert.deepEqual(rd.next(), ['x,1','y "z"','3'], '引用: カンマ・エスケープ');
  assert.deepEqual(rd.next(), ['p','q\nr','s'], '引用: フィールド内改行');
  assert.equal(rd.next(), null, '引用: EOF');
}

/* ================= 4) 暗号ラウンドトリップ ＋ テンプレ埋め込み ================= */
const full = Object.assign({}, payload, {
  dealer:'株式会社青山商店', orderPrefix:'AOYAMA', recvEmail:'toga.daisuke@iwatani.co.jp',
  org:{ name:'岩谷産業㈱熊本支店', tel:'096-324-8600', fax:'096-324-3366' },
  notices:[
    { id:'n1', date:'2026-09-10', title:'テスト用お知らせ', body:'本文テスト。', important:true },
    { id:'n2', date:'2026-08-01', title:'過去のお知らせ', body:'古い方。', important:false }
  ],
  quotes:[
    { id:'q1', date:'2026-09-05', title:'テスト用見積もり', fileName:'q.pdf', fileType:'application/pdf',
      fileData:Buffer.from('dummy-pdf-bytes').toString('base64'), note:'テスト。',
      lines:[{ nm:'テスト品', kt:'T-1', mk:'テストメーカー', qty:2, unit:'台', tanka:1000 }] }
  ],
  orderReplies:[
    { orderNo:'AOYAMA-20260910-01', shipDate:'2026-09-20', updatedAt:'2026-09-12' }
  ]
});
const pass='あおやま ガス 発注 えんぴつ 2026';
const blob=await encryptPayload(full, pass);
const back=await decrypt(blob, pass);
assert.deepEqual(back, full, '復号結果が元と一致');
let threw=false; try{ await decrypt(blob,'ちがう合言葉'); }catch(e){ threw=true; }
assert.ok(threw, '誤った合言葉では復号が失敗する');

const tpl=readFileSync(join(root,'order-template.html'),'utf8');
assert.ok(tpl.includes('__ENCRYPTED_PAYLOAD__'), 'テンプレにプレースホルダがある');
const html=tpl.replace('__ENCRYPTED_PAYLOAD__', ()=>JSON.stringify(blob));
assert.ok(!html.includes('__ENCRYPTED_PAYLOAD__'), 'プレースホルダが置換された');
assert.ok(html.includes('"ct":'), '暗号文が埋め込まれた');
JSON.parse(html.match(/<script id="payload"[^>]*>([\s\S]*?)<\/script>/)[1]);

const builder=readFileSync(join(root,'builder.html'),'utf8');
assert.ok(/var ORDER_TEMPLATE_B64 = "[^"]*";/.test(builder), 'builder.html に埋め込み変数がある');

console.log('\nblob size: ct='+blob.ct.length+' b64chars,  生成HTML='+html.length+' bytes');
console.log('ALL TESTS PASSED ✅');
