/**
 * Configuration for AudioBook Reader
 *
 * IMPORTANT: You need to set up your own Google Cloud project and get credentials.
 * See README.md for detailed instructions.
 */

const CONFIG = {
    // Google OAuth 2.0 Client ID
    // Get this from: https://console.cloud.google.com/apis/credentials
    GOOGLE_CLIENT_ID: '524735149839-e3pfcqlji0ij1f45tpf3af2ivqkosdgg.apps.googleusercontent.com',

    // Google API Key (for Drive API)
    // Get this from: https://console.cloud.google.com/apis/credentials
    GOOGLE_API_KEY: 'AIzaSyDSim0N9T9HFinPha7KoQcUgkY9muTECTE',

    // Google Drive API scopes.
    // - drive.file: per-file/folder access for items the user picks via
    //   Google Picker (or that the app creates). Non-sensitive scope —
    //   no Google verification needed to publish the OAuth app.
    // - drive.appdata: private per-app folder used by Sync to store
    //   listening progress across devices (invisible to the user via
    //   the Drive UI, only this app sees it)
    // - userinfo.*: profile + email for the sign-in UI
    SCOPES: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.appdata',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/userinfo.email'
    ].join(' '),

    // Supported file types
    SUPPORTED_TYPES: {
        pdf: ['application/pdf'],
        epub: ['application/epub+zip'],
        ebook: ['application/pdf', 'application/epub+zip'],
        audio: [
            'audio/mpeg',
            'audio/mp3',
            'audio/mp4',
            'audio/m4a',
            'audio/m4b',          // Audiobook format
            'audio/x-m4a',
            'audio/x-m4b',
            'audio/wav',
            'audio/wave',
            'audio/x-wav',
            'audio/ogg',
            'audio/vorbis',
            'audio/flac',
            'audio/x-flac',
            'audio/aac',
            'audio/x-aac',
            'audio/webm',
            'audio/3gpp',
            'audio/3gpp2',
            'audio/aiff',
            'audio/x-aiff',
            'audio/basic'
        ],
        archive: [
            'application/zip',
            'application/x-zip-compressed'
        ]
    },

    // Default settings
    DEFAULTS: {
        theme: 'dark',
        fontSize: 100,
        zoom: 100,
        displayMode: 'single',
        playbackSpeed: 1,
    },

    // Storage keys
    STORAGE_KEYS: {
        user: 'audiobook_user',
        accessToken: 'audiobook_access_token',
        selectedFolder: 'audiobook_selected_folder',
        bookProgress: 'audiobook_book_progress',
        settings: 'audiobook_settings',
    },

    // API endpoints
    API: {
        DRIVE_FILES: 'https://www.googleapis.com/drive/v3/files',
        USER_INFO: 'https://www.googleapis.com/oauth2/v3/userinfo',
    },

    // Default URL for the Cloudflare R2 source. Used when the user hasn't
    // saved their own value in localStorage. Empty string = no default
    // (settings will show "Ei konfiguroitu" until the user fills it in).
    //
    // This is safe to commit to a public repo: the URL is gated by the
    // r2-auth-worker which only serves to allowlisted Google accounts.
    R2_DEFAULT_BASE_URL: 'https://audiobookreader-r2.audiobooks.workers.dev',
};

// Freeze config to prevent accidental modifications
Object.freeze(CONFIG);
Object.freeze(CONFIG.SUPPORTED_TYPES);
Object.freeze(CONFIG.DEFAULTS);
Object.freeze(CONFIG.STORAGE_KEYS);
Object.freeze(CONFIG.API);
