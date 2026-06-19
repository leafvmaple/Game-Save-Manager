import { BrowserWindow, BrowserWindowConstructorOptions, Menu, MenuItemConstructorOptions, app } from 'electron';
import i18next from 'i18next';
import path from 'path';
import { pathToFileURL } from 'url';

import { getAssetPath, getRenderPath } from './paths';
import { openAllowedExternalUrl } from './externalLinks';

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let aboutWindow: BrowserWindow | null = null;

const createWindow = (options: BrowserWindowConstructorOptions, filePath: string, onClose: () => void): BrowserWindow => {
    const initialFileUrl = pathToFileURL(filePath).toString();
    const window = new BrowserWindow({
        ...options,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            devTools: !app.isPackaged,
            ...options.webPreferences,
        },
    });
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(({ url }) => {
        openAllowedExternalUrl(url);
        return { action: 'deny' };
    });
    window.webContents.on('will-attach-webview', (event) => {
        event.preventDefault();
    });
    window.webContents.on('will-navigate', (event, navigationUrl) => {
        if (navigationUrl !== initialFileUrl) {
            event.preventDefault();
        }
    });
    window.loadFile(filePath);
    window.on('closed', onClose);
    return window;
};

const initializeMenu = (): MenuItemConstructorOptions[] => [
    {
        label: i18next.t('main.options'),
        submenu: [
            {
                label: i18next.t('settings.title'),
                click() {
                    if (!settingsWindow || settingsWindow.isDestroyed()) {
                        settingsWindow = createWindow({
                            width: 650,
                            height: 900,
                            minWidth: 650,
                            minHeight: 760,
                            icon: getAssetPath('setting.ico'),
                            parent: mainWindow!,
                            modal: true,
                            webPreferences: { preload: path.join(__dirname, 'preload.js') },
                        }, getRenderPath('html', 'settings.html'), () => settingsWindow = null);
                    } else {
                        settingsWindow.focus();
                    }
                },
            },
            {
                label: i18next.t('about.title'),
                click() {
                    if (!aboutWindow || aboutWindow.isDestroyed()) {
                        aboutWindow = createWindow({
                            width: 480,
                            height: 290,
                            resizable: false,
                            icon: getAssetPath('logo.ico'),
                            parent: mainWindow!,
                            modal: true,
                            webPreferences: { preload: path.join(__dirname, 'preload.js') },
                        }, getRenderPath('html', 'about.html'), () => aboutWindow = null);
                    } else {
                        aboutWindow.focus();
                    }
                },
            },
            {
                label: 'DevTools',
                visible: !app.isPackaged,
                click: (_menuItem, browserWindow) => {
                    const targetWindow = browserWindow as BrowserWindow | undefined;
                    if (targetWindow?.webContents) {
                        targetWindow.webContents.toggleDevTools();
                    }
                }
            },
        ],
    },
];

const rebuildApplicationMenu = () => {
    const menu = Menu.buildFromTemplate(initializeMenu());
    Menu.setApplicationMenu(menu);
};

const createMainWindow = async () => {
    mainWindow = createWindow({
        width: 1100,
        height: 750,
        minWidth: 1100,
        minHeight: 750,
        icon: getAssetPath('logo.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js')
        },
    }, getRenderPath('html', 'index.html'), () => {
        BrowserWindow.getAllWindows().forEach(window => {
            if (window !== mainWindow) window.close();
        });
        if (process.platform !== 'darwin') app.quit();
    });

    rebuildApplicationMenu();
};

const getMainWindow = () => mainWindow;
const getSettingsWindow = () => settingsWindow;

export {
    createMainWindow,
    getMainWindow,
    getSettingsWindow,
    rebuildApplicationMenu,
};
