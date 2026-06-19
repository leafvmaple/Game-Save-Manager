import { BrowserWindow, app } from 'electron';
import fs from 'fs';
import i18next from 'i18next';
import path from 'path';

import { getMainWindow, rebuildApplicationMenu } from './windowManager';

let appSettings: any;
let writeQueue = Promise.resolve();

const loadSettings = () => {
    const userDataPath = app.getPath('userData');
    const appDataPath = app.getPath('appData');
    const settingsPath = path.join(userDataPath, 'GSM Settings', 'settings.json');

    const localeMapping: { [key: string]: string } = {
        'en-US': 'en_US',
        'zh-Hans-CN': 'zh_CN',
        'zh-Hans-SG': 'zh_CN',
        'zh-Hant-HK': 'zh_TW',
        'zh-Hant-MO': 'zh_TW',
        'zh-Hant-TW': 'zh_TW',
    };

    const systemLocale = app.getLocale();
    const detectedLanguage = localeMapping[systemLocale] || 'en_US';

    const defaultSettings = {
        theme: 'dark',
        language: detectedLanguage,
        backupPath: path.join(appDataPath, 'GSM Backups'),
        maxBackups: 5,
        autoAppUpdate: true,
        autoDbUpdate: false,
        autoBackupEnabled: false,
        autoBackupInterval: 30,
        excludedBackupPatterns: [] as string[],
        backupSizeWarningEnabled: true,
        backupSizeWarningThresholdMb: 1024,
        backupSizeWarningMultiplier: 3,
        gameInstalls: 'uninitialized',
        pinnedGames: [] as string[]
    };

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

    try {
        const data = fs.readFileSync(settingsPath, 'utf8');
        appSettings = { ...defaultSettings, ...JSON.parse(data) };
    } catch (err) {
        console.error('Error loading settings, using defaults:', err);
        fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings), 'utf8');
        appSettings = defaultSettings;
    }
};

const saveSettings = (key: string, value: any) => {
    const userDataPath = app.getPath('userData');
    const settingsPath = path.join(userDataPath, 'GSM Settings', 'settings.json');
    appSettings[key] = value;

    writeQueue = writeQueue.then(() => {
        return new Promise<void>((resolve, reject) => {
            fs.writeFile(settingsPath, JSON.stringify(appSettings), (writeErr) => {
                if (writeErr) {
                    console.error('Error saving settings:', writeErr);
                    reject(writeErr);
                    return;
                }

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
                    i18next.changeLanguage(value).then(() => {
                        BrowserWindow.getAllWindows().forEach(window => window.webContents.send('apply-language'));
                        rebuildApplicationMenu();
                        resolve();
                    }).catch(reject);
                } else {
                    resolve();
                }
            });
        });
    }).catch(err => console.error('Error in write queue:', err));
};

const getSettings = () => appSettings;

const getGameDisplayName = (gameObj: any) => {
    return appSettings.language === 'en_US'
        ? gameObj.title
        : (appSettings.language === 'zh_CN' ? gameObj.zh_CN || gameObj.title : gameObj.title);
};

export {
    getGameDisplayName,
    getSettings,
    loadSettings,
    saveSettings,
};
