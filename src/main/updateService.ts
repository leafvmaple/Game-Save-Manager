import { Notification, app } from 'electron';
import i18next from 'i18next';

import { getAssetPath } from './paths';

const UPDATE_URL = 'https://api.github.com/repos/dyang886/Game-Save-Manager/releases/latest';

const parseVersion = (version: string): number[] => {
    return version
        .replace(/^v/i, '')
        .split(/[+-]/)[0]
        .split('.')
        .map(part => Number.parseInt(part, 10) || 0);
};

const isVersionGreater = (candidate: string, current: string): boolean => {
    const candidateParts = parseVersion(candidate);
    const currentParts = parseVersion(current);
    const maxLength = Math.max(candidateParts.length, currentParts.length);

    for (let index = 0; index < maxLength; index++) {
        const candidatePart = candidateParts[index] || 0;
        const currentPart = currentParts[index] || 0;
        if (candidatePart > currentPart) return true;
        if (candidatePart < currentPart) return false;
    }

    return false;
};

const showNotification = (type: 'info' | 'warning' | 'critical', title: string, body: string) => {
    const iconMap: { [key: string]: string } = {
        'info': getAssetPath('information.png'),
        'warning': getAssetPath('warning.png'),
        'critical': getAssetPath('critical.png')
    };
    new Notification({ title, body, icon: iconMap[type] }).show();
};

const getCurrentVersion = () => app.getVersion();

const getLatestVersion = async (): Promise<string | null> => {
    try {
        const response = await fetch(UPDATE_URL);
        const data = await response.json();
        return data.tag_name ? data.tag_name.replace(/^v/, '') : null;
    } catch (error) {
        console.error('Error checking for update:', error.stack);
        return null;
    }
};

const checkAppUpdate = async () => {
    try {
        const response = await fetch(UPDATE_URL);
        const data = await response.json();
        const currentVersion = getCurrentVersion();
        const latestVersion = data.tag_name ? data.tag_name.replace(/^v/, '') : currentVersion;

        if (isVersionGreater(latestVersion, currentVersion)) {
            showNotification(
                'info',
                i18next.t('alert.update_available'),
                `${i18next.t('alert.new_version_found', { old_version: currentVersion, new_version: latestVersion })}\n${i18next.t('alert.new_version_found_text')}`
            );
        }
    } catch (error) {
        console.error('Error checking for update:', error.stack);
        showNotification(
            'warning',
            i18next.t('alert.update_check_failed'),
            i18next.t('alert.update_check_failed_text')
        );
    }
};

export {
    checkAppUpdate,
    getCurrentVersion,
    getLatestVersion,
};
