import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'crypto';
import fs from 'fs';
import fsOriginal from 'original-fs';
import os from 'os';
import path from 'path';
import fse from 'fs-extra';
import i18next from 'i18next';
import pinyin from 'pinyin';

import { getAssetPath } from './paths';
import { refreshAutoBackupScheduler, sanitizeAutoBackupInterval } from './autoBackup';
import { validateLatestBackupForGame } from './backupMetadata';
import { backupGame, getGameDataFromDB, updateDatabase } from './backup';
import { detectGamePaths, getGameData } from './gameData';
import { getGameDataForRestore, restoreGame } from './restore';
import { AppStatusBusyError, getAppStatus, updateAppStatus, withAppStatus } from './appStatus';
import type { AppStatusKey } from './appStatus';
import { getNewestBackup, moveFilesWithProgress } from './backupMigration';
import { openAllowedExternalUrl } from './externalLinks';
import { osKeyMap } from './platformPlaceholders';
import { getSettings, saveSettings } from './settingsService';
import { getCurrentVersion, getLatestVersion } from './updateService';
import { getMainWindow } from './windowManager';
import type { SettingsKey, SettingsValue } from '../types/settings';

type SanitizedSettingsUpdate = {
    [K in SettingsKey]: [K, SettingsValue<K>]
}[SettingsKey];

const supportedLanguages = new Set<SettingsValue<'language'>>(['en_US', 'zh_CN', 'zh_TW']);

const allowedStatusKeys = new Set<string>(['backuping', 'restoring', 'migrating', 'updating_db']);
const statusMessageKeys: Record<AppStatusKey, string> = {
    backuping: 'alert.wait_for_backup',
    auto_backuping: 'alert.wait_for_backup',
    restoring: 'alert.wait_for_restore',
    migrating: 'alert.wait_for_migrate',
    updating_db: 'alert.wait_for_updating_db',
};

const isSafeId = (value: unknown): value is string => {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);
};

const isSupportedLanguage = (value: string): value is SettingsValue<'language'> => {
    return supportedLanguages.has(value as SettingsValue<'language'>);
};

const getStatusBusyMessage = (error: unknown): string | null => {
    if (!(error instanceof AppStatusBusyError)) {
        return null;
    }

    const activeStatusKey = error.activeStatusKeys[0];
    return i18next.t(statusMessageKeys[activeStatusKey] || 'alert.wait_for_backup');
};

const sanitizeSettingsValue = (key: string, value: unknown): SanitizedSettingsUpdate | null => {
    switch (key) {
        case 'theme':
            return value === 'light' || value === 'dark' ? [key, value] : null;
        case 'language': {
            const language = String(value);
            return isSupportedLanguage(language) ? [key, language] : null;
        }
        case 'backupPath':
            return typeof value === 'string' && path.isAbsolute(value) ? [key, value] : null;
        case 'maxBackups': {
            const maxBackups = Number.parseInt(String(value), 10);
            if (!Number.isFinite(maxBackups)) return null;
            return [key, Math.min(Math.max(maxBackups, 1), 1000)];
        }
        case 'autoAppUpdate':
        case 'autoDbUpdate':
        case 'autoBackupEnabled':
            return typeof value === 'boolean' ? [key, value] : null;
        case 'autoBackupInterval':
            return [key, sanitizeAutoBackupInterval(value)];
        case 'excludedBackupPatterns':
            if (!Array.isArray(value)) return null;
            return [key, value
                .map(item => String(item).trim())
                .filter(item => item.length > 0 && item.length <= 500)
                .slice(0, 200)];
        case 'backupSizeWarningEnabled':
            return typeof value === 'boolean' ? [key, value] : null;
        case 'backupSizeWarningThresholdMb': {
            const thresholdMb = Number.parseInt(String(value), 10);
            if (!Number.isFinite(thresholdMb)) return null;
            return [key, Math.min(Math.max(thresholdMb, 1), 102400)];
        }
        case 'backupSizeWarningMultiplier': {
            const multiplier = Number.parseFloat(String(value));
            if (!Number.isFinite(multiplier)) return null;
            return [key, Math.min(Math.max(multiplier, 1), 100)];
        }
        case 'gameInstalls':
            if (!Array.isArray(value)) return null;
            return [key, value.filter(item => typeof item === 'string' && path.isAbsolute(item))];
        case 'pinnedGames':
            if (!Array.isArray(value)) return null;
            return [key, value.map(String).filter(isSafeId)];
        default:
            return null;
    }
};

const registerIpcHandlers = () => {
    ipcMain.handle('translate', async (event, key: string, options: any) => {
        return i18next.t(key, options);
    });

    ipcMain.on('save-settings', async (event, key: string, value: any) => {
        const sanitized = sanitizeSettingsValue(key, value);
        if (!sanitized) {
            console.warn(`Rejected invalid settings update: ${key}`);
            return;
        }
        const [settingsKey, settingsValue] = sanitized;
        saveSettings(settingsKey, settingsValue);
        if (settingsKey === 'autoBackupEnabled' || settingsKey === 'autoBackupInterval') {
            refreshAutoBackupScheduler(true);
        }
    });

    ipcMain.on('load-theme', (event) => {
        event.reply('apply-theme', getSettings().theme);
    });

    ipcMain.handle('get-settings', () => {
        return getSettings();
    });

    ipcMain.handle('get-detected-game-paths', async () => {
        await detectGamePaths();
        return getGameData().detectedGamePaths;
    });

    ipcMain.handle('open-url', async (event, url: string) => {
        const opened = await openAllowedExternalUrl(url);
        if (!opened) {
            console.warn(`Blocked external URL: ${url}`);
        }
    });

    ipcMain.handle('open-backup-folder', async (event, wikiId: string) => {
        if (!isSafeId(wikiId)) {
            return;
        }
        const backupPath = path.join(getSettings().backupPath, wikiId.toString());
        if (fsOriginal.existsSync(backupPath) && fsOriginal.readdirSync(backupPath).length > 0) {
            await shell.openPath(backupPath);
        } else {
            getMainWindow()!.webContents.send('show-alert', 'warning', i18next.t('alert.no_backups_found'));
        }
    });

    ipcMain.handle('open-backup-dialog', async () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();

        if (!focusedWindow) {
            return null;
        }

        const result = await dialog.showOpenDialog(focusedWindow, {
            title: i18next.t('settings.select_backup_path'),
            properties: ['openDirectory']
        });

        if (result.filePaths.length > 0) {
            return path.join(result.filePaths[0], 'GSM Backups');
        }

        return null;
    });

    ipcMain.handle('open-dialog', async () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();

        if (!focusedWindow) {
            return null;
        }

        const result = await dialog.showOpenDialog(focusedWindow, {
            title: i18next.t('settings.select_path'),
            properties: ['openDirectory']
        });

        return result;
    });

    ipcMain.handle('select-path', async (event, fileType: string) => {
        const focusedWindow = BrowserWindow.getFocusedWindow();

        if (!focusedWindow) {
            return null;
        }

        let dialogOptions: any = {
            title: i18next.t('settings.select_path'),
            properties: []
        };

        switch (fileType) {
            case 'file':
                dialogOptions.properties = ['openFile'];
                break;
            case 'folder':
                dialogOptions.properties = ['openDirectory'];
                break;
            case 'registry':
                return null;
            default:
                return null;
        }

        const result = await dialog.showOpenDialog(focusedWindow, {
            ...dialogOptions,
            modal: true
        });

        if (result.filePaths.length > 0) {
            return result.filePaths[0];
        }

        return null;
    });

    ipcMain.handle('get-newest-backup-time', (event, wikiPageId: string) => {
        if (!isSafeId(wikiPageId)) {
            return i18next.t('main.no_backups');
        }
        return getNewestBackup(wikiPageId);
    });

    ipcMain.handle('sort-games', (event, games: any[]) => {
        const gamesWithSortedTitles = games.map((game) => {
            try {
                const isChinese = /[\u4e00-\u9fff]/.test(game.titleToSort);
                const titleToSort = isChinese
                    ? pinyin(game.titleToSort, { style: pinyin.STYLE_NORMAL }).join(' ')
                    : game.titleToSort.toLowerCase();
                return { ...game, titleToSort };

            } catch (error) {
                console.error(`Error sorting game ${game.titleToSort}: ${error.stack}`);
                getMainWindow()!.webContents.send('show-alert', 'modal', `${i18next.t('alert.sort_failed', { game_name: game.titleToSort })}`, error.message);
                return { ...game, titleToSort: '' };
            }
        });

        return gamesWithSortedTitles.sort((a, b) => {
            return a.titleToSort.localeCompare(b.titleToSort);
        });
    });

    ipcMain.handle('save-custom-entries', async (event, jsonObj: any) => {
        try {
            const filePath = path.join(getSettings().backupPath, 'custom_entries.json');
            let currentData = {};

            if (fs.existsSync(filePath)) {
                currentData = await fse.readJson(filePath);
            }

            if (JSON.stringify(currentData) !== JSON.stringify(jsonObj)) {
                await fse.writeJson(filePath, jsonObj, { spaces: 4 });
                getMainWindow()!.webContents.send('show-alert', 'success', i18next.t('alert.save_custom_success'));
                getMainWindow()!.webContents.send('update-backup-table');
            }

        } catch (error) {
            console.error(`Error saving custom games: ${error.stack}`);
            getMainWindow()!.webContents.send('show-alert', 'modal', i18next.t('alert.save_custom_error'), error.message);
        }
    });

    ipcMain.handle('load-custom-entries', async () => {
        try {
            const filePath = path.join(getSettings().backupPath, 'custom_entries.json');

            const fileExists = await fse.pathExists(filePath);
            if (!fileExists) {
                return [];
            }

            const jsonData = await fse.readJson(filePath);
            return jsonData;

        } catch (error) {
            console.error(`Error loading custom games: ${error.stack}`);
            getMainWindow()!.webContents.send('show-alert', 'modal', i18next.t('alert.load_custom_error'), error.message);
            return [];
        }
    });

    ipcMain.handle('get-platform', () => {
        return osKeyMap[os.platform() as keyof typeof osKeyMap];
    });

    ipcMain.handle('get-uuid', () => {
        return randomUUID();
    });

    ipcMain.handle('get-icon-map', async () => {
        return {
            'Custom': fs.readFileSync(getAssetPath('custom.svg'), 'utf-8'),
            'Steam': fs.readFileSync(getAssetPath('steam.svg'), 'utf-8'),
            'Ubisoft': fs.readFileSync(getAssetPath('ubisoft.svg'), 'utf-8'),
            'EA': fs.readFileSync(getAssetPath('ea.svg'), 'utf-8'),
            'Epic': fs.readFileSync(getAssetPath('epic.svg'), 'utf-8'),
            'GOG': fs.readFileSync(getAssetPath('gog.svg'), 'utf-8'),
            'Xbox': fs.readFileSync(getAssetPath('xbox.svg'), 'utf-8'),
            'Blizzard': fs.readFileSync(getAssetPath('battlenet.svg'), 'utf-8'),
        };
    });

    ipcMain.handle('fetch-backup-table-data', async () => {
        const { games, errors } = await getGameDataFromDB();

        if (errors.length > 0) {
            getMainWindow()!.webContents.send('show-alert', 'modal', i18next.t('alert.backup_process_error_display'), errors);
        }

        return games;
    });

    ipcMain.handle('backup-game', async (event, gameObj: any) => {
        if (!gameObj || !isSafeId(String(gameObj.wiki_page_id))) {
            return i18next.t('alert.backup_process_error_display');
        }
        try {
            return await withAppStatus('backuping', () => backupGame(gameObj));
        } catch (error) {
            const busyMessage = getStatusBusyMessage(error);
            if (busyMessage) {
                return busyMessage;
            }
            throw error;
        }
    });

    ipcMain.handle('fetch-restore-table-data', async () => {
        const { games, errors } = await getGameDataForRestore();

        if (errors.length > 0) {
            getMainWindow()!.webContents.send('show-alert', 'modal', i18next.t('alert.restore_process_error_display'), errors);
        }

        return games;
    });

    ipcMain.handle('restore-game', async (event, gameObj: any, userActionForAll: any) => {
        if (!gameObj || !isSafeId(String(gameObj.wiki_page_id))) {
            return { action: null, error: i18next.t('alert.restore_process_error_display') };
        }
        try {
            return await withAppStatus('restoring', () => restoreGame(gameObj, userActionForAll));
        } catch (error) {
            const busyMessage = getStatusBusyMessage(error);
            if (busyMessage) {
                return { action: null, error: busyMessage };
            }
            throw error;
        }
    });

    ipcMain.handle('validate-backup', async (event, gameObj: any) => {
        if (!gameObj || !isSafeId(String(gameObj.wiki_page_id))) {
            return {
                valid: false,
                backup_path: '',
                checked_files: 0,
                missing_files: 0,
                errors: [i18next.t('alert.restore_process_error_display')],
                warnings: [],
            };
        }
        return await validateLatestBackupForGame(gameObj);
    });

    ipcMain.on('migrate-backups', (event, newBackupPath: string) => {
        if (typeof newBackupPath !== 'string' || !path.isAbsolute(newBackupPath)) {
            console.warn(`Rejected invalid backup migration path: ${newBackupPath}`);
            return;
        }
        const currentBackupPath = getSettings().backupPath;
        moveFilesWithProgress(currentBackupPath, newBackupPath).catch(error => {
            const busyMessage = getStatusBusyMessage(error);
            if (busyMessage) {
                getMainWindow()?.webContents.send('show-alert', 'warning', busyMessage);
                return;
            }
            getMainWindow()?.webContents.send('show-alert', 'modal', i18next.t('alert.error_during_backup_migration'), error instanceof Error ? error.message : String(error));
        });
    });

    ipcMain.handle('get-status', () => {
        return getAppStatus();
    });

    ipcMain.on('update-status', (event, statusKey: string, statusValue: any) => {
        if (!allowedStatusKeys.has(statusKey) || typeof statusValue !== 'boolean') {
            console.warn(`Rejected invalid status update: ${statusKey}`);
            return;
        }
        const updated = updateAppStatus(statusKey as AppStatusKey, statusValue);
        if (!updated) {
            console.warn(`Ignored renderer status update while locked: ${statusKey}`);
        }
    });

    ipcMain.handle('get-current-version', () => {
        return getCurrentVersion();
    });

    ipcMain.handle('get-latest-version', () => {
        return getLatestVersion();
    });

    ipcMain.handle('update-database', async () => {
        try {
            await withAppStatus('updating_db', () => updateDatabase());
        } catch (error) {
            const busyMessage = getStatusBusyMessage(error);
            if (busyMessage) {
                getMainWindow()?.webContents.send('show-alert', 'warning', busyMessage);
                return;
            }
            throw error;
        }
        return;
    });
};

export {
    isSafeId,
    registerIpcHandlers,
    sanitizeSettingsValue,
};
