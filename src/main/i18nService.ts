import i18next from 'i18next';
import Backend from 'i18next-fs-backend';

import { getLocalePath } from './paths';

const initializeI18next = (language: string) => {
    return i18next
        .use(Backend)
        .init({
            lng: language,
            fallbackLng: 'en_US',
            backend: {
                loadPath: getLocalePath('{{lng}}.json'),
            },
        });
};

export {
    initializeI18next,
};
