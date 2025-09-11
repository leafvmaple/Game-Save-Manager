import { app } from 'electron';
import fs from 'fs';
import fsOriginal from 'original-fs';
import path from 'path';
import { glob } from 'glob';
import WinReg from 'winreg';
import i18next from 'i18next';
import { getGameData } from './gameData';
import { getMainWindow, calculateDirectorySize, placeholderMapping, placeholderIdentifier, osKeyMap } from './global';

// Interfaces
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

// Utility Functions
function getWinRegHive(hive: string): string | null {
  switch (hive) {
    case 'HKEY_CURRENT_USER':
      return WinReg.HKCU;
    case 'HKEY_LOCAL_MACHINE':
      return WinReg.HKLM;
    case 'HKEY_CLASSES_ROOT':
      return WinReg.HKCR;
    default:
      console.warn(`Invalid registry hive: ${hive}`);
      return null;
  }
}

function parseRegistryPath(registryPath: string): { hive: string; key: string } {
  const parts = registryPath.split('\\');
  const hive = parts.shift()!;
  const key = '\\' + parts.join('\\');
  return { hive, key };
}

async function resolveTemplatedBackupPath(
  templatedPath: string,
  gameInstallPath: string | null
): Promise<{ path: string; uid?: string }> {
  let basePath = templatedPath.replace(/\{\{p\|[^\}]+\}\}/gi, (match) => {
    const normalizedMatch = match.toLowerCase().replace(/\\/g, '/');
    switch (normalizedMatch) {
      case '{{p|game}}':
        return gameInstallPath!;
      case '{{p|steam}}':
        return getGameData().steamPath!;
      case '{{p|uplay}}':
      case '{{p|ubisoftconnect}}':
        return getGameData().ubisoftPath!;
      case '{{p|uid}}':
        return '{{p|uid}}';
      default:
        return placeholderMapping[normalizedMatch] || match;
    }
  });

  if (/\{\{p\|[^\}]+\}\}/i.test(basePath.toLowerCase().replace(/\{\{p\|uid\}\}/gi, ''))) {
    console.warn(`Unresolved placeholder found in path: ${basePath}`);
    return { path: '' };
  }

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

  for (const uid of userIds) {
    const resolvedPath = basePath.replace(/\{\{p\|uid\}\}/gi, uid!).replace(/\\/g, '/');
    const matchedPaths = glob.sync(resolvedPath);

    if (matchedPaths.length > 0) {
      return {
        path: resolvedPath,
        uid: uid!,
      };
    }
  }

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

function extractUidFromPath(templatePath: string, resolvedPath: string): string | null {
  const templateParts = templatePath.split(path.sep);
  const resolvedParts = resolvedPath.split(path.sep);
  const uidIndex = templateParts.findIndex((part) => part.includes('{{p|uid}}'));

  if (uidIndex !== -1 && resolvedParts[uidIndex]) {
    const matchedPart = resolvedParts[uidIndex];
    const prefix = templateParts[uidIndex].split('{{p|uid}}')[0];
    if (prefix && matchedPart.startsWith(prefix)) {
      return matchedPart.slice(prefix.length);
    }
    return matchedPart;
  }

  return null;
}

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

    if (/\{\{p\d+\}\}/.test(currentPart)) {
      let pathMapping = '';
      const placeholder = findKeyByValue(placeholderIdentifier, currentPart) || currentPart;

      switch (currentPart) {
        case '{{p11}}':
          pathMapping = currentPart.replace('{{p11}}', gameInstallPath);
          break;
        case '{{p13}}':
          pathMapping = currentPart.replace('{{p13}}', getGameData().steamPath!);
          break;
        case '{{p14}}':
          pathMapping = currentPart.replace('{{p14}}', getGameData().ubisoftPath!);
          break;
        case '{{p12}}':
          resultParts.push(currentPart.replace('{{p12}}', uid!));
          resolvedIndex++;
          continue;
        default:
          pathMapping = placeholderMapping[placeholder];
      }

      resultParts.push(placeholder);
      const splittedPathMapping = pathMapping.split(path.sep);
      resolvedIndex += splittedPathMapping.length;

    } else if (currentPart.includes('*')) {
      resultParts.push(resolvedParts[resolvedIndex]);
      resolvedIndex++;

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

export {
  Game,
  ResolvedPath,
  BackupConfig,
  BackupPath,
  getWinRegHive,
  parseRegistryPath,
  resolveTemplatedBackupPath,
  fillPathUid,
  findLatestModifiedPath,
  extractUidFromPath,
  finalizeTemplate,
  findKeyByValue
};