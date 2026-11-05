// custom-source/smoke-real.cjs
//
// Development harness: loads real LX custom-source scripts through the host and reports which ones
// initialise and whether a playable URL comes back. Run with
//   node custom-source/smoke-real.cjs <dir-with-scripts> [source]
// Not part of the app; it exists so a new script can be triaged without launching Electron.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCustomSourceHost } = require('./lxHost.cjs');

// A runaway script must not kill the harness before it prints the verdict.
process.on('unhandledRejection', reason => {
  console.warn('[Harness] 未处理的 Promise 拒绝：', reason && reason.message ? reason.message : reason);
});

const SAMPLE = {
  wy: { songmid: '1901371647', id: '1901371647', name: '晴天', singer: '周杰伦' },
  tx: { songmid: '0039MnYb0qxYhV', strMediaMid: '0039MnYb0qxYhV', media_mid: '0039MnYb0qxYhV', name: '晴天', singer: '周杰伦' },
  kg: { hash: 'B5B2E5A0A0C0E6C0F0E0A0B0C0D0E0F0', name: '晴天', singer: '周杰伦' },
  kw: { songmid: '228908', name: '晴天', singer: '周杰伦' },
  mg: { songmid: '60084603816', copyrightId: '60084603816', name: '晴天', singer: '周杰伦' },
};

const main = async () => {
  const sourceDir = process.argv[2];
  const wantedSource = process.argv[3] || 'wy';
  if (!sourceDir) {
    console.error('用法：node custom-source/smoke-real.cjs <音源目录> [wy|tx|kg|kw|mg]');
    process.exit(1);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-custom-source-'));
  const files = fs.readdirSync(sourceDir).filter(name => name.toLowerCase().endsWith('.js'));
  for (const name of files) {
    fs.copyFileSync(path.join(sourceDir, name), path.join(workDir, name));
  }
  console.log(`\n设备目录：${workDir}`);
  console.log(`待测脚本：${files.length} 个\n`);

  const host = createCustomSourceHost({ dir: workDir });
  const started = Date.now();
  await host.whenLoaded();
  const elapsed = Date.now() - started;
  const listed = host.list();

  console.log(`\n============ 初始化结果（${elapsed}ms）============`);
  let ok = 0;
  for (const script of listed.scripts) {
    const sources = Object.keys(script.sources);
    if (!script.error) ok += 1;
    const mark = script.error ? 'FAIL' : ' OK ';
    console.log(`[${mark}] ${script.name}`);
    if (sources.length) {
      console.log(`        源：${sources.map(key => `${key}(${(script.sources[key].qualitys || []).join('/') || '默认'})`).join('  ')}`);
    }
    if (script.error) console.log(`        错误：${script.error}`);
  }
  console.log(`\n可用 ${ok} / ${listed.scripts.length}\n`);

  console.log(`============ 取址测试（${wantedSource}）============`);
  const result = await host.resolveUrl({
    source: wantedSource,
    musicInfo: SAMPLE[wantedSource] || SAMPLE.wy,
    quality: '320k',
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.ok) console.log(`\n取到的地址：${result.url.slice(0, 160)}...`);

  process.exit(0);
};

main().catch(error => {
  console.error('[Harness] 失败：', error);
  process.exit(1);
});
