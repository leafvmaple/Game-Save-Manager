import { exec } from 'child_process';
import fsOriginal from 'original-fs';
import fse from 'fs-extra';
import i18next from 'i18next';
import moment from 'moment';
import path from 'path';
import util from 'util';

import {
  collectSourceManifest,
  copyDirectoryWithExclusions,
  getBackupExclusionPatterns,
  shouldExcludePath,
} from './backupMetadata';
import { handleBackupError } from './backupErrors';
import { ensureWritable } from './fileOps';
import { getGameDisplayName, getSettings } from './settingsService';
import { finalizeTemplate } from './utils';
import type { BackupConfig } from '../types/backup';
import type { Game, ResolvedPath } from '../types/game';

const execPromise = util.promisify(exec);

async function backupGame(gameObj: Game): Promise<string | null> {
  const gameBackupPath = path.join(getSettings().backupPath, gameObj.wiki_page_id.toString());
  const backupInstanceFolder = moment().format('YYYY-MM-DD_HH-mm');
  const backupInstancePath = path.join(gameBackupPath, backupInstanceFolder);

  try {
    const backupConfig: BackupConfig = createBackupConfig(gameObj);

    for (const [index, resolvedPathObj] of gameObj.resolved_paths.entries()) {
      const resolvedPath = path.normalize(resolvedPathObj.resolved);
      const pathFolderName = `path${index + 1}`;
      const targetPath = path.join(backupInstancePath, pathFolderName);
      fsOriginal.mkdirSync(targetPath, { recursive: true });

      if (resolvedPathObj.type === 'reg') {
        await backupRegistry(resolvedPath, targetPath, backupConfig, pathFolderName, resolvedPathObj, gameObj);
      } else {
        await backupFileOrDirectory(resolvedPath, targetPath, backupConfig, pathFolderName, resolvedPathObj, gameObj);
      }
    }

    await saveBackupConfig(backupInstancePath, backupConfig);
    await manageOldBackups(gameBackupPath);

  } catch (error) {
    if (error instanceof Error) {
      handleBackupError(error, `Error during backup for game ${getGameDisplayName(gameObj)}`, []);
      return `${i18next.t('alert.backup_game_error', { game_name: getGameDisplayName(gameObj) })}: ${error.message}`;
    }
  }

  return null;
}

function createBackupConfig(gameObj: Game): BackupConfig {
  return {
    schema_version: 2,
    created_at: new Date().toISOString(),
    title: gameObj.title,
    zh_CN: gameObj.zh_CN || null,
    zh_TW: gameObj.zh_TW || null,
    backup_total_size: 0,
    backup_paths: [],
  };
}

async function backupRegistry(
  resolvedPath: string,
  targetPath: string,
  backupConfig: BackupConfig,
  pathFolderName: string,
  resolvedPathObj: ResolvedPath,
  gameObj: Game
) {
  const registryFilePath = path.join(targetPath, 'registry_backup.reg');
  const regExportCommand = `reg export "${resolvedPath}" "${registryFilePath}" /y`;
  await execPromise(regExportCommand);

  backupConfig.backup_paths.push({
    folder_name: pathFolderName,
    template: resolvedPathObj.template,
    type: 'reg',
    install_folder: gameObj.install_folder || null,
    source_path: resolvedPath,
    backup_size: fsOriginal.existsSync(registryFilePath) ? fsOriginal.statSync(registryFilePath).size : 0,
    files: fsOriginal.existsSync(registryFilePath)
      ? [{
        relative_path: 'registry_backup.reg',
        type: 'file',
        size: fsOriginal.statSync(registryFilePath).size,
        mtime_ms: fsOriginal.statSync(registryFilePath).mtimeMs,
      }]
      : [],
    excluded: [],
  });

  backupConfig.backup_total_size = (backupConfig.backup_total_size || 0)
    + (fsOriginal.existsSync(registryFilePath) ? fsOriginal.statSync(registryFilePath).size : 0);
}

async function backupFileOrDirectory(
  resolvedPath: string,
  targetPath: string,
  backupConfig: BackupConfig,
  pathFolderName: string,
  resolvedPathObj: ResolvedPath,
  gameObj: Game
) {
  let dataType: 'folder' | 'file' | null = null;
  const exclusionPatterns = getBackupExclusionPatterns();
  const manifest = collectSourceManifest(resolvedPath, exclusionPatterns);
  ensureWritable(resolvedPath);
  const stats = fsOriginal.statSync(resolvedPath);

  if (stats.isDirectory()) {
    dataType = 'folder';
    copyDirectoryWithExclusions(resolvedPath, targetPath, exclusionPatterns);
  } else {
    dataType = 'file';
    const targetFilePath = path.join(targetPath, path.basename(resolvedPath));
    if (!shouldExcludePath(resolvedPath, exclusionPatterns)) {
      fsOriginal.copyFileSync(resolvedPath, targetFilePath);
    }
  }

  backupConfig.backup_paths.push({
    folder_name: pathFolderName,
    template: finalizeTemplate(resolvedPathObj.template, resolvedPathObj.resolved, resolvedPathObj.uid, gameObj.install_path),
    type: dataType,
    install_folder: gameObj.install_folder || null,
    source_path: resolvedPath,
    backup_size: manifest.size,
    files: manifest.files,
    excluded: manifest.excluded,
  });
  backupConfig.backup_total_size = (backupConfig.backup_total_size || 0) + manifest.size;
}

async function saveBackupConfig(backupInstancePath: string, backupConfig: BackupConfig) {
  const configFilePath = path.join(backupInstancePath, 'backup_info.json');
  await fse.writeJson(configFilePath, backupConfig, { spaces: 4 });
}

async function manageOldBackups(gameBackupPath: string) {
  const existingBackups = fsOriginal.readdirSync(gameBackupPath).sort((a, b) => a.localeCompare(b));
  const maxBackups = getSettings().maxBackups;

  if (existingBackups.length > maxBackups) {
    const backupsToDelete = existingBackups.slice(0, existingBackups.length - maxBackups);
    for (const backup of backupsToDelete) {
      const backupToDeletePath = path.join(gameBackupPath, backup);
      fsOriginal.rmSync(backupToDeletePath, { recursive: true, force: true });
    }
  }
}

export {
  backupGame,
};
