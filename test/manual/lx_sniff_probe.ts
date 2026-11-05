// Throwaway probe: whether a file would be taken for an LX playlist or left to the m3u importer.
import { looksLikeLxPlaylist } from '../../src/extensions/builtin/lxmc';

const encoder = new TextEncoder();
const cases: Array<[string, string]> = [
    ['m3u', '#EXTM3U\n#EXTINF:123,Artist - Song\nD:/music/a.flac\n'],
    ['json 落雪歌单', JSON.stringify({ type: 'playList_v2', data: [] })],
    ['json 别的', JSON.stringify({ hello: 1 })],
    ['文本', 'hello world'],
    ['空文件', ''],
];
for (const [name, text] of cases) console.log(name, '→', looksLikeLxPlaylist(encoder.encode(text)));
