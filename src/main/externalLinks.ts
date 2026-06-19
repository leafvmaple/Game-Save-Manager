import { shell } from 'electron';

const allowedExternalHosts = new Set([
    'github.com',
    'www.github.com',
    'pcgamingwiki.com',
    'www.pcgamingwiki.com',
    'bilibili.com',
    'www.bilibili.com',
    'space.bilibili.com',
]);

const openAllowedExternalUrl = async (url: string): Promise<boolean> => {
    try {
        const parsedUrl = new URL(url);
        if (!['https:', 'http:'].includes(parsedUrl.protocol)) {
            return false;
        }
        if (!allowedExternalHosts.has(parsedUrl.hostname.toLowerCase())) {
            return false;
        }
        await shell.openExternal(parsedUrl.toString());
        return true;
    } catch (error) {
        console.error(`Rejected invalid external URL: ${url}`, error);
        return false;
    }
};

export {
    openAllowedExternalUrl,
};
