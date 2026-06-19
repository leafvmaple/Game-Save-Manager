import { BrowserWindow, app } from 'electron';
import fs from 'fs';
import i18next from 'i18next';
import path from 'path';

import { createDefaultSettings, normalizeSettings } from './settingsSchema';
import { getMainWindow, rebuildApplicationMenu } from './windowManager';
import type { AppSettings, Language, SettingsKey, SettingsValue } from '../types/settings';

let appSettings: AppSettings;
let writeQueue: Promise<void> = Promise.resolve();

const loadSettings = (): void => {
    const userDataPath = app.getPath('userData');
    const appDataPath = app.getPath('appData');
    const settingsPath = path.join(userDataPath, 'GSM Settings', 'settings.json');

    const localeMapping: Record<string, Language> = {
        'en-US': 'en_US',
        'zh-Hans-CN': 'zh_CN',
        'zh-Hans-SG': 'zh_CN',
        'zh-Hant-HK': 'zh_TW',
        'zh-Hant-MO': 'zh_TW',
        'zh-Hant-TW': 'zh_TW',
    };

    const systemLocale = app.getLocale();
    const detectedLanguage = localeMapping[systemLocale] || 'en_US';

    const defaultSettings = createDefaultSettings(appDataPath, detectedLanguage);

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

    try {
        const data = fs.readFileSync(settingsPath, 'utf8');
        const rawSettings = JSON.parse(data) as unknown;
        appSettings = normalizeSettings(rawSettings, defaultSettings);
        if (JSON.stringify(appSettings) !== JSON.stringify(rawSettings)) {
            writeSettingsFile(settingsPath, appSettings);
        }
    } catch (err) {
        console.error('Error loading settings, using defaults:', err);
        writeSettingsFile(settingsPath, defaultSettings);
        appSettings = defaultSettings;
    }
};

const saveSettings = <K extends SettingsKey>(key: K, value: SettingsValue<K>): Promise<void> => {
    const userDataPath = app.getPath('userData');
    const settingsPath = path.join(userDataPath, 'GSM Settings', 'settings.json');
    appSettings[key] = value;

    writeQueue = writeQueue.then(async () => {
        writeSettingsFile(settingsPath, appSettings);

        console.log(`Settings updated successfully: ${key}: ${value}`);
        if (key === 'theme') {
            BrowserWindow.getAllWindows().forEach(window => window.webContents.send('apply-theme', value));
        }
        if (key === 'gameInstalls') {
            getMainWindow()?.webContents.send('update-backup-table');
        }
        if (['excludedBackupPatterns', 'backupSizeWarningEnabled', 'backupSizeWarningThresholdMb', 'backupSizeWarningMultiplier'].includes(key)) {
            getMainWindow()?.webContents.send('update-backup-table');
        }
        if (key === 'language') {
            await i18next.changeLanguage(value as AppSettings['language']);
            BrowserWindow.getAllWindows().forEach(window => window.webContents.send('apply-language'));
            rebuildApplicationMenu();
        }
    }).catch(err => {
        console.error('Error in write queue:', err);
    });

    return writeQueue;
};

const getSettings = (): AppSettings => appSettings;

const getGameDisplayName = (gameObj: { title: string; zh_CN?: string | null }) => {
    return appSettings.language === 'en_US'
        ? gameObj.title
        : (appSettings.language === 'zh_CN' ? gameObj.zh_CN || gameObj.title : gameObj.title);
};

const writeSettingsFile = (settingsPath: string, settings: AppSettings): void => {
    const temporaryPath = `${settingsPath}.tmp`;
    const backupPath = `${settingsPath}.bak`;

    try {
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(temporaryPath, JSON.stringify(settings), 'utf8');
        if (fs.existsSync(settingsPath)) {
            fs.copyFileSync(settingsPath, backupPath);
        }
        fs.renameSync(temporaryPath, settingsPath);
    } catch (error) {
        if (fs.existsSync(temporaryPath)) {
            fs.unlinkSync(temporaryPath);
        }
        throw error;
    }
};

export {
    getGameDisplayName,
    getSettings,
    loadSettings,
    saveSettings,
};
