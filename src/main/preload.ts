import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('api', {
  send: (channel: string, ...args: any[]) => ipcRenderer.send(channel, ...args),
  receive: (channel: string, func: (...args: any[]) => void) => {
    ipcRenderer.on(channel, (event: IpcRendererEvent, ...args: any[]) => func(...args));
  },
  invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args)
});

contextBridge.exposeInMainWorld('i18n', {
  changeLanguage: (lng: string) => ipcRenderer.invoke('change-language', lng),
  translate: (key: string, options?: any) => ipcRenderer.invoke('translate', key, options)
});