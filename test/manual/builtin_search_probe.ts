// test/manual/builtin_search_probe.ts
//
// Runs the built-in provider's search and lyrics against the real platforms, outside the app.
//
//   npx tsx test/manual/builtin_search_probe.ts 月半小夜曲
//   npx tsx test/manual/builtin_search_probe.ts 月半小夜曲 --qq

import { toLxMusicInfo } from '../../src/extensions/builtin/model';
import { searchBuiltin, searchQq } from '../../src/extensions/builtin/search';
import { getBuiltinLyrics } from '../../src/extensions/builtin/lyrics';

const query = process.argv[2] ?? '月半小夜曲';
const forceQq = process.argv.includes('--qq');

const run = async () => {
    const page = forceQq ? await searchQq(query, 3, 0) : await searchBuiltin(query, 3, 0);
    console.log(`查询「${query}」 → 平台 ${page.platforms.join('+') || '无'}，共 ${page.total} 条，返回 ${page.songs.length} 条`);
    for (const song of page.songs) {
        console.log(`\n- ${song.name} — ${song.artists.map(a => a.name).join('、')}`);
        console.log(`  id=${song.id}  ref=${song.sourceRef?.kind === 'online' ? song.sourceRef.mediaId : '?'}`);
        console.log(`  专辑=${song.album.name || '(空)'} 封面=${song.album.coverUrl ? '有' : '无'} 时长=${Math.round(song.durationMs / 1000)}s`);
        const info = toLxMusicInfo(song);
        console.log(`  音源入参: ${info ? JSON.stringify(info) : '缺少取址字段'}`);
    }

    const first = page.songs[0];
    if (!first) return;
    const lyrics = await getBuiltinLyrics(first);
    console.log(`\n歌词（${first.name}）: ${lyrics.lyrics ? `${lyrics.lyrics.lines.length} 行` : '没有'}${lyrics.isPureMusic ? '（纯音乐）' : ''}`);
    if (lyrics.lyrics) {
        for (const line of lyrics.lyrics.lines.slice(0, 4)) {
            console.log(`  [${line.startTime}ms] ${line.fullText}`);
        }
    }
};

run().catch(error => {
    console.error('失败:', error);
    process.exitCode = 1;
});
