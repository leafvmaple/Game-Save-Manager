import { BrowserWindow, Menu, Notification, app, BrowserWindowConstructorOptions } from 'electron';
import fs from 'fs';
import fsOriginal from 'original-fs';
import os from 'os';
import path from 'path';
import fse from 'fs-extra';
import i18next from 'i18next';
import moment from 'moment';

import { getRenderPath, getAssetPath } from './paths';

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let aboutWindow: BrowserWindow | null = null;
let appSettings: any;
let writeQueue = Promise.resolve();

const APP_VERSION = "2.0.4";
const UPDATE_URL = "https://api.github.com/repos/dyang886/Game-Save-Manager/releases/latest";

let appStatus = {
    isBackingUp: false,
    isRestoring: false,
    isMigrating: false,
    isUpdatingDb: false
};

// Helper Functions
const createWindow = (options: BrowserWindowConstructorOptions, filePath: string, onClose: () => void): BrowserWindow => {
    const window = new BrowserWindow(options);
    window.setMenuBarVisibility(false);
    window.loadFile(filePath);
    window.on("closed", onClose);
    return window;
};

const showNotification = (type: 'info' | 'warning' | 'critical', title: string, body: string) => {
    const iconMap: { [key: string]: string } = {
        'info': getAssetPath("information.png"),
        'warning': getAssetPath("warning.png"),
        'critical': getAssetPath("critical.png")
    };
    new Notification({ title, body, icon: iconMap[type] }).show();
};

// Menu Initialization
const initializeMenu = () => [
    {
        label: i18next.t("main.options"),
        submenu: [
            {
                label: i18next.t("settings.title"),
                click() {
                    if (!settingsWindow || settingsWindow.isDestroyed()) {
                        settingsWindow = createWindow({
                            width: 650,
                            height: 700,
                            minWidth: 650,
                            minHeight: 700,
                            icon: getAssetPath("setting.ico"),
                            parent: mainWindow!,
                            modal: true,
                            webPreferences: { preload: path.join(__dirname, "preload.js") },
                        }, getRenderPath("html", "settings.html"), () => settingsWindow = null);
                    } else {
                        settingsWindow.focus();
                    }
                },
            },
            {
                label: i18next.t("about.title"),
                click() {
                    if (!aboutWindow || aboutWindow.isDestroyed()) {
                        aboutWindow = createWindow({
                            width: 480,
                            height: 290,
                            resizable: false,
                            icon: getAssetPath("logo.ico"),
                            parent: mainWindow!,
                            modal: true,
                            webPreferences: { preload: path.join(__dirname, "preload.js") },
                        }, getRenderPath("html", "about.html"), () => aboutWindow = null);
                    } else {
                        aboutWindow.focus();
                    }
                },
            },
            {
                label: 'DevTools',
                click: (_, browserWindow) => {
                    if (browserWindow) {
                        browserWindow.webContents.toggleDevTools();
                    }
                }
            },
        ],
    },
];

// Main Window
const createMainWindow = async () => {
    mainWindow = createWindow({
        width: 1100,
        height: 750,
        minWidth: 1100,
        minHeight: 750,
        icon: getAssetPath("logo.ico"),
        webPreferences: { preload: path.join(__dirname, "preload.js") },
    }, getRenderPath("html", "index.html"), () => {
        BrowserWindow.getAllWindows().forEach(window => {
            if (window !== mainWindow) window.close();
        });
        if (process.platform !== "darwin") app.quit();
    });

    const menu = Menu.buildFromTemplate(initializeMenu());
    Menu.setApplicationMenu(menu);
};

// Update Functions
const getLatestVersion = async (): Promise<string | null> => {
    try {
        const response = await fetch(UPDATE_URL);
        const data = await response.json();
        return data.tag_name ? data.tag_name.replace(/^v/, "") : null;
    } catch (error) {
        console.error("Error checking for update:", error.stack);
        return null;
    }
};

const checkAppUpdate = async () => {
    try {
        const response = await fetch(UPDATE_URL);
        const data = await response.json();
        const latestVersion = data.tag_name ? data.tag_name.replace(/^v/, "") : APP_VERSION;

        if (latestVersion > APP_VERSION) {
            showNotification(
                "info",
                i18next.t('alert.update_available'),
                `${i18next.t('alert.new_version_found', { old_version: APP_VERSION, new_version: latestVersion })}\n${i18next.t('alert.new_version_found_text')}`
            );
        }
    } catch (error) {
        console.error("Error checking for update:", error.stack);
        showNotification(
            "warning",
            i18next.t('alert.update_check_failed'),
            i18next.t('alert.update_check_failed_text')
        );
    }
};

// Directory and File Operations
const calculateDirectorySize = (directoryPath: string, ignoreConfig = true): number => {
    let totalSize = 0;
    try {
        if (fsOriginal.statSync(directoryPath).isDirectory()) {
            const files = fsOriginal.readdirSync(directoryPath);
            files.forEach(file => {
                if (ignoreConfig && file === 'backup_info.json') return;
                const filePath = path.join(directoryPath, file);
                totalSize += fsOriginal.statSync(filePath).isDirectory() ? calculateDirectorySize(filePath) : fsOriginal.statSync(filePath).size;
            });
        } else {
            totalSize += fsOriginal.statSync(directoryPath).size;
        }
    } catch (error) {
        console.error(`Error calculating directory size for ${directoryPath}:`, error);
    }
    return totalSize;
};

const ensureWritable = (pathToCheck: string) => {
    if (!fsOriginal.existsSync(pathToCheck)) return;
    const stats = fsOriginal.statSync(pathToCheck);
    if (stats.isDirectory()) {
        fsOriginal.readdirSync(pathToCheck).forEach(item => ensureWritable(path.join(pathToCheck, item)));
    } else if (!(stats.mode & 0o200)) {
        fsOriginal.chmod(pathToCheck, 0o666, (err) => {
            if (err) {
                console.error(`Error changing permissions for file: ${pathToCheck}`, err);
            } else {
                console.log(`Changed permissions for file: ${pathToCheck}`);
            }
        });
    }
};

const copyFolder = (source: string, target: string) => {
    fsOriginal.mkdirSync(target, { recursive: true });
    fsOriginal.readdirSync(source).forEach(item => {
        const sourcePath = path.join(source, item);
        const destinationPath = path.join(target, item);
        const stats = fsOriginal.statSync(sourcePath);
        stats.isDirectory() ? copyFolder(sourcePath, destinationPath) : fsOriginal.copyFileSync(sourcePath, destinationPath);
    });
};

// Backup and Migration
const getNewestBackup = (wikiPageId: string): string => {
    const backupDir = path.join(appSettings.backupPath, wikiPageId.toString());
    if (!fsOriginal.existsSync(backupDir)) return i18next.t('main.no_backups');
    const backups = fsOriginal.readdirSync(backupDir).filter(file => fsOriginal.statSync(path.join(backupDir, file)).isDirectory());
    if (backups.length === 0) return i18next.t('main.no_backups');
    const latestBackup = backups.sort((a, b) => b.localeCompare(a))[0];
    return moment(latestBackup, 'YYYY-MM-DD_HH-mm').format('YYYY/MM/DD HH:mm');
};

const moveFilesWithProgress = async (sourceDir: string, destinationDir: string) => {
    let totalSize = 0, movedSize = 0, errors: string[] = [];
    appStatus.isMigrating = true;
    const progressId = 'migrate-backups';
    const progressTitle = i18next.t('alert.migrate_backups');

    const moveAndTrackProgress = async (srcDir: string, destDir: string) => {
        try {
            const items = fsOriginal.readdirSync(srcDir, { withFileTypes: true });
            for (const item of items) {
                const srcPath = path.join(srcDir, item.name);
                const destPath = path.join(destDir, item.name);
                if (item.isDirectory()) {
                    fse.ensureDirSync(destPath);
                    await moveAndTrackProgress(srcPath, destPath);
                } else {
                    const fileStats = fsOriginal.statSync(srcPath);
                    const readStream = fsOriginal.createReadStream(srcPath);
                    const writeStream = fsOriginal.createWriteStream(destPath);
                    readStream.on('data', chunk => {
                        movedSize += chunk.length;
                        const progressPercentage = Math.round((movedSize / totalSize) * 100);
                        if (mainWindow) {
                            mainWindow.webContents.send('update-progress', progressId, progressTitle, progressPercentage);
                        }
                    });
                    await new Promise<void>((resolve, reject) => {
                        readStream.pipe(writeStream);
                        readStream.on('error', reject);
                        writeStream.on('error', reject);
                        writeStream.on('finish', () => {
                            fsOriginal.promises.utimes(destPath, fileStats.atime, fileStats.mtime)
                                .then(() => fsOriginal.promises.rm(srcPath))
                                .then(resolve)
                                .catch(reject);
                        });
                    });
                }
            }
            await fsOriginal.promises.rm(srcDir, { recursive: true });
        } catch (err) {
            errors.push(`Error moving file or directory: ${err.message}`);
        }
    };

    if (fsOriginal.existsSync(sourceDir)) {
        totalSize = calculateDirectorySize(sourceDir, false);
        if (mainWindow) {
            mainWindow.webContents.send('update-progress', progressId, progressTitle, 'start');
        }
        await moveAndTrackProgress(sourceDir, destinationDir);
        if (mainWindow) {
            mainWindow.webContents.send('update-progress', progressId, progressTitle, 'end');
        }
        if (errors.length > 0) {
            console.log(errors);
            if (mainWindow) {
                mainWindow.webContents.send('show-alert', 'modal', i18next.t('alert.error_during_backup_migration'), errors);
            }
        } else {
            if (mainWindow) {
                mainWindow.webContents.send('show-alert', 'success', i18next.t('alert.backup_migration_success'));
            }
        }
    }
    saveSettings('backupPath', destinationDir);
    if (mainWindow) {
        mainWindow.webContents.send('update-restore-table');
    }
    appStatus.isMigrating = false;
};

// Settings
const loadSettings = () => {
    const userDataPath = app.getPath("userData");
    const appDataPath = app.getPath("appData");
    const settingsPath = path.join(userDataPath, "GSM Settings", "settings.json");

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
        backupPath: path.join(appDataPath, "GSM Backups"),
        maxBackups: 5,
        autoAppUpdate: true,
        autoDbUpdate: false,
        gameInstalls: 'uninitialized',
        pinnedGames: []
    };

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

    try {
        const data = fs.readFileSync(settingsPath, 'utf8');
        appSettings = { ...defaultSettings, ...JSON.parse(data) };
    } catch (err) {
        console.error("Error loading settings, using defaults:", err);
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
                } else {
                    console.log(`Settings updated successfully: ${key}: ${value}`);
                    if (key === 'theme') {
                        BrowserWindow.getAllWindows().forEach(window => window.webContents.send('apply-theme', value));
                    }
                    if (key === 'gameInstalls') {
                        if (mainWindow) {
                            mainWindow.webContents.send('update-backup-table');
                        }
                    }
                    if (key === 'language') {
                        i18next.changeLanguage(value).then(() => {
                            BrowserWindow.getAllWindows().forEach(window => window.webContents.send('apply-language'));
                            const menu = Menu.buildFromTemplate(initializeMenu());
                            Menu.setApplicationMenu(menu);
                            resolve();
                        }).catch(reject);
                    } else {
                        resolve();
                    }
                }
            });
        });
    }).catch(err => console.error('Error in write queue:', err));
};

const getMainWindow = () => mainWindow;
const getSettingsWindow = () => settingsWindow;
const getAppStatus = () => appStatus;
const updateAppStatus = (statusKey: string, statusValue: boolean) => appStatus[statusKey] = statusValue;
const getCurrentVersion = () => APP_VERSION;
const getGameDisplayName = (gameObj: any) => appSettings.language === "en_US" ? gameObj.title : (appSettings.language === "zh_CN" ? gameObj.zh_CN || gameObj.title : gameObj.title);
const getSettings = () => appSettings;

const placeholderMapping = {
    '{{p|username}}': os.userInfo().username,
    '{{p|userprofile}}': process.env.USERPROFILE || os.homedir(),
    '{{p|userprofile/documents}}': path.join(process.env.USERPROFILE || os.homedir(), 'Documents'),
    '{{p|userprofile/appdata/locallow}}': path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'LocalLow'),
    '{{p|appdata}}': process.env.APPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming'),
    '{{p|localappdata}}': process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local'),
    '{{p|programfiles}}': process.env.PROGRAMFILES || 'C:\\Program Files',
    '{{p|programdata}}': process.env.PROGRAMDATA || 'C:\\ProgramData',
    '{{p|public}}': path.join(process.env.PUBLIC || 'C:\\Users\\Public'),
    '{{p|windir}}': process.env.WINDIR || 'C:\\Windows',
    '{{p|hkcu}}': 'HKEY_CURRENT_USER',
    '{{p|hklm}}': 'HKEY_LOCAL_MACHINE',
    '{{p|wow64}}': 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node',
    '{{p|osxhome}}': os.homedir(),
    '{{p|linuxhome}}': os.homedir(),
    '{{p|xdgdatahome}}': process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    '{{p|xdgconfighome}}': process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
};

const placeholderIdentifier = {
    '{{p|username}}': '{{p1}}',
    '{{p|userprofile}}': '{{p2}}',
    '{{p|userprofile/documents}}': '{{p3}}',
    '{{p|userprofile/appdata/locallow}}': '{{p4}}',
    '{{p|appdata}}': '{{p5}}',
    '{{p|localappdata}}': '{{p6}}',
    '{{p|programfiles}}': '{{p7}}',
    '{{p|programdata}}': '{{p8}}',
    '{{p|public}}': '{{p9}}',
    '{{p|windir}}': '{{p10}}',
    '{{p|game}}': '{{p11}}',
    '{{p|uid}}': '{{p12}}',
    '{{p|steam}}': '{{p13}}',
    '{{p|uplay}}': '{{p14}}',
    '{{p|ubisoftconnect}}': '{{p14}}',
    '{{p|hkcu}}': '{{p15}}',
    '{{p|hklm}}': '{{p16}}',
    '{{p|wow64}}': '{{p17}}',
    '{{p|osxhome}}': '{{p18}}',
    '{{p|linuxhome}}': '{{p19}}',
    '{{p|xdgdatahome}}': '{{p20}}',
    '{{p|xdgconfighome}}': '{{p21}}',
};

const osKeyMap = {
    win32: 'win',
    darwin: 'mac',
    linux: 'linux'
};

// Exported Functions
export {
    createMainWindow,
    getMainWindow,
    getSettingsWindow,
    getAppStatus,
    updateAppStatus,
    getCurrentVersion,
    getLatestVersion,
    checkAppUpdate,
    getGameDisplayName,
    calculateDirectorySize,
    ensureWritable,
    getNewestBackup,
    copyFolder,
    loadSettings,
    saveSettings,
    getSettings,
    moveFilesWithProgress,
    placeholderMapping,
    placeholderIdentifier,
    osKeyMap
};