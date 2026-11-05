import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Link2, ListMusic, RefreshCw, Trash2, Upload } from 'lucide-react';
import { Button, Group, Row, Status, TextField, Toggle, option, type SettingsGroupDef, type SettingsOptionDef } from '../kit';
import { getCustomSourceBridge, hasCustomSourceHost } from '../../../../extensions/customSource/bridge';
import { pickAndImportPlaylist, removeImportedPlaylist } from '../../../../extensions/builtin';
import { PLATFORM_LABEL } from '../../../../extensions/builtin/model';
import { useImportedPlaylists } from '../../../../extensions/builtin/useImportedPlaylists';

// src/components/modal/settings/pages/CustomSourcesPage.tsx
// The 自定义音源 page: the LX style scripts that answer "where is this song's audio", the switch for
// each, and the two ways of installing one.
//
// A script is a file the host owns - `<userData>/custom-sources` in the desktop app, the app's private
// data directory on Android - and the sandbox the scripts run in is the host's too. So everything here
// goes through the bridge (`src/extensions/customSource/bridge.ts`) and every answer already carries
// the new list: the page never keeps its own copy of the truth.

// Visible wherever a script host exists, which is the desktop app and the Android shell, but not a
// browser tab.
const available = () => hasCustomSourceHost();

const INSTALLED: SettingsGroupDef = { id: 'customSourcesInstalled', titleKey: 'customSources.installed', available };
const INSTALL: SettingsGroupDef = { id: 'customSourcesInstall', titleKey: 'customSources.install', available };
// Importing a playlist file needs no script host: it is the listener's own data, parsed in the page.
// It is on this page because a list of platform songs is only playable through a custom source.
const PLAYLISTS: SettingsGroupDef = { id: 'customSourcesPlaylists', titleKey: 'customSources.importedPlaylists' };

const O = {
    fromUrl: option(INSTALL, 'customSourceFromUrl', 'customSources.fromUrl'),
    fromFile: option(INSTALL, 'customSourceFromFile', 'customSources.fromFile'),
    importPlaylist: option(PLAYLISTS, 'customSourceImportPlaylist', 'customSources.importPlaylist'),
};

export const OPTIONS: SettingsOptionDef[] = Object.values(O);

type Tone = 'ok' | 'warn' | 'error';

interface Notice {
    tone: Tone;
    text: string;
}

/** Every call answers with the list; install answers with `{ file, list }`, the rest with the list. */
const listFrom = (data: CustomSourceInstallEnvelope['data'] | CustomSourceListData | undefined): CustomSourceListData | null => {
    if (!data) return null;
    if ('scripts' in data) return data;
    return data.list ?? null;
};

const scriptStatus = (script: CustomSourceScript): { tone: Tone; textKey: string } => {
    if (script.error) return { tone: 'error', textKey: 'customSources.statusFailed' };
    if (!script.enabled) return { tone: 'warn', textKey: 'customSources.statusDisabled' };
    return { tone: 'ok', textKey: 'customSources.statusReady' };
};

/**
 * 导入的歌单. Not a custom source: a playlist file is the listener's own data, parsed in the page
 * with no host and no account. It belongs on this page because an imported list is made of platform
 * songs, and only a custom source can turn those into audio.
 */
const ImportedPlaylistsGroup: React.FC = () => {
    const { t } = useTranslation();
    const playlists = useImportedPlaylists();
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<Notice | null>(null);

    const importNow = async () => {
        setBusy(true);
        setNotice(null);
        try {
            const result = await pickAndImportPlaylist();
            if (result.status === 'imported') {
                const { added, replaced, skipped, playlists: parsed } = result.outcome;
                if (parsed.length === 0) {
                    // gzip/JSON that held no list at all: say so instead of "新增 0 个、覆盖 0 个".
                    setNotice({ tone: 'warn', text: t('customSources.importPlaylistEmpty') });
                    return;
                }
                setNotice({
                    tone: skipped > 0 ? 'warn' : 'ok',
                    text: t('customSources.importPlaylistDone', { added, replaced, skipped }),
                });
            } else if (result.status === 'failed') {
                setNotice({ tone: 'error', text: result.message });
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <Group
            def={PLAYLISTS}
            action={(
                <Button icon={ListMusic} disabled={busy} tip={t('customSources.importPlaylistHint')} onClick={() => void importNow()}>
                    {t('customSources.importPlaylistAction')}
                </Button>
            )}
        >
            {playlists.length === 0 ? (
                <p className="px-4 py-6 text-center text-[13px] text-[color:var(--st-t3)]">{t('customSources.playlistsEmpty')}</p>
            ) : playlists.map(playlist => (
                <div key={playlist.id} className="border-t border-[color:var(--st-line)] px-4 py-3 first:border-t-0">
                    <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-medium text-[color:var(--st-t1)]">{playlist.name}</div>
                            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-[color:var(--st-t3)]">
                                <span>{t('customSources.playlistTracks', { n: playlist.songs.length })}</span>
                                {playlist.platform ? <span>· {PLATFORM_LABEL[playlist.platform]}</span> : null}
                            </div>
                        </div>
                        <Button
                            variant="quiet"
                            icon={Trash2}
                            disabled={busy}
                            onClick={() => void removeImportedPlaylist(playlist.id)}
                        >
                            {t('customSources.remove')}
                        </Button>
                    </div>
                </div>
            ))}
            {notice ? (
                <p
                    className={`px-4 py-3 text-[12px] leading-5 ${notice.tone === 'error' ? 'text-[color:var(--st-err)]' : 'text-[color:var(--st-ok)]'}`}
                    role="status"
                >
                    {notice.text}
                </p>
            ) : null}
        </Group>
    );
};

const CustomSourcesPage: React.FC = () => {
    const { t } = useTranslation();
    const bridge = getCustomSourceBridge();

    const [list, setList] = useState<CustomSourceListData | null>(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<Notice | null>(null);
    const [url, setUrl] = useState('');

    const refresh = useCallback(async () => {
        if (!bridge) return;
        const result = await bridge.list();
        const next = listFrom(result.data);
        if (result.ok && next) setList(next);
    }, [bridge]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    /** Runs one bridge call, then adopts whatever list it answered with. */
    const run = useCallback(async (
        action: () => Promise<{ ok: boolean; data?: CustomSourceInstallEnvelope['data'] | CustomSourceListData; error?: { code: string; message: string } }>,
        successText?: string,
    ) => {
        setBusy(true);
        setNotice(null);
        try {
            const result = await action();
            const next = listFrom(result.data);
            if (next) setList(next);
            if (!result.ok) {
                setNotice({ tone: 'error', text: result.error?.message || t('customSources.actionFailed') });
                return false;
            }
            if (successText) setNotice({ tone: 'ok', text: successText });
            return true;
        } catch (error) {
            setNotice({ tone: 'error', text: String((error as Error)?.message || error) });
            return false;
        } finally {
            setBusy(false);
        }
    }, [t]);

    if (!bridge) {
        // The lists below need no host, so they are shown even where scripts cannot run.
        return (
            <>
                <ImportedPlaylistsGroup />
                <p className="px-1 pt-3 text-[13px] text-[color:var(--st-t2)]">{t('customSources.desktopOnly')}</p>
            </>
        );
    }

    const scripts = list?.scripts ?? [];

    const installFromUrl = async () => {
        const trimmed = url.trim();
        if (!trimmed) return;
        const done = await run(() => bridge.installFromUrl(trimmed), t('customSources.installDone'));
        if (done) setUrl('');
    };

    return (
        <>
            <ImportedPlaylistsGroup />

            <Group
                def={INSTALLED}
                action={(
                    <div className="flex items-center gap-1">
                        <Button icon={RefreshCw} disabled={busy} tip={t('customSources.reloadHint')} onClick={() => void run(() => bridge.reload())}>
                            {t('customSources.reload')}
                        </Button>
                        <Button icon={FolderOpen} disabled={busy} tip={list?.dir} onClick={() => void run(() => bridge.openFolder())}>
                            {t('customSources.openFolder')}
                        </Button>
                    </div>
                )}
                foot={list?.dir ? <span className="truncate">{list.dir}</span> : undefined}
            >
                {scripts.length === 0 ? (
                    <p className="px-4 py-6 text-center text-[13px] text-[color:var(--st-t3)]">{t('customSources.empty')}</p>
                ) : scripts.map(script => {
                    const status = scriptStatus(script);
                    const sources = Object.values(script.sources ?? {}).map(source => source.name).filter(Boolean);
                    return (
                        <div key={script.file} className="border-t border-[color:var(--st-line)] px-4 py-3 first:border-t-0">
                            <div className="flex items-start gap-3">
                                <div className="min-w-0 flex-1">
                                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                        <span className="truncate text-[13px] font-medium text-[color:var(--st-t1)]">{script.name}</span>
                                        {script.version ? <span className="text-[11px] text-[color:var(--st-t3)]">v{script.version}</span> : null}
                                        <Status tone={status.tone}>{t(status.textKey)}</Status>
                                    </div>
                                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[color:var(--st-t3)]">
                                        <span className="truncate">{script.file}</span>
                                        {sources.length > 0 ? <span>· {sources.join(' / ')}</span> : null}
                                    </div>
                                    {script.error ? (
                                        <p className="mt-1 break-words text-[11px] leading-4 text-[color:var(--st-err)]">{script.error}</p>
                                    ) : null}
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                    <Toggle
                                        checked={script.enabled}
                                        onChange={checked => void run(() => bridge.setEnabled(script.file, checked))}
                                    />
                                    <Button
                                        variant="quiet"
                                        icon={Trash2}
                                        disabled={busy}
                                        tip={t('customSources.removeHint')}
                                        onClick={() => void run(() => bridge.remove(script.file), t('customSources.removeDone'))}
                                    >
                                        {t('customSources.remove')}
                                    </Button>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </Group>

            <Group def={INSTALL} action={<span className="text-[11px] text-[color:var(--st-t3)]">{t('customSources.trustNote')}</span>}>
                <Row option={O.fromUrl} hint={t('customSources.fromUrlHint')}>
                    <div className="flex w-full items-center gap-2">
                        <TextField
                            value={url}
                            onChange={setUrl}
                            onCommit={() => void installFromUrl()}
                            type="url"
                            placeholder="https://example.com/source.js"
                            disabled={busy}
                        />
                        <Button
                            icon={Link2}
                            disabled={busy || !url.trim()}
                            onClick={() => void installFromUrl()}
                        >
                            {t('customSources.fromUrlAction')}
                        </Button>
                    </div>
                </Row>
                <Row option={O.fromFile} hint={t('customSources.fromFileHint')}>
                    <Button
                        icon={Upload}
                        disabled={busy}
                        onClick={() => void run(() => bridge.installFromFile(), t('customSources.installDone'))}
                    >
                        {t('customSources.fromFileAction')}
                    </Button>
                </Row>
            </Group>

            {notice ? (
                <p
                    className={`mt-3 px-1 text-[12px] leading-5 ${notice.tone === 'error' ? 'text-[color:var(--st-err)]' : 'text-[color:var(--st-ok)]'}`}
                    role="status"
                >
                    {notice.text}
                </p>
            ) : null}
        </>
    );
};

export default CustomSourcesPage;
