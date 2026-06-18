import { app, dialog } from 'electron';
import { exec } from 'child_process';
import { globSync } from 'glob';
import { Database } from 'sqlite3'
import fs from 'fs';
import fsOriginal from 'original-fs';
import https from 'https';
import os from 'os';
import path from 'path';
import util from 'util';
import fse from 'fs-extra';
import i18next from 'i18next';
import moment from 'moment';
import sqlite3 from 'sqlite3';
import WinReg from 'winreg';

import {
  getMainWindow,
  getGameDisplayName,
  ensureWritable,
  getNewestBackup,
  osKeyMap,
  getSettings,
} from './global';

import {
  applyBackupAnalysis,
  calculateBackupSourceSize,
  collectSourceManifest,
  copyDirectoryWithExclusions,
  getBackupExclusionPatterns,
  shouldExcludePath,
} from './backupMetadata';

import {
  Game,
  ResolvedPath,
  BackupConfig,
  getWinRegHive,
  parseRegistryPath,
  resolveTemplatedBackupPath,
  finalizeTemplate,
} from './utils';
import { getBundledDatabasePath } from './paths';

const execPromise = util.promisify(exec);

function handleError(error: unknown, contextMessage: string, errors: string[]): void {
  if (error instanceof Error) {
    console.error(`${contextMessage}: ${error.stack}`);
    errors.push(`${i18next.t('alert.backup_process_error_display')}: ${error.message}`);
  } else {
    console.error(`${contextMessage}: Unknown error`);
    errors.push(i18next.t('alert.backup_process_error_display'));
  }
}

async function getGameDataFromDB(): Promise<{ games: Game[]; errors: string[] }> {
  const games: Game[] = [];
  const errors: string[] = [];
  const dbPath = path.join(app.getPath('userData'), 'GSM Database', 'database.db');

  let db: Database | null = null;
  let stmtInstallFolder: sqlite3.Statement | null = null;

  try {
    await ensureDatabaseExists(dbPath);
    db = new Database(dbPath, sqlite3.OPEN_READONLY);
    stmtInstallFolder = db.prepare('SELECT * FROM games WHERE install_folder = ?');

    const gameInstallPaths = getSettings().gameInstalls;
    const customDBs = await loadCustomDatabases();

    await processGameInstallPaths(gameInstallPaths, stmtInstallFolder, customDBs, games, errors);

    await processCustomEntriesAfterDatabaseGames(games, errors);
  } catch (error) {
    handleError(error, 'Error updating database', errors);
  } finally {
    if (stmtInstallFolder) {
      await new Promise<void>((resolve) => {
        try {
          stmtInstallFolder!.finalize((err) => {
            if (err) {
              console.error('[getGameDataFromDB] Error finalizing statement:', err);
            }
            resolve();
          });
        } catch (e) {
          console.error('[getGameDataFromDB] Exception during statement finalize:', e);
          resolve();
        }
      });
    }

    if (db) {
      await new Promise<void>((resolve) => {
        try {
          db!.close((err) => {
            if (err) {
              console.error('[getGameDataFromDB] Error closing database:', err);
            }
            resolve();
          });
        } catch (e) {
          console.error('[getGameDataFromDB] Exception during db.close():', e);
          resolve();
        }
      });
    }
  }

  return { games, errors };
}

async function ensureDatabaseExists(dbPath: string): Promise<void> {
  if (!fs.existsSync(dbPath)) {
    const installedDbPath = getBundledDatabasePath();
    if (!fs.existsSync(installedDbPath)) {
      dialog.showErrorBox(
        i18next.t('alert.missing_database_file'),
        i18next.t('alert.missing_database_file_message')
      );
      throw Error('Database file is missing');
    } else {
      await fse.copy(installedDbPath, dbPath);
    }
  }
}

async function loadCustomDatabases(): Promise<Game[]> {
  const customDBPath = path.join(getSettings().backupPath, 'custom_database.json');
  const customDBs: Game[] = [];
  if (fs.existsSync(customDBPath)) {
    const customs = JSON.parse(fs.readFileSync(customDBPath, 'utf-8'));
    for (const game of customs) {
      customDBs.push(game);
    }
  }
  return customDBs;
}

async function processGameInstallPaths(
  gameInstallPaths: string[],
  stmtInstallFolder: sqlite3.Statement,
  customDBs: Game[],
  games: Game[],
  errors: string[]
): Promise<void> {
  if (Array.isArray(gameInstallPaths) && gameInstallPaths.length > 0) {
    for (const installPath of gameInstallPaths) {
      const directories = fsOriginal
        .readdirSync(installPath, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);

      for (const dir of directories) {
        await processDirectory(dir, installPath, stmtInstallFolder, customDBs, games, errors);
      }
    }
  }
}

async function processDirectory(
  dir: string,
  installPath: string,
  stmtInstallFolder: sqlite3.Statement,
  customDBs: Game[],
  games: Game[],
  errors: string[]
): Promise<void> {
  const rows = await queryDatabase(stmtInstallFolder, dir);
  if (rows && rows.length > 0) {
    await processDatabaseRows(rows, dir, installPath, games, errors);
  }

  const customs = customDBs.filter((game) => game.install_folder === dir);
  await processCustomGames(customs, dir, installPath, games, errors);
}

async function queryDatabase(stmtInstallFolder: sqlite3.Statement, dir: string): Promise<any[]> {
  return new Promise<any[]>((resolve, reject) => {
    stmtInstallFolder.all(dir, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

async function processDatabaseRows(rows: any[], dir: string, installPath: string, games: Game[], errors: string[]): Promise<void> {
  for (const row of rows) {
    try {
      row.wiki_page_id = row.wiki_page_id.toString();
      row.platform = JSON.parse(row.platform);
      row.save_location = JSON.parse(row.save_location);
      row.install_path = path.join(installPath, dir);
      row.latest_backup = getNewestBackup(row.wiki_page_id);

      const processed_game = await processGame(row);
      if (processed_game.resolved_paths.length !== 0) {
        games.push(processed_game);
      }
    } catch (err) {
      handleError(err, `Error processing database game ${getGameDisplayName(row)}`, errors);
    }
  }
}

async function processCustomGames(customs: Game[], dir: string, installPath: string, games: Game[], errors: string[]): Promise<void> {
  for (const custom of customs) {
    try {
      custom.wiki_page_id = custom.wiki_page_id.toString();
      custom.platform = ['Custom'];
      custom.install_path = path.join(installPath, dir);
      custom.latest_backup = getNewestBackup(custom.wiki_page_id);

      const processed_game = await processGame(custom);
      if (processed_game.resolved_paths.length !== 0) {
        games.push(processed_game);
      }
    } catch (err) {
      handleError(err, `Error processing custom game ${custom.title}`, errors);
    }
  }
}

async function processCustomEntriesAfterDatabaseGames(games: Game[], errors: string[]): Promise<void> {
  const customJsonPath = path.join(getSettings().backupPath, 'custom_entries.json');
  if (fs.existsSync(customJsonPath)) {
    const { customGames, customGameErrors } = await processCustomEntries(customJsonPath);
    games.push(...customGames);
    errors.push(...customGameErrors);
  }
}

async function processCustomEntries(customJsonPath: string): Promise<{ customGames: Game[]; customGameErrors: string[] }> {
  const customGames: Game[] = [];
  const customGameErrors: string[] = [];

  const customEntries: Game[] = JSON.parse(fs.readFileSync(customJsonPath, 'utf-8'));
  for (let customEntry of customEntries) {
    try {
      customEntry.platform = ['Custom'];
      customEntry.latest_backup = getNewestBackup(customEntry.wiki_page_id);
      for (const plat in customEntry.save_location) {
        const entries = customEntry.save_location[plat] as unknown[];
        customEntry.save_location[plat] = entries.map((entry) => {
          if (typeof entry === 'string') {
            return entry;
          }
          return (entry as { template: string }).template;
        });
      }

      const processed_game = await processGame(customEntry);
      if (processed_game.resolved_paths.length !== 0) {
        customGames.push(processed_game);
      }
    } catch (err) {
      handleError(err, `Error processing custom game ${customEntry.title}`, customGameErrors);
    }
  }

  return { customGames, customGameErrors };
}

async function getAllGameDataFromDB(): Promise<Game[]> {
  return new Promise((resolve, reject) => {
    const dbPath = path.join(app.getPath('userData'), 'GSM Database', 'database.db');
    const db = new Database(dbPath, sqlite3.OPEN_READONLY);

    const games: Game[] = [];

    db.serialize(async () => {
      const stmtGetAllGames = db.prepare('SELECT * FROM games');

      try {
        const rows = await new Promise<any[]>((resolve, reject) => {
          stmtGetAllGames.all((err, rows) => {
            if (err) {
              console.error('Error querying all games:', err);
              reject(err);
            } else {
              resolve(rows);
            }
          });
        });

        if (rows && rows.length > 0) {
          for (const row of rows) {
            row.platform = JSON.parse(row.platform);
            row.save_location = JSON.parse(row.save_location);
            row.latest_backup = getNewestBackup(row.wiki_page_id);

            const processed_game = await processGame(row);
            if (processed_game.resolved_paths.length !== 0) {
              games.push(processed_game);
            }
          }
        }

        stmtGetAllGames.finalize(() => {
          db.close();
          resolve(games);
        });
      } catch (error) {
        console.error('Error during processing:', error);
        db.close();
        reject(error);
      }
    });
  });
}

async function processGame(db_game_row: Game): Promise<Game> {
  const resolved_paths: ResolvedPath[] = [];
  let totalBackupSize = 0;

  const currentOS = os.platform();
  const osKey = osKeyMap[currentOS];

  if (osKey && db_game_row.save_location[osKey]) {
    totalBackupSize += await processFilePaths(db_game_row, osKey, resolved_paths);
  }

  if (osKey === 'win' && db_game_row.save_location['reg'] && db_game_row.save_location['reg'].length > 0) {
    await processRegistryPaths(db_game_row, resolved_paths);
  }

  db_game_row.resolved_paths = resolved_paths;
  db_game_row.backup_size = totalBackupSize;

  return applyBackupAnalysis(db_game_row);
}

async function processFilePaths(db_game_row: Game, osKey: string, resolved_paths: ResolvedPath[]): Promise<number> {
  let totalBackupSize = 0;

  for (const templatedPath of db_game_row.save_location[osKey]) {
    const resolvedPath = await resolveTemplatedBackupPath(templatedPath, db_game_row.install_path);

    if (resolvedPath.path.includes('*')) {
      totalBackupSize += await processWildcardPaths(resolvedPath, templatedPath, resolved_paths);
    } else {
      totalBackupSize += await processSinglePath(resolvedPath, templatedPath, resolved_paths);
    }
  }

  return totalBackupSize;
}

async function processWildcardPaths(resolvedPath: { path: string; uid?: string }, templatedPath: string, resolved_paths: ResolvedPath[]): Promise<number> {
  let totalBackupSize = 0;
  const exclusionPatterns = getBackupExclusionPatterns();
  const files = globSync(resolvedPath.path.replace(/\\/g, '/'));

  for (const filePath of files) {
    if (fsOriginal.existsSync(filePath) && !shouldExcludePath(filePath, exclusionPatterns)) {
      totalBackupSize += calculateBackupSourceSize(filePath, exclusionPatterns);
      resolved_paths.push({
        template: templatedPath,
        resolved: path.normalize(filePath),
        uid: resolvedPath.uid,
      });
    }
  }

  return totalBackupSize;
}

async function processSinglePath(resolvedPath: { path: string; uid?: string }, templatedPath: string, resolved_paths: ResolvedPath[]): Promise<number> {
  let totalBackupSize = 0;
  const exclusionPatterns = getBackupExclusionPatterns();

  if (fsOriginal.existsSync(resolvedPath.path) && !shouldExcludePath(resolvedPath.path, exclusionPatterns)) {
    totalBackupSize += calculateBackupSourceSize(resolvedPath.path, exclusionPatterns);
    resolved_paths.push({
      template: templatedPath,
      resolved: path.normalize(resolvedPath.path),
      uid: resolvedPath.uid,
    });
  }

  return totalBackupSize;
}

async function processRegistryPaths(db_game_row: Game, resolved_paths: ResolvedPath[]): Promise<void> {
  for (const templatedPath of db_game_row.save_location['reg']) {
    const resolvedPath = await resolveTemplatedBackupPath(templatedPath, null);
    const normalizedRegPath = path.normalize(resolvedPath.path);
    const { hive, key } = parseRegistryPath(normalizedRegPath);
    const winRegHive = getWinRegHive(hive);

    if (!winRegHive) {
      continue;
    }

    const registryKey = new WinReg({
      hive: winRegHive,
      key: key,
    });

    await new Promise<void>((resolve, reject) => {
      registryKey.keyExists((err, exists) => {
        if (err) {
          getMainWindow()!.webContents.send(
            'show-alert',
            'error',
            `${i18next.t('alert.registry_existence_check_failed')}: ${db_game_row.title}`
          );
          console.error(`Error checking registry existence for ${db_game_row.title}: ${err}`);
          return reject(err);
        }
        if (exists) {
          resolved_paths.push({
            template: templatedPath,
            resolved: normalizedRegPath,
            uid: resolvedPath.uid,
            type: 'reg',
          });
        }
        resolve();
      });
    });
  }
}

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
      handleError(error, `Error during backup for game ${getGameDisplayName(gameObj)}`, []);
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

async function backupRegistry(resolvedPath: string, targetPath: string, backupConfig: BackupConfig, pathFolderName: string, resolvedPathObj: ResolvedPath, gameObj: Game) {
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

async function backupFileOrDirectory(resolvedPath: string, targetPath: string, backupConfig: BackupConfig, pathFolderName: string, resolvedPathObj: ResolvedPath, gameObj: Game) {
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

async function updateDatabase(): Promise<void> {
  const progressId = 'update-db';
  const progressTitle = i18next.t('alert.updating_database');
  const databaseLink = "https://raw.githubusercontent.com/dyang886/Game-Save-Manager/main/database/database.db";
  const dbPath = path.join(app.getPath("userData"), "GSM Database", "database.db");
  const backupPath = `${dbPath}.backup`;
  const downloadPath = `${dbPath}.download`;

  getMainWindow()!.webContents.send('update-progress', progressId, progressTitle, 'start');

  try {
    await ensureDirectoryExists(path.dirname(dbPath));
    await backupExistingDatabase(dbPath, backupPath);
    await removeBackup(downloadPath);
    await downloadDatabase(databaseLink, downloadPath, progressId, progressTitle);
    await validateDatabaseFile(downloadPath);
    await fse.move(downloadPath, dbPath, { overwrite: true });
    await removeBackup(backupPath);

    getMainWindow()!.webContents.send('update-progress', progressId, progressTitle, 'end');
    getMainWindow()!.webContents.send('show-alert', 'success', i18next.t('alert.update_db_success'));
  } catch (error) {
    handleUpdateError(error, backupPath, downloadPath, dbPath, progressId, progressTitle);
  }
}

async function ensureDirectoryExists(directoryPath: string): Promise<void> {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

async function backupExistingDatabase(dbPath: string, backupPath: string): Promise<void> {
  if (fs.existsSync(dbPath)) {
    fs.copyFileSync(dbPath, backupPath);
  }
}

async function downloadDatabase(databaseLink: string, dbPath: string, progressId: string, progressTitle: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = https.get(databaseLink, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Database download failed with status ${response.statusCode}`));
        return;
      }

      const totalSize = Number.parseInt(response.headers['content-length'] || '', 10);
      let downloadedSize = 0;

      const fileStream = fs.createWriteStream(dbPath);

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (Number.isFinite(totalSize) && totalSize > 0) {
          const progressPercentage = Math.round((downloadedSize / totalSize) * 100);
          getMainWindow()!.webContents.send('update-progress', progressId, progressTitle, progressPercentage);
        }
      });

      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => {
          resolve();
        });
      });

      response.on('error', (error) => {
        reject(error);
      });

      fileStream.on('error', (error) => {
        reject(error);
      });
    });

    request.on('error', (error) => {
      reject(error);
    });
  });
}

async function validateDatabaseFile(dbPath: string): Promise<void> {
  const db = new Database(dbPath, sqlite3.OPEN_READONLY);

  try {
    await new Promise<void>((resolve, reject) => {
      db.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'games'",
        (err, row) => {
          if (err) {
            reject(err);
            return;
          }
          if (!row) {
            reject(new Error('Downloaded database does not contain the games table'));
            return;
          }
          resolve();
        }
      );
    });
  } finally {
    await new Promise<void>((resolve) => {
      db.close((err) => {
        if (err) {
          console.error('[validateDatabaseFile] Error closing database:', err);
        }
        resolve();
      });
    });
  }
}

async function removeBackup(backupPath: string): Promise<void> {
  if (fs.existsSync(backupPath)) {
    fs.unlinkSync(backupPath);
  }
}

function handleUpdateError(error: unknown, backupPath: string, downloadPath: string, dbPath: string, progressId: string, progressTitle: string): void {
  if (error instanceof Error) {
    console.error(`An error occurred while updating the database: ${error.message}`);
    getMainWindow()!.webContents.send('show-alert', 'modal', i18next.t('alert.error_during_db_update'), error.message);
  }
  getMainWindow()!.webContents.send('update-progress', progressId, progressTitle, 'end');

  if (fs.existsSync(downloadPath)) {
    fs.unlinkSync(downloadPath);
  }

  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, dbPath);
    fs.unlinkSync(backupPath);
  }
}

export {
  getGameDataFromDB,
  getAllGameDataFromDB,
  backupGame,
  updateDatabase
};
