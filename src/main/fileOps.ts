import fsOriginal from 'original-fs';
import path from 'path';

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

export {
    calculateDirectorySize,
    copyFolder,
    ensureWritable,
};
