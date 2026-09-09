// order-template.html を base64 化して builder.html に埋め込む。
// order-template.html を編集したら必ず実行する:  node tools/embed-viewer.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tplPath     = join(root, 'order-template.html');
const builderPath = join(root, 'builder.html');
const indexPath   = join(root, 'index.html');

const tpl = readFileSync(tplPath, 'utf8');
if (!tpl.includes('__ENCRYPTED_PAYLOAD__')) {
  console.error('ERROR: order-template.html に __ENCRYPTED_PAYLOAD__ プレースホルダがありません。');
  process.exit(1);
}
const b64 = Buffer.from(tpl, 'utf8').toString('base64');

let builder = readFileSync(builderPath, 'utf8');
const before = builder;
builder = builder.replace(
  /var ORDER_TEMPLATE_B64 = "[^"]*";/,
  `var ORDER_TEMPLATE_B64 = "${b64}";`
);
if (builder === before) {
  console.error('ERROR: builder.html に  var ORDER_TEMPLATE_B64 = "...";  の行が見つかりません。');
  process.exit(1);
}
writeFileSync(builderPath, builder);

// index.html がまだ雛形（データ未取込）なら最新テンプレートで更新する。
// 本番の暗号化済み index.html は上書きしない。
if (!existsSync(indexPath) || readFileSync(indexPath, 'utf8').includes('__ENCRYPTED_PAYLOAD__')) {
  writeFileSync(indexPath, tpl);
  console.log('index.html を雛形として更新しました。');
} else {
  console.log('index.html は暗号化済みのため触っていません。');
}
console.log(`OK: order テンプレート (${b64.length} b64 chars) を builder.html に埋め込みました。`);
