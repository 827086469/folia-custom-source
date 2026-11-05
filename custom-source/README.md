# 自定义音源（LX 兼容）

给 Folia 的在线音源接一个「取址代理」：把落雪（LX Music）风格的自定义源脚本放进来，播放时由脚本提供
地址，**搜索、歌单、歌词、封面仍然走 Folia 自己的 provider**。

## 为什么只有「取址」

在 LX 里，自定义源不负责搜索——搜索是应用内置代码（`src/renderer/utils/musicSdk/wy/musicSearch.js` 之类），
脚本只被问一个问题：这首歌的播放地址是什么。所以在 Folia 这边，脚本能补的也正好是唯一缺的那一环：
受版权/会员限制时拿不到地址。搜索继续用 Folia 已有的，不需要脚本参与。

## 放哪里

```
<userData>/custom-sources/          # Windows: %APPDATA%\Folia\custom-sources
├── config.json                     # 自动生成，记录被禁用的脚本
└── *.js                            # 音源脚本，放进去即启用
```

`<userData>` 是 Electron 的 userData 目录。运行时可以从渲染层调用
`window.electron.customSource.openFolder()` 直接打开（后续会接到设置页）。

脚本头部按 LX 的约定写元信息，用于列表展示：

```js
/**
 * @name 示例音源
 * @description 只是说明文字
 * @version 1.0.0
 * @author 你的名字
 * @homepage https://example.com
 */
```

## 脚本能声明什么

只实现 LX 文档里的 `musicUrl` 动作就够了：

```js
const { EVENT_NAMES, request, on, send } = globalThis.lx

const httpRequest = (url, options) => new Promise((resolve, reject) => {
  request(url, options, (err, resp) => {
    if (err) return reject(err)
    resolve(resp.body)
  })
})

on(EVENT_NAMES.request, ({ source, action, info }) => {
  switch (action) {
    case 'musicUrl':
      return httpRequest(`https://api.example.com/url?id=${info.musicInfo.songmid}`)
        .then(text => JSON.parse(text).data.url)
  }
})

send(EVENT_NAMES.inited, {
  sources: {
    wy: { name: '网易云音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] },
  },
})
```

宿主提供给脚本的东西：

| 能力 | 说明 |
|---|---|
| `lx.request(url, options, cb)` | 主进程发请求，**不受跨域限制**；支持 `method/headers/body/form/timeout`，自动跟随 302（最多 5 跳），自动解 gzip/deflate/br，响应体自动 `JSON.parse`（与 LX 一致） |
| `lx.on` / `lx.send` / `lx.EVENT_NAMES` | 事件协议，与 LX 一致；`inited` 允许异步发送（最多等 8s） |
| `lx.currentScriptInfo` | 头部元信息 + `rawScript` |
| `lx.utils.buffer.from` / `bufToString` | Buffer 工具 |
| `lx.utils.crypto.aesEncrypt/rsaEncrypt/md5/sha1/sha256/randomBytes` | 与 LX 同签名（`aesEncrypt(buffer, mode, key, iv)`） |
| `lx.utils.zlib.inflate/deflate` | 返回 Promise，与 LX 一致 |
| `console` | 带脚本名前缀，含 `group/groupEnd/table/trace` 等浏览器方法 |

脚本里 **没有** `require`、`process`、文件系统。

## 歌曲字段映射

Folia 的 `SongResult` 会被翻译成 LX 脚本读的形状：

| 音源 | 字段 |
|---|---|
| 网易云 `wy` | `songmid`、`id`（字符串）、`name`、`singer`、`albumName`、`interval` |
| 酷狗 `kg` | `hash`（取自 `SongResult.kgHash`） |
| QQ `tx` | `songmid`、`strMediaMid`、`media_mid`（三者都取自 `SongResult.qqMid`） |

缺少关键 id 时（例如没有 `kgHash`），这一首不会问脚本，直接用内置音源的行为——避免用空 id 拿到错歌。

## 音质

请求的音质按档位映射，脚本声明里没有的档位会取「不高于它的最近一档」：

| Folia | LX |
|---|---|
| `standard` | `128k` |
| `high` | `320k` |
| `ultra` / `lossless` | `320k` / `flac` |
| `hires` | `flac24bit` |

## 失败时

装上多个脚本时按加载顺序**依次尝试**，第一个失败自动换下一个，直到拿到地址或用完总预算：

- 单个脚本 12s 超时
- 整条回退链总预算 25s（脚本装得再多，也不会让播放键转几分钟）
- 返回非 http(s)、抛错、没有启用的脚本——任何一条都回落到内置 provider 的结果

也就是说装上自定义源**不会让原本能放的歌变成不能放**，最多是播放前多等几百毫秒。

## 实测情况（逐脚本单测：每脚本独立目录、独立 host）

**方法**：每个脚本单独一个目录、单独一个 host，用各平台搜索接口刚取到的**真实**歌曲标识测试，
避免因歌不存在而误判为"源挂了"。

### 2026-09 整合包（`skxingyu/lx_music-` 的 `0912-update.zip`，10 个脚本）

| 脚本 | wy | tx | kg |
|---|---|---|---|
| `K×H测试_v1.7.16.js`（72149 字节） | ✅ 320k | ✅ **无损 FLAC** | ✅ 320k |
| `K×H测试 v1.7.17.js`（68271 字节） | ✅ | ❌ | ✅ |
| 其余 8 个 | ❌ | ❌ | ❌ |

`K×H测试_v1.7.16.js` 取 tx 无损时返回 `F0000049nrGL0tLSWh.flac`，实测 `HTTP 206` +
`fLaC` 文件头 + 27.8 MB 总长 —— 是完整的真无损，不是试听片段。**注意：版本号更高的 v1.7.17 反而
tx 不通，别想当然用最新版。**

### 2024–2025 老脚本（23 个）

| 平台 | 可用 |
|---|---|
| wy | `sixyin-music-source-v1.2.0/1.2.1-encrypt.js`、`六音音源-v1.2.0-encrypt.js`、`lx-music-source.js`、`小熊猫v1.1.1.js`、`小熊猫音源1.1.2.js` |
| kg | `monster.js`、`無名v0.0.3.js` |
| tx | **无** |

### 两条踩过的坑

1. **必须用真实歌曲 ID 测**。用编造的 ID 会得到 404，很容易误判成"服务全挂了"。
2. **`野花v1.js` 是旧版**（md5 `28a6d8f0…`），官方配置要求 `9ee1b574…`。它的服务器
   `97.64.37.235` 还活着（根路径 403），但 `/flower/v1/url/...` 已 404 —— 旧的 API 路径废弃了。
   `pdone/lx-music-source` 仓库里的 `flower/latest.js` **也是同一份旧版**（md5 相同），别以为叫
   `latest` 就是新的。

## 已知限制（这一版）

1. **不能给媒体地址补请求头**。有些源要求 `Referer` 才能播放，LX 脚本协议本身不带这个能力（MusicFree 的插件协议带），
   这类地址可能 403。要做的话得在主进程的媒体请求钩子里给已登记的 URL 按域名补头，是下一步。
   注意：脚本自己的 `lx.request` **可以**带任意头，实测野花的 `ver`/`source-ver`/`tag` 头都正常发出去了。
2. **管理界面在 设置 → 高级 → 自定义音源**：列出脚本、逐条启停、从 URL / 从文件安装、重载、移除（进回收站）。
3. **没有版本更新**。LX 的 `updateAlert` 事件会被接收但忽略。
4. **未做 `local` 源**。LX 的 `local` 源是给本地文件取地址的，Folia 的本地库不走 provider，用不上。
5. **可信代码**。脚本有完整网络能力，和 Folium 模组同一套信任模型，别装来路不明的脚本。
   脚本抛出的异常会被拦在回调边界内；它自己没 catch 的 Promise 拒绝由主进程的崩溃日志兜住（`electron/debug/crashLog.cjs`），
   不会带崩应用。

## 手机版（Android）

桌面版的宿主是主进程（`custom-source/lxHost.cjs`）。手机上没有主进程，同样的规则在 WebView 里重写了一遍，
落在 `src/extensions/customSource/lx/` 与 `.../mobile/`：脚本照旧是 LX 协议，只是三样 Node 能力换成浏览器能做的。

| 桌面（主进程） | 手机（WebView） | 为什么 |
|---|---|---|
| `vm.runInContext` 沙箱 | `new Function` + 参数注入 | WebView 没有 `vm`。用参数而不是 `with`，是因为脚本首行常写 `'use strict'`，`with` 在严格模式下是语法错误 |
| `node:http` / `https` | `CapacitorHttp`（原生层） | 页面的 `fetch` 受 CORS 约束，音源脚本要连的第三方 API 不给头。走原生栈，页面看不到那些域 |
| `node:fs` | `@capacitor/filesystem` | 脚本存在应用私有目录 `custom-sources/`，不需要存储权限，卸载即清 |
| `node:crypto` | crypto-js（MD5/SHA/AES）+ BigInt 手写 RSA | 脚本是同步调用的，Web Crypto 是异步的用不了。RSA 只有 weapi 用的 `RSA_NO_PADDING` 一种，就是一次模幂 |
| `node:zlib` | fflate（项目已依赖） | 同上，同步 + 浏览器可用 |

手机上**不能做的事**：

- **「打开目录」没有意义**。脚本在应用私有目录，系统文件管理器看不到。按钮会提示改用两种安装方式。
- **「从文件安装」走系统文件选择器**（`<input type="file">`），不是自建的文件浏览器 —— Android 上这是唯一不需要存储权限就能读到任意 `.js` 的办法。
- **没有 `mediaPolicy`**。桌面版是主进程给媒体请求补 CORS 头；手机上没有这一层，波形能不能分析取决于音源 CDN 自己给不给
  `Access-Control-Allow-Origin`。实测网易云（`m701.music.126.net`）和酷狗（`fsandroid.tx.kugou.com`）都给 `*`。

### 构建

```bash
npm run build:mobile      # vite build + cap sync android
npm run android:open      # 用 Android Studio 打开 android/ 工程，连真机点 Run
```

命令行出 APK（需要 `ANDROID_HOME` 指向 SDK）：

```bash
cd android && ./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

Android SDK 不在 `npm install` 的范围里：装 Android Studio 时勾上 SDK Platform 36 + Platform-Tools 即可。

### 搜索与歌单：内置音源（`src/extensions/builtin`）

自定义音源协议**不含搜索**，它只回答"这首歌的播放地址"。桌面版能在 Folia 里搜歌，是因为 Electron 主进程内嵌并启动了
网易云 / QQ / 酷狗三个 API 服务，provider 只是去问它们；WebView 里跑不了 Node 服务，所以那三个 provider 在手机上
一律报 `unavailable`。落雪（LX Music）手机端没有这个问题的原因很简单：它的搜索是**播放器内置**的，由内置 SDK 直接打
平台接口（`src/renderer/utils/musicSdk/{wy,tx,kg}/musicSearch.js`），网络层在原生侧，不受 CORS 约束。

所以这里补了一个同类的源：`builtin`（界面上叫「内置音源」）。它没有账号、没有服务端，做三件事：

| 能力 | 实现 | 实测 |
|---|---|---|
| 搜索 | `POST music.163.com/api/cloudsearch/pc`，失败回落 `GET c.y.qq.com/soso/fcgi-bin/client_search_cp` | 网易云 300 条 / QQ 1001 条，字段完整 |
| 取址 | 交给自定义音源：按歌曲所属平台选 `wy`/`tx`/`kg` 源，把 `songmid`/`strMediaMid`/`hash` 传进去 | 依赖你装的脚本 |
| 歌词 | `music.163.com/api/song/lyric`（`lv/kv/tv`）、`c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg` | 42 行，时间轴正确 |

落雪现在的网易云搜索走 eapi 签名（`/api/search/song/list/page`），上面用的是它注释掉的那条旧路径 —— **免加密、免签名**，
省掉复刻算法这一大块。QQ / 网易云的公开接口此刻都还能用。

走的是 `fetch`，而 Android 壳把 `fetch` 打到了原生栈（`plugins.CapacitorHttp.enabled`），所以和落雪的 `httpFetch`
是同一件事。**手机端默认就落在这个源上**（`useOnlineProviderAccountStore.getInitialProviderId`），否则新装的 App 会停在
一个必然 `unavailable` 的平台上，搜索框是死的。

### 导入歌单（.lxmc）

落雪导出的 `.lxmc` 是 **gzip 压缩的 JSON**（`type: "playList_v2"`），结构：

```
{ type, data: [ { id, name, source?, list: [ Song ] } ] }      // 整体导出，data 是数组
{ type, data: { id, name, list: [...] } }                      // 单个歌单导出

Song = { id:"wy_417250673", name, singer, source:"wy", interval:"03:48",
         meta:{ songId, albumName, albumId, picUrl,
                qualitys:[{type:"320k", hash:"…"}] } }         // 酷狗每个音质一个 hash
```

`meta` 里的字段正好就是自定义音源取址要的入参，所以**导入的歌单不需要搜索、不需要登录就能播**。转换规则：

- `wy` / `kw` → `songmid` = `meta.songId`
- `tx` → `songmid` = `meta.songId`（就是 mid），另有 `strMediaMid` = `meta.strMediaMid`
- `kg` → `hash` = `qualitys` 里 320k 那条（没有就取最后一条带 hash 的）
- 每首歌带 `sourceRef = { kind:'online', providerId:'builtin', mediaId:'wy:417250673' }`，播放时按平台路由

歌单存在 IndexedDB 的一格缓存里（`builtin_imported_playlists`），主页直接把它们并入平台歌单前面
（`homeSources.ts` 的 `resolveHomeOnlineSource`：平台摘要里没有的那些就是导入的，单独排在前面），所以**不登录也有歌单**。
同名歌单重新导入是覆盖，不是追加。

两个入口，都只认文件内容、不认扩展名：

| 入口 | 位置 | 行为 |
|---|---|---|
| 首页 → 本地 → 「导入歌单」 | 三套首页 surface 共用的文件框（`PLAYLIST_FILE_ACCEPT`） | `.m3u/.m3u8` 按路径匹配本地歌曲；`.lxmc/.json` 由 `createLibraryHomePort` 转给内置音源，成功后提示「已按落雪歌单导入…」 |
| 设置 → 高级 → 自定义音源 → 「导入的歌单」 | `CustomSourcesPage.tsx` | 只收落雪歌单，文件框不带类型过滤，失败会说明原因 |

判定是 `looksLikeLxPlaylist()`：前两字节 `1f 8b`（gzip）就是 `.lxmc`，否则看是不是 `{ "type": "playList…" }` 的 JSON。
两者都不是就回落到本地 m3u 匹配，不会闷声失败。首页「歌单」页签下，导入的歌单不挂账户 —— 未登录或平台无账户时照样显示
（`LibraryTuiHomeLists` / `Grid3D` 里那两个「未登录 / 该来源没有曲库」面板只在没有自己的歌单时才盖住列表）。

## 相关文件

| 文件 | 作用 |
|---|---|
| `custom-source/lxHost.cjs` | 桌面：脚本加载、元信息解析、`vm` 沙箱、`lx` API、取址与多脚本回退 |
| `custom-source/http.cjs` | 桌面：`lx.request` 实现（无 CORS、跟随重定向、解码、自动 JSON.parse） |
| `custom-source/mediaPolicy.cjs` | 桌面：给脚本发出的地址补 CORS 响应头，否则 Web Audio 分析不出波形 |
| `custom-source/smoke-real.cjs` | 开发用：不开 Electron 直接拿真实脚本试初始化与取址 |
| `src/extensions/customSource/lx/scriptHost.ts` | 手机：与 `lxHost.cjs` 同规则的重写，IO / 网络 / 加密由外部注入 |
| `src/extensions/customSource/lx/crypto.ts` | 手机：`lx.utils.crypto` / `lx.utils.zlib` 的浏览器实现 |
| `src/extensions/customSource/mobile/` | 手机：`CapacitorHttp` 版 `lx.request`、`Filesystem` 版脚本目录、桥的组装 |
| `src/extensions/customSource/bridge.ts` | 两端共用的入口：有宿主就返回它，没有就返回 null |
| `src/extensions/customSource/index.ts` | 把 `netease`/`kugou`/`qq` 的 `playback.getAudioSource` 包一层 |
| `src/extensions/builtin/model.ts` | 内置源：`wy:417250673` 这种 id 的编解码，以及"歌曲 → 音源入参"的转换 |
| `src/extensions/builtin/lxmc.ts` | 内置源：`.lxmc` / `.json` 歌单解析（gzip 自动识别） |
| `src/extensions/builtin/store.ts` | 内置源：导入歌单的持久化与变更通知 |
| `src/extensions/builtin/search.ts` | 内置源：网易云 / QQ 直连搜索 |
| `src/extensions/builtin/lyrics.ts` | 内置源：网易云 / QQ 直连歌词 |
| `src/extensions/builtin/provider.ts` | 内置源：注册成 `builtin` provider（搜索 / 取址 / 歌词 / 导入歌单） |
| `src/library/core/home/playlistFileAccept.ts` | 首页「导入歌单」文件框收哪些扩展名（`.m3u/.m3u8/.lxmc/.json`，三套 surface 共用） |
| `test/manual/builtin_search_probe.ts` | 开发用：不开 App 直接跑搜索 + 歌词（`npx tsx test/manual/builtin_search_probe.ts 歌名 [--qq]`） |
| `test/manual/builtin_import_probe.ts` | 开发用：解析一个真实 `.lxmc` 并打印结果 |
| `electron/main.cjs` | 桌面：IPC 通道、媒体策略挂载 |
| `electron/preload.cjs` | 桌面：`window.electron.customSource` |
| `android/` | Capacitor 生成的 Android 工程（`appId` = `com.folia.music`） |
