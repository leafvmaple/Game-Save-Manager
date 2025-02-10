import { app, dialog } from 'electron';
import { exec } from 'child_process';
import { glob } from 'glob';
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
  calculateDirectorySize,
  ensureWritable,
  getNewestBackup,
  copyFolder,
  placeholderMapping,
  placeholderIdentifier,
  osKeyMap,
  getSettings,
} from './global';
import { getGameData } from './gameData';

const execPromise = util.promisify(exec);

interface Game {
  title: string;
  wiki_page_id: string;
  install_folder: string;
  steam_id?: number;
  gog_id?: number;
  save_location: {
    win: string[];
    reg: string[];
    mac: string[];
    linux: string[];
  };
  platform: string[];
  zh_CN?: string | null;
  install_path: string;
  latest_backup: string;
  resolved_paths: ResolvedPath[];
  backup_size: number;
}

interface ResolvedPath {
  template: string;
  resolved: string;
  uid?: string;
  type?: 'reg' | 'folder' | 'file';
}

interface BackupConfig {
  title: string;
  zh_CN: string | null;
  backup_paths: BackupPath[];
}

interface BackupPath {
  folder_name: string;
  template: string;
  type: 'reg' | 'folder' | 'file';
  install_folder: string | null;
}

async function getGameDataFromDB(): Promise<{ games: Game[]; errors: string[] }> {
  const games: Game[] = [];
  const errors: string[] = [];
  const dbPath = path.join(app.getPath('userData'), 'GSM Database', 'database.db');
  if (!fs.existsSync(dbPath)) {
    const installedDbPath = path.join('./database', 'database.db');
    if (!fs.existsSync(installedDbPath)) {
      dialog.showErrorBox(
        i18next.t('alert.missing_database_file'),
        i18next.t('alert.missing_database_file_message')
      );
      return { games, errors };
    } else {
      await fse.copy(installedDbPath, dbPath);
    }
  }
  const db = new Database(dbPath, sqlite3.OPEN_READONLY);
  let stmtInstallFolder: sqlite3.Statement;

  return new Promise(async (resolve, reject) => {
    try {
      stmtInstallFolder = db.prepare('SELECT * FROM games WHERE install_folder = ?');
      const gameInstallPaths = getSettings().gameInstalls;

      const customDBPath = path.join(getSettings().backupPath, 'custom_database.json');
      const customDBs: Game[] = [];
      if (fs.existsSync(customDBPath)) {
        const customs = JSON.parse(fs.readFileSync(customDBPath, 'utf-8'));
        for (const game of customs) {
          customDBs.push(game);
        }
      }

      // Process database entries
      if (gameInstallPaths.length > 0) {
        for (const installPath of gameInstallPaths) {
          const directories = fsOriginal
            .readdirSync(installPath, { withFileTypes: true })
            .filter((dirent) => dirent.isDirectory())
            .map((dirent) => dirent.name);

          for (const dir of directories) {
            const rows = await new Promise<any[]>((resolve, reject) => {
              stmtInstallFolder.all(dir, (err, rows) => {
                if (err) {
                  reject(err);
                } else {
                  resolve(rows);
                }
              });
            });

            if (rows && rows.length > 0) {
              for (const row of rows) {
                try {
                  row.wiki_page_id = row.wiki_page_id.toString();
                  row.platform = JSON.parse(row.platform);
                  row.save_location = JSON.parse(row.save_location);
                  row.install_path = path.join(installPath, dir);
                  row.latest_backup = getNewestBackup(row.wiki_page_id);

                  const processed_game = await process_game(row);
                  if (processed_game.resolved_paths.length !== 0) {
                    games.push(processed_game);
                  }
                } catch (err) {
                  console.log('game', row)
                  console.error(`Error processing database game ${getGameDisplayName(row)}: ${err.stack}`);
                  errors.push(
                    `${i18next.t('alert.backup_process_error_db', { game_name: getGameDisplayName(row) })}: ${
                      err.message
                    }`
                  );
                }
              }
            }

            const customs = customDBs.filter((game) => game.install_folder === dir);
            for (const custom of customs) {
              try {
                custom.wiki_page_id = custom.wiki_page_id.toString();
                custom.platform = ['Custom'];
                custom.install_path = path.join(installPath, dir);
                custom.latest_backup = getNewestBackup(custom.wiki_page_id);

                const processed_game = await process_game(custom);
                console.log('processed_game', processed_game);
                if (processed_game.resolved_paths.length !== 0) {
                  games.push(processed_game);
                }
              } catch (err) {
                console.error(`Error processing custom game ${custom.title}: ${err.stack}`);
                errors.push(
                  `${i18next.t('alert.backup_process_error_custom', { game_name: custom.title })}: ${err.message}`
                );
              }
            }
          }
        }
      }

      stmtInstallFolder.finalize();

      // Process custom entries after the database games
      const customJsonPath = path.join(getSettings().backupPath, 'custom_entries.json');

      if (fs.existsSync(customJsonPath)) {
        const { customGames, customGameErrors } = await processCustomEntries(customJsonPath);
        games.push(...customGames);
        errors.push(...customGameErrors);
      }
    } catch (error) {
      console.error(`Error displaying backup table: ${error.stack}`);
      errors.push(`${i18next.t('alert.backup_process_error_display')}: ${error.message}`);
      if (stmtInstallFolder) {
        stmtInstallFolder.finalize();
      }
    } finally {
      db.close();
      resolve({ games, errors });
    }
  });
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
        customEntry.save_location[plat] = customEntry.save_location[plat].map((entry) => entry.template);
      }

      const processed_game = await process_game(customEntry);
      if (processed_game.resolved_paths.length !== 0) {
        customGames.push(processed_game);
      }
    } catch (err) {
      console.error(`Error processing custom game ${customEntry.title}: ${err.stack}`);
      customGameErrors.push(
        `${i18next.t('alert.backup_process_error_custom', { game_name: customEntry.title })}: ${err.message}`
      );
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

            const processed_game = await process_game(row);
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

async function process_game(db_game_row: Game): Promise<Game> {
  const resolved_paths: ResolvedPath[] = [];
  let totalBackupSize = 0;

  const currentOS = os.platform();
  const osKey = osKeyMap[currentOS];

  if (osKey && db_game_row.save_location[osKey]) {
    for (const templatedPath of db_game_row.save_location[osKey]) {
      console.log('templatedPath', templatedPath)
      console.log('db_game_row.install_path', db_game_row.install_path)
      const resolvedPath = await resolveTemplatedBackupPath(templatedPath, db_game_row.install_path);

      // Check whether the resolved path actually exists then calculate size
      if (resolvedPath.path.includes('*')) {
        const files = glob.sync(resolvedPath.path.replace(/\\/g, '/'));
        for (const filePath of files) {
          if (fsOriginal.existsSync(filePath)) {
            totalBackupSize += calculateDirectorySize(filePath);
            resolved_paths.push({
              template: templatedPath,
              resolved: path.normalize(filePath),
              uid: resolvedPath.uid,
            });
          }
        }
      } else {
        if (fsOriginal.existsSync(resolvedPath.path)) {
          totalBackupSize += calculateDirectorySize(resolvedPath.path);
          resolved_paths.push({
            template: templatedPath,
            resolved: path.normalize(resolvedPath.path),
            uid: resolvedPath.uid,
          });
        }
      }
    }
  }

  // Process registry paths
  if (osKey === 'win' && db_game_row.save_location['reg'] && db_game_row.save_location['reg'].length > 0) {
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
            getMainWindow().webContents.send(
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

  db_game_row.resolved_paths = resolved_paths;
  db_game_row.backup_size = totalBackupSize;

  return db_game_row;
}

function getWinRegHive(hive: string): string | null {
  switch (hive) {
    case 'HKEY_CURRENT_USER':
      return WinReg.HKCU;
    case 'HKEY_LOCAL_MACHINE':
      return WinReg.HKLM;
    case 'HKEY_CLASSES_ROOT':
      return WinReg.HKCR;
    default: {
      console.warn(`Invalid registry hive: ${hive}`);
      return null;
    }
  }
}

function parseRegistryPath(registryPath: string): { hive: string; key: string } {
  const parts = registryPath.split('\\');
  const hive = parts.shift()!;
  const key = '\\' + parts.join('\\');

  return { hive, key };
}

// Resolves the templated path to the actual path based on the save_path_mapping
async function resolveTemplatedBackupPath(
  templatedPath: string,
  gameInstallPath: string | null
): Promise<{ path: string; uid?: string }> {
  let basePath = templatedPath.replace(/\{\{p\|[^\}]+\}\}/gi, (match) => {
    const normalizedMatch = match.toLowerCase().replace(/\\/g, '/');

    if (normalizedMatch === '{{p|game}}') {
      return gameInstallPath!;
    } else if (normalizedMatch === '{{p|steam}}') {
      return getGameData().steamPath!;
    } else if (normalizedMatch === '{{p|uplay}}' || normalizedMatch === '{{p|ubisoftconnect}}') {
      return getGameData().ubisoftPath!;
    } else if (normalizedMatch === '{{p|uid}}') {
      // Defer handling of {{p|uid}} to the next step
      return '{{p|uid}}';
    } else if (normalizedMatch === '{{p|userprofile/documents}}') {
      return app.getPath('documents');
    }

    return placeholderMapping[normalizedMatch] || match;
  });

  // Final check for unresolved placeholders, but ignore {{p|uid}}
  if (/\{\{p\|[^\}]+\}\}/i.test(basePath.toLowerCase().replace(/\{\{p\|uid\}\}/gi, ''))) {
    console.warn(`Unresolved placeholder found in path: ${basePath}`);
    return { path: '' };
  }

  // Handle {{p|uid}}
  if (basePath.includes('{{p|uid}}')) {
    return await fillPathUid(basePath);
  } else {
    return { path: basePath };
  }
}

async function fillPathUid(basePath: string): Promise<{ path: string; uid?: string }> {
  const userIds = [
    getGameData().currentSteamUserId64,
    getGameData().currentSteamUserId3,
    getGameData().currentUbisoftUserId,
  ];

  // Check with pre-determined user ids
  for (const uid of userIds) {
    console.log(uid, basePath)
    const resolvedPath = basePath.replace(/\{\{p\|uid\}\}/gi, uid!).replace(/\\/g, '/');
    console.log("resolvedPath", resolvedPath)
    const matchedPaths = glob.sync(resolvedPath);

    if (matchedPaths.length > 0) {
      return {
        path: resolvedPath,
        uid: uid!,
      };
    }
  }

  // If no valid paths found with userIds, attempt wildcard for uid
  const wildcardPath = basePath.replace(/\{\{p\|uid\}\}/gi, '*');
  const wildcardResolvedPaths = glob.sync(wildcardPath.replace(/\\/g, '/'));

  if (wildcardResolvedPaths.length === 0) {
    return { path: '' };
  }

  const latestPath = await findLatestModifiedPath(wildcardResolvedPaths);
  const extractedUid = extractUidFromPath(basePath, latestPath);
  return {
    path: basePath.replace(/\{\{p\|uid\}\}/gi, extractedUid!),
    uid: extractedUid!,
  };
}

// Find the latest modified path
async function findLatestModifiedPath(paths: string[]): Promise<string> {
  let latestPath: string | null = null;
  let latestTime = 0;

  for (const filePath of paths) {
    const stats = fsOriginal.statSync(filePath);
    if (stats.mtimeMs > latestTime) {
      latestTime = stats.mtimeMs;
      latestPath = filePath;
    }
  }

  return latestPath!;
}

// Extract the uid from the resolved path based on the template path
function extractUidFromPath(templatePath: string, resolvedPath: string): string | null {
  const templateParts = templatePath.split(path.sep);
  const resolvedParts = resolvedPath.split(path.sep);

  // Find where {{p|uid}} appears in the template and extract the corresponding part from the resolved path
  const uidIndex = templateParts.findIndex((part) => part.includes('{{p|uid}}'));

  if (uidIndex !== -1 && resolvedParts[uidIndex]) {
    const matchedPart = resolvedParts[uidIndex];
    const prefix = templateParts[uidIndex].split('{{p|uid}}')[0]; // "user_"
    if (prefix && matchedPart.startsWith(prefix)) {
      return matchedPart.slice(prefix.length);
    }
    return matchedPart;
  }

  return null;
}

async function backupGame(gameObj: Game): Promise<string | null> {
  const gameBackupPath = path.join(getSettings().backupPath, gameObj.wiki_page_id.toString());

  // Create a new backup instance folder based on the current date and time
  const backupInstanceFolder = moment().format('YYYY-MM-DD_HH-mm');
  const backupInstancePath = path.join(gameBackupPath, backupInstanceFolder);

  try {
    const backupConfig: BackupConfig = {
      title: gameObj.title,
      zh_CN: gameObj.zh_CN || null,
      backup_paths: [],
    };

    // Iterate over resolved paths and copy files to the backup instance
    for (const [index, resolvedPathObj] of gameObj.resolved_paths.entries()) {
      const resolvedPath = path.normalize(resolvedPathObj.resolved);
      const pathFolderName = `path${index + 1}`;
      const targetPath = path.join(backupInstancePath, pathFolderName);
      fsOriginal.mkdirSync(targetPath, { recursive: true });

      if (resolvedPathObj.type === 'reg') {
        // Registry backup logic using reg.exe
        const registryFilePath = path.join(targetPath, 'registry_backup.reg');

        const regExportCommand = `reg export "${resolvedPath}" "${registryFilePath}" /y`;
        await execPromise(regExportCommand);

        backupConfig.backup_paths.push({
          folder_name: pathFolderName,
          template: resolvedPathObj.template,
          type: 'reg',
          install_folder: gameObj.install_folder || null,
        });
      } else {
        // File/directory backup logic
        let dataType: 'folder' | 'file' | null = null;
        ensureWritable(resolvedPath);
        const stats = fsOriginal.statSync(resolvedPath);

        if (stats.isDirectory()) {
          dataType = 'folder';
          copyFolder(resolvedPath, targetPath);
        } else {
          dataType = 'file';
          const targetFilePath = path.join(targetPath, path.basename(resolvedPath));
          fsOriginal.copyFileSync(resolvedPath, targetFilePath);
        }

        backupConfig.backup_paths.push({
          folder_name: pathFolderName,
          template: finalizeTemplate(resolvedPathObj.template, resolvedPathObj.resolved, resolvedPathObj.uid, gameObj.install_path),
          type: dataType,
          install_folder: gameObj.install_folder || null,
        });
      }
    }

    const configFilePath = path.join(backupInstancePath, 'backup_info.json');
    await fse.writeJson(configFilePath, backupConfig, { spaces: 4 });

    const existingBackups = fsOriginal.readdirSync(gameBackupPath).sort((a, b) => a.localeCompare(b));

    // If there are more backups than allowed, delete the oldest ones
    const maxBackups = getSettings().maxBackups;
    if (existingBackups.length > maxBackups) {
      const backupsToDelete = existingBackups.slice(0, existingBackups.length - maxBackups);
      for (const backup of backupsToDelete) {
        const backupToDeletePath = path.join(gameBackupPath, backup);
        fsOriginal.rmSync(backupToDeletePath, { recursive: true, force: true });
      }
    }
  } catch (error) {
    console.error(`Error during backup for game ${getGameDisplayName(gameObj)}: ${error.stack}`);
    return `${i18next.t('alert.backup_game_error', { game_name: getGameDisplayName(gameObj) })}: ${error.message}`;
  }

  return null;
}

// Replace wildcards and uid by finding the corresponding components in resolved path
function finalizeTemplate(template: string, resolvedPath: string, uid: string | undefined, gameInstallPath: string): string {
  function splitTemplatePath(templatePath: string): string[] {
    let normalizedTemplate = templatePath.replace(/\{\{p\|[^\}]+\}\}/gi, match => {
      const normalizedMatch = match.toLowerCase().replace(/\\/g, '/');
      return placeholderIdentifier[normalizedMatch] || normalizedMatch;
    });

    return normalizedTemplate.replace(/[\\/]+/g, path.sep).split(path.sep);
  }

  const templateParts = splitTemplatePath(template);
  let resolvedParts = resolvedPath.split(path.sep);

  let resultParts: string[] = [];
  let resolvedIndex = 0;

  for (let i = 0; i < templateParts.length; i++) {
    const currentPart = templateParts[i];

    // Process placeholders
    if (/\{\{p\d+\}\}/.test(currentPart)) {
      let pathMapping = '';
      const placeholder = findKeyByValue(placeholderIdentifier, currentPart) || currentPart;

      if (currentPart.includes('{{p11}}')) {
        pathMapping = currentPart.replace('{{p11}}', gameInstallPath);
      } else if (currentPart.includes('{{p13}}')) {
        pathMapping = currentPart.replace('{{p13}}', getGameData().steamPath!);
      } else if (currentPart.includes('{{p14}}')) {
        pathMapping = currentPart.replace('{{p14}}', getGameData().ubisoftPath!);
      } else if (currentPart.includes('{{p12}}')) {
        resultParts.push(currentPart.replace('{{p12}}', uid!));
        resolvedIndex++;
        continue;
      } else {
        pathMapping = placeholderMapping[placeholder];
      }

      resultParts.push(placeholder);
      const splittedPathMapping = pathMapping.split(path.sep);
      resolvedIndex += splittedPathMapping.length;

      // Process wildcards
    } else if (currentPart.includes('*')) {
      resultParts.push(resolvedParts[resolvedIndex]);
      resolvedIndex++;

      // Process normal path elements
    } else {
      resultParts.push(currentPart);
      resolvedIndex++;
    }
  }

  return path.join(...resultParts);
}

function findKeyByValue(obj: { [key: string]: string }, value: string): string | undefined {
  return Object.keys(obj).find(key => obj[key] === value);
}

async function updateDatabase(): Promise<void> {
  const progressId = 'update-db';
  const progressTitle = i18next.t('alert.updating_database');
  const databaseLink = "https://raw.githubusercontent.com/dyang886/Game-Save-Manager/main/database/database.db";
  const dbPath = path.join(app.getPath("userData"), "GSM Database", "database.db");
  const backupPath = `${dbPath}.backup`;

  getMainWindow().webContents.send('update-progress', progressId, progressTitle, 'start');

  try {
    if (!fs.existsSync(path.dirname(dbPath))) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, backupPath);
    }

    await new Promise<void>((resolve, reject) => {
      const request = https.get(databaseLink, (response) => {
        const totalSize = parseInt(response.headers['content-length']!, 10);
        let downloadedSize = 0;

        const fileStream = fs.createWriteStream(dbPath);

        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          const progressPercentage = Math.round((downloadedSize / totalSize) * 100);
          getMainWindow().webContents.send('update-progress', progressId, progressTitle, progressPercentage);
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
      });

      request.on('error', (error) => {
        reject(error);
      });
    });

    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
    getMainWindow().webContents.send('update-progress', progressId, progressTitle, 'end');
    getMainWindow().webContents.send('show-alert', 'success', i18next.t('alert.update_db_success'));

  } catch (error) {
    console.error(`An error occurred while updating the database: ${error.message}`);
    getMainWindow().webContents.send('show-alert', 'modal', i18next.t('alert.error_during_db_update'), error.message);
    getMainWindow().webContents.send('update-progress', progressId, progressTitle, 'end');

    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, dbPath);
      fs.unlinkSync(backupPath);
    }
  }
}

export {
  getGameDataFromDB,
  getAllGameDataFromDB,
  backupGame,
  updateDatabase
};