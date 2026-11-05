// src/library/core/home/playlistFileAccept.ts
//
// 首页「导入歌单」文件框收哪些文件。同一份清单被三套首页 surface 共用，加一种格式只改这里。
//
// 两类文件走两条路：.m3u/.m3u8 按路径匹配本地歌曲建本地歌单；.lxmc（落雪 LX Music 导出）与同形状的
// .json 是在线歌单，由 createLibraryHomePort 转给内置音源。扩展名逐个列出来，不靠 MIME —— 这几种类型
// 在系统里没有注册的 MIME，只写 MIME 的话文件在选择框里会灰掉。

export const PLAYLIST_FILE_ACCEPT = [
    '.m3u',
    '.m3u8',
    '.lxmc',
    '.json',
    'audio/x-mpegurl',
    'application/vnd.apple.mpegurl',
    'application/json',
].join(',');
