// test/manual/builtin_import_probe.ts
//
// Reads a real .lxmc and prints what the importer made of it. Not a unit test - the parse is only
// worth anything against the files LX actually writes, and this is the quickest way to see it.
//
//   npx tsx test/manual/builtin_import_probe.ts "D:/驱逐舰/lx_list.lxmc"

import fs from 'node:fs';
import { looksLikeLxPlaylist, parseLxmc } from '../../src/extensions/builtin/lxmc';

const file = process.argv[2] ?? 'D:/驱逐舰/lx_list.lxmc';
const bytes = new Uint8Array(fs.readFileSync(file));
const result = parseLxmc(bytes);

console.log(`文件: ${file} (${bytes.length} 字节)`);
console.log(`判定: ${looksLikeLxPlaylist(bytes) ? '是落雪歌单（会转给内置音源）' : '不是落雪歌单（仍走本地 m3u 匹配）'}`);
console.log(`歌单: ${result.playlists.length} 个，跳过歌曲 ${result.skipped} 首`);
for (const playlist of result.playlists) {
    console.log(`\n- ${playlist.name}  [${playlist.songs.length} 首，主体平台 ${playlist.platform ?? '混合'}]`);
    for (const song of playlist.songs.slice(0, 2)) {
        const ref = song.sourceRef?.kind === 'online' ? song.sourceRef.mediaId : '';
        console.log(`    ${song.name} — ${song.artists.map(a => a.name).join('、')}`);
        console.log(`      id=${song.id} ref=${ref} 时长=${Math.round(song.durationMs / 1000)}s 封面=${song.album.coverUrl ? '有' : '无'}`);
        if (song.qqMid) console.log(`      qqMid=${song.qqMid}`);
        if (song.kgHash) console.log(`      kgHash=${song.kgHash}`);
    }
}
