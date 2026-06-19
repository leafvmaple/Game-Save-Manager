import { BrowserWindow, app } from 'electron';
import i18next from 'i18next';

import { startAutoBackupScheduler, stopAutoBackupScheduler } from './autoBackup';
import { detectGamePaths, getGameData, initializeGameData } from './gameData';
import { initializeI18next } from './i18nService';
import { registerIpcHandlers } from './ipcHandlers';
import { getSettings, loadSettings, saveSettings } from './settingsService';
import { checkAppUpdate } from './updateService';
import { createMainWindow } from './windowManager';

app.commandLine.appendSwitch('lang', 'en');
registerIpcHandlers();

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

    startAutoBackupScheduler();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
});

app.on('before-quit', () => {
    stopAutoBackupScheduler();
});
