// デモ用: sample-data.csv から index.html を生成する（合言葉は下記固定）。
//   node tools/build-demo.mjs
// 本番はユーザーが builder.html で生成して差し替える。実在の価格ではないダミー。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_PASSPHRASE = 'あおやま ガス 発注 2026';
const wc = globalThis.crypto;

function makeCsvReader(text){
  let i=0; const n=text.length;
  function next(){
    if(i>=n) return null;
    let row=[], field='', inQ=false, c, k, q;
    for(;;){
      if(i>=n){ row.push(field); return row; }
      c=text.charCodeAt(i);
      if(inQ){
        if(c===34){ if(text.charCodeAt(i+1)===34){ field+='"'; i+=2; continue; } inQ=false; i++; continue; }
        q=text.indexOf('"', i);
        if(q<0){ field+=text.slice(i); i=n; row.push(field); return row; }
        field+=text.slice(i,q); i=q; continue;
      }
      if(c===34){ inQ=true; i++; continue; }
      if(c===44){ row.push(field); field=''; i++; continue; }
      if(c===10){ i++; row.push(field); return row; }
      if(c===13){ i++; if(text.charCodeAt(i)===10) i++; row.push(field); return row; }
      k=i; while(k<n){ c=text.charCodeAt(k); if(c===44||c===10||c===13||c===34) break; k++; }
      field+=text.slice(i,k); i=k;
    }
  }
  return { next };
}
const toISO=s=>{ if(s==null)return null;s=String(s).trim();if(!s)return null;
  let m=s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  if(m)return m[1]+'-'+('0'+m[2]).slice(-2)+'-'+('0'+m[3]).slice(-2);
  const d=new Date(s); return isNaN(d)?null:d.toISOString().slice(0,10); };
const toNum=s=>{ if(s==null||s==='')return null; const n=parseFloat(String(s).replace(/[^0-9.\-]/g,'')); return isNaN(n)?null:n; };
const better=(a,b)=> a.d>b.d || (a.d===b.d && a.ord>b.ord);
function insertTop(g,k,rec){ let a=g.get(k); if(!a){g.set(k,[rec]);return;} let p=a.length;
  for(let x=0;x<a.length;x++){ if(better(rec,a[x])){p=x;break;} } if(p>=3)return; a.splice(p,0,rec); if(a.length>3)a.length=3; }

const csv=readFileSync(join(root,'sample-data.csv'),'utf8');
const rdr=makeCsvReader(csv);
const H=(rdr.next()||[]).map(s=>s.trim());
const col={ date:H.indexOf('伝票日付'), maker:H.indexOf('メーカー'), name:H.indexOf('品名'),
  kt:H.indexOf('型式'), unit:H.indexOf('単位'), qty:H.indexOf('数量'), price:H.indexOf('単価') };
const base='2026-09-08'; const MONTHS=12; const cut=new Date(base); cut.setMonth(cut.getMonth()-MONTHS);
const cutISO=cut.toISOString().slice(0,10);
const groups=new Map(); const txGroups=new Map(); let ord=0, r;
for(;;){ r=rdr.next(); if(r===null) break; if(r.length===1&&r[0]==='') continue; ord++;
  const d=toISO(r[col.date]); const p=toNum(r[col.price]);
  if(!d||p==null||d<cutISO) continue;
  const kt=String(r[col.kt]||'').trim(), nm=String(r[col.name]||'').trim();
  if(!kt&&!nm) continue;
  const key=(kt||nm)+''+(nm||kt);
  const rec={ d,p,q:toNum(r[col.qty]),kt:kt||nm,nm:nm||kt,
    mk:String(r[col.maker]||'').trim(),un:String(r[col.unit]||'').trim(),ord };
  insertTop(groups,key,rec);
  if(!txGroups.has(key)) txGroups.set(key,[]);
  txGroups.get(key).push(rec);
}
const catalog=[];
groups.forEach((a,key)=>{
  const g=a[0];
  const full=(txGroups.get(key)||[]).slice();
  full.sort((x,y)=> x.d<y.d?1:x.d>y.d?-1:y.ord-x.ord);
  catalog.push({ mk:g.mk,nm:g.nm,kt:g.kt,un:g.un,
    l:{d:a[0].d,p:a[0].p,q:a[0].q}, h:a.slice(1).map(x=>({d:x.d,p:x.p,q:x.q})),
    tx:full.map(x=>({d:x.d,p:x.p,q:x.q})) });
});
catalog.sort((a,b)=> a.nm.localeCompare(b.nm,'ja')||a.kt.localeCompare(b.kt,'ja'));

const notices=[
  { id:'demo-n1', date:'2026-09-10', title:'発注アプリをリニューアルしました', body:'注文書PDFの自動作成、期間指定での購入履歴の一覧表示、このお知らせ機能を追加しました。ご不明点は担当までご連絡ください。', important:false },
  { id:'demo-n2', date:'2026-08-25', title:'年末年始の配送スケジュールについて（例）', body:'12/29〜1/3は休業します。年末のご注文はお早めにお願いします。', important:true },
];
const payload={ v:1, builtAt:base, months:MONTHS, catalog, notices,
  dealer:'株式会社青山商店（デモ）', orderPrefix:'AOYAMA', recvEmail:'toga.daisuke@iwatani.co.jp',
  org:{ name:'岩谷産業㈱熊本支店', tel:'096-324-8600', fax:'096-324-3366' } };

const bufToB64=b=>Buffer.from(new Uint8Array(b)).toString('base64');
const iter=310000;
const salt=wc.getRandomValues(new Uint8Array(16)), iv=wc.getRandomValues(new Uint8Array(12));
const kb=await wc.subtle.importKey('raw',new TextEncoder().encode(DEMO_PASSPHRASE),'PBKDF2',false,['deriveKey']);
const key=await wc.subtle.deriveKey({name:'PBKDF2',salt,iterations:iter,hash:'SHA-256'},kb,{name:'AES-GCM',length:256},false,['encrypt']);
const ct=await wc.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(payload)));
const blob={ kdf:'PBKDF2',hash:'SHA-256',iter,salt:bufToB64(salt),iv:bufToB64(iv),ct:bufToB64(ct) };

const tpl=readFileSync(join(root,'order-template.html'),'utf8');
writeFileSync(join(root,'index.html'), tpl.replace('__ENCRYPTED_PAYLOAD__', ()=>JSON.stringify(blob)));
console.log('index.html（デモ）を書き出しました。合言葉: '+DEMO_PASSPHRASE);
console.log('カタログ '+catalog.length+' 件');
