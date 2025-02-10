import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'crypto';
import fs from 'fs';
import fsOriginal from 'original-fs';
import os from 'os';
import path from 'path';
import fse from 'fs-extra';
import i18next from 'i18next';
import Backend from 'i18next-fs-backend';
import pinyin from 'pinyin';

import { getAssetPath, getLocalePath } from './paths';

import {
    createMainWindow,
    getMainWindow,
    getNewestBackup,
    getAppStatus,
    updateAppStatus,
    checkAppUpdate,
    osKeyMap,
    loadSettings,
    saveSettings,
    getSettings,
    moveFilesWithProgress,
    getCurrentVersion,
    getLatestVersion
} from './global';

import {
    getGameData,
    initializeGameData,
    detectGamePaths
} from './gameData';

import {
    getGameDataFromDB,
    getAllGameDataFromDB,
    backupGame,
    updateDatabase
} from './backup';

import {
    getGameDataForRestore,
    restoreGame
} from "./restore";

app.commandLine.appendSwitch("lang", "en");

app.whenReady().then(async () => {
    loadSettings();
    await initializeI18next(getSettings().language);
    await initializeGameData();

    if (getSettings().gameInstalls === 'uninitialized') {
        await detectGamePaths();
        saveSettings('gameInstalls', getGameData().detectedGamePaths);
    }

    await createMainWindow();
    app.setAppUserModelId(i18next.t('main.title'));

    if (getSettings().autoAppUpdate) {
        checkAppUpdate();
    }

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
});

// Language settings
const initializeI18next = (language: string) => {
    return i18next
        .use(Backend)
        .init({
            lng: language,
            fallbackLng: "en_US",
            backend: {
                loadPath: getLocalePath("{{lng}}.json"),
            },
        });
};

// ======================================================================
// Listeners
// ======================================================================
ipcMain.handle("translate", async (event, key: string, options: any) => {
    return i18next.t(key, options);
});

ipcMain.on('save-settings', async (event, key: string, value: any) => {
    saveSettings(key, value);
});

ipcMain.on("load-theme", (event) => {
    event.reply("apply-theme", getSettings().theme);
});

ipcMain.handle("get-settings", () => {
    return getSettings();
});

ipcMain.handle("get-detected-game-paths", async () => {
    await detectGamePaths();
    return getGameData().detectedGamePaths;
});

ipcMain.handle('open-url', async (event, url: string) => {
    await shell.openExternal(url);
});

ipcMain.handle('open-backup-folder', async (event, wikiId: string) => {
    const backupPath = path.join(getSettings().backupPath, wikiId.toString());
    if (fsOriginal.existsSync(backupPath) && fsOriginal.readdirSync(backupPath).length > 0) {
        await shell.openPath(backupPath);
    } else {
        getMainWindow().webContents.send('show-alert', 'warning', i18next.t('alert.no_backups_found'));
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
    return getNewestBackup(wikiPageId);
});

// Sort objects using object.titleToSort
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
            getMainWindow().webContents.send('show-alert', 'modal', `${i18next.t('alert.sort_failed', { game_name: game.titleToSort })}`, error.message);
            return { ...game, titleToSort: '' };
        }
    });

    return gamesWithSortedTitles.sort((a, b) => {
        return a.titleToSort.localeCompare(b.titleToSort);
    });
});

ipcMain.handle('save-custom-entries', async (event, jsonObj: any) => {
    try {
        const filePath = path.join(getSettings().backupPath, "custom_entries.json");
        let currentData = {};

        if (fs.existsSync(filePath)) {
            currentData = await fse.readJson(filePath);
        }

        if (JSON.stringify(currentData) !== JSON.stringify(jsonObj)) {
            await fse.writeJson(filePath, jsonObj, { spaces: 4 });
            getMainWindow().webContents.send('show-alert', 'success', i18next.t('alert.save_custom_success'));
            getMainWindow().webContents.send('update-backup-table');
        }

    } catch (error) {
        console.error(`Error saving custom games: ${error.stack}`);
        getMainWindow().webContents.send('show-alert', 'modal', i18next.t('alert.save_custom_error'), error.message);
    }
});

ipcMain.handle('load-custom-entries', async () => {
    try {
        const filePath = path.join(getSettings().backupPath, "custom_entries.json");

        const fileExists = await fse.pathExists(filePath);
        if (!fileExists) {
            return [];
        }

        const jsonData = await fse.readJson(filePath);
        return jsonData;

    } catch (error) {
        console.error(`Error loading custom games: ${error.stack}`);
        getMainWindow().webContents.send('show-alert', 'modal', i18next.t('alert.load_custom_error'), error.message);
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
        getMainWindow().webContents.send('show-alert', 'modal', i18next.t('alert.backup_process_error_display'), errors);
    }

    return games;
});

ipcMain.handle('backup-game', async (event, gameObj: any) => {
    return await backupGame(gameObj);
});

ipcMain.handle('fetch-restore-table-data', async () => {
    const { games, errors } = await getGameDataForRestore();

    if (errors.length > 0) {
        getMainWindow().webContents.send('show-alert', 'modal', i18next.t('alert.restore_process_error_display'), errors);
    }

    return games;
});

ipcMain.handle('restore-game', async (event, gameObj: any, userActionForAll: any) => {
    return await restoreGame(gameObj, userActionForAll);
});

ipcMain.on('migrate-backups', (event, newBackupPath: string) => {
    const currentBackupPath = getSettings().backupPath;
    moveFilesWithProgress(currentBackupPath, newBackupPath);
});

ipcMain.handle('get-status', () => {
    return getAppStatus();
});

ipcMain.on('update-status', (event, statusKey: string, statusValue: any) => {
    updateAppStatus(statusKey, statusValue);
});

ipcMain.handle('get-current-version', () => {
    return getCurrentVersion();
});

ipcMain.handle('get-latest-version', () => {
    return getLatestVersion();
});

ipcMain.handle('update-database', async () => {
    await updateDatabase();
    return;
});