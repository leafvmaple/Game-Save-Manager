import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

const sendChannels = new Set([
  'load-theme',
  'save-settings',
  'migrate-backups',
  'update-status',
]);

const receiveChannels = new Set([
  'apply-theme',
  'apply-language',
  'show-alert',
  'update-progress',
  'update-backup-table',
  'update-restore-table',
]);

const invokeChannels = new Set([
  'translate',
  'get-settings',
  'get-detected-game-paths',
  'open-url',
  'open-backup-folder',
  'open-backup-dialog',
  'open-dialog',
  'select-path',
  'get-newest-backup-time',
  'sort-games',
  'save-custom-entries',
  'load-custom-entries',
  'get-platform',
  'get-uuid',
  'get-icon-map',
  'fetch-backup-table-data',
  'backup-game',
  'fetch-restore-table-data',
  'restore-game',
  'get-status',
  'get-current-version',
  'get-latest-version',
  'update-database',
]);

const assertAllowedChannel = (allowedChannels: Set<string>, channel: string) => {
  if (!allowedChannels.has(channel)) {
    throw new Error(`Blocked IPC channel: ${channel}`);
  }
};

contextBridge.exposeInMainWorld('api', {
  send: (channel: string, ...args: any[]) => {
    assertAllowedChannel(sendChannels, channel);
    ipcRenderer.send(channel, ...args);
  },
  receive: (channel: string, func: (...args: any[]) => void) => {
    assertAllowedChannel(receiveChannels, channel);
    ipcRenderer.on(channel, (event: IpcRendererEvent, ...args: any[]) => func(...args));
  },
  invoke: (channel: string, ...args: any[]) => {
    assertAllowedChannel(invokeChannels, channel);
    return ipcRenderer.invoke(channel, ...args);
  }
});

contextBridge.exposeInMainWorld('i18n', {
  changeLanguage: (lng: string) => ipcRenderer.send('save-settings', 'language', lng),
  translate: (key: string, options?: any) => ipcRenderer.invoke('translate', key, options)
});
