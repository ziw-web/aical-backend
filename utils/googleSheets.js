const { google } = require('googleapis');

const getOAuthClient = (redirectUri) => {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        redirectUri || process.env.GOOGLE_SHEETS_CALLBACK_URL || `${process.env.BASE_URL || 'http://localhost:5001'}/api/auth/google-sheets/callback`
    );
};

const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/drive.metadata.readonly'
];

const getAuthUrl = (userId, redirectUri) => {
    const client = getOAuthClient(redirectUri);
    return client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        state: userId,
        prompt: 'consent' // Force refresh token
    });
};

const getTokens = async (code, redirectUri) => {
    const client = getOAuthClient(redirectUri);
    const { tokens } = await client.getToken(code);
    return tokens;
};

const getSheetsClient = (accessToken, refreshToken) => {
    const auth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
    );
    auth.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken
    });
    return google.sheets({ version: 'v4', auth });
};

const getDriveClient = (accessToken, refreshToken) => {
    const auth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
    );
    auth.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken
    });
    return google.drive({ version: 'v3', auth });
};

module.exports = {
    getAuthUrl,
    getTokens,
    getSheetsClient,
    getDriveClient
};
