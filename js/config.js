/**
 * Configuration for AudioBook Reader
 *
 * IMPORTANT: You need to set up your own Google Cloud project and get credentials.
 * See README.md for detailed instructions.
 */

const CONFIG = {
    // Google OAuth 2.0 Client ID
    // Get this from: https://console.cloud.google.com/apis/credentials
    GOOGLE_CLIENT_ID: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',

    // Google API Key (for Drive API)
    // Get this from: https://console.cloud.google.com/apis/credentials
    GOOGLE_API_KEY: 'YOUR_GOOGLE_API_KEY',

    // Google Drive API scopes
    SCOPES: [
        'https://www.googleapis.com/auth/drive.readonly',
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
    }
};

// Freeze config to prevent accidental modifications
Object.freeze(CONFIG);
Object.freeze(CONFIG.SUPPORTED_TYPES);
Object.freeze(CONFIG.DEFAULTS);
Object.freeze(CONFIG.STORAGE_KEYS);
Object.freeze(CONFIG.API);
