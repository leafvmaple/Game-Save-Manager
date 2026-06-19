import fsOriginal from 'original-fs';
import fse from 'fs-extra';
import i18next from 'i18next';
import moment from 'moment';
import path from 'path';

import { getAppStatus } from './appStatus';
import { calculateDirectorySize } from './fileOps';
import { getMainWindow } from './windowManager';
import { getSettings, saveSettings } from './settingsService';

const getNewestBackup = (wikiPageId: string): string => {
    const backupDir = path.join(getSettings().backupPath, wikiPageId.toString());
    if (!fsOriginal.existsSync(backupDir)) return i18next.t('main.no_backups');
    const backups = fsOriginal.readdirSync(backupDir).filter(file => fsOriginal.statSync(path.join(backupDir, file)).isDirectory());
    if (backups.length === 0) return i18next.t('main.no_backups');
    const latestBackup = backups.sort((a, b) => b.localeCompare(a))[0];
    return moment(latestBackup, 'YYYY-MM-DD_HH-mm').format('YYYY/MM/DD HH:mm');
};

const moveFilesWithProgress = async (sourceDir: string, destinationDir: string) => {
    let totalSize = 0, movedSize = 0, errors: string[] = [];
    const appStatus = getAppStatus();
    appStatus.migrating = true;
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
                        getMainWindow()?.webContents.send('update-progress', progressId, progressTitle, progressPercentage);
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
        getMainWindow()?.webContents.send('update-progress', progressId, progressTitle, 'start');
        await moveAndTrackProgress(sourceDir, destinationDir);
        getMainWindow()?.webContents.send('update-progress', progressId, progressTitle, 'end');
        if (errors.length > 0) {
            console.log(errors);
            getMainWindow()?.webContents.send('show-alert', 'modal', i18next.t('alert.error_during_backup_migration'), errors);
        } else {
            getMainWindow()?.webContents.send('show-alert', 'success', i18next.t('alert.backup_migration_success'));
        }
    }
    saveSettings('backupPath', destinationDir);
    getMainWindow()?.webContents.send('update-restore-table');
    appStatus.migrating = false;
};

export {
    getNewestBackup,
    moveFilesWithProgress,
};
