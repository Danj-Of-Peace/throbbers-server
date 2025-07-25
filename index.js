import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { google } from 'googleapis';

dotenv.config();

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable!');
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});

const app = express();

// ✅ Fixed CORS setup
const allowedOrigins = [
  'https://throbbers-2025.web.app',
  'https://throbbers-host.web.app'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const FRONTEND_URI = process.env.FRONTEND_URI || 'https://throbbers-host.web.app/';

function getBasicAuthHeader() {
  const creds = `${CLIENT_ID}:${CLIENT_SECRET}`;
  return 'Basic ' + Buffer.from(creds).toString('base64');
}

// 🔐 Translate safeKey back to original artist name
async function getOriginalArtistName(safeKeyName, artistOrder = []) {
  const found = artistOrder.find(entry =>
    typeof entry === 'object' && entry.safe === safeKeyName
  );
  if (found?.original) return found.original;

  const db = admin.database();
  const namesSnap = await db.ref('artistNames').once('value');
  const artistNames = namesSnap.val() || {};
  return artistNames[safeKeyName] || safeKeyName;
}

app.get('/', (req, res) => res.send('✅ Spotify Auth Server is running'));

app.get('/ping', (req, res) => res.send('pong'));

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  const db = admin.database();

  if (!code) return res.status(400).send('Missing code');

  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': getBasicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const data = await tokenRes.json();
    if (data.error || !data.access_token || !data.refresh_token) {
      console.error('❌ Error during token exchange:', data);
      return res.status(400).json(data);
    }

    const { access_token, refresh_token } = data;
    await db.ref('spotifyAccessToken').set(access_token);
    await db.ref('spotifyRefreshToken').set(refresh_token);

    const redirectUrl = `${FRONTEND_URI}#access_token=${access_token}&refresh_token=${refresh_token}`;
    res.redirect(redirectUrl);
  } catch (err) {
    console.error('❌ Token exchange error:', err);
    res.status(500).send('Token exchange failed');
  }
});

app.get('/refresh', async (req, res) => {
  const refresh_token = req.query.refresh_token;
  if (!refresh_token) return res.status(400).send('Missing refresh_token');

  try {
    const refreshRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': getBasicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh_token,
      }),
    });

    const data = await refreshRes.json();
    if (data.error) {
      return res.status(400).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error('❌ Refresh token error:', err);
    res.status(500).send('Refresh failed');
  }
});

// === Google Sheets Setup ===

if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  console.error('Missing GOOGLE_SERVICE_ACCOUNT_JSON environment variable!');
  process.exit(1);
}

if (!process.env.GOOGLE_SHEET_ID) {
  console.error('Missing GOOGLE_SHEET_ID environment variable!');
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;

// 🔑 Sanitize artist name for Firebase-safe key
function safeKey(name) {
  return name.replace(/[.#$/\[\]]/g, '_');
}

// 📥 Fetch artist names from ARTISTS!B2:B
async function fetchGoogleSheet() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'ARTISTS!B1:L',
    });

    const rows = response.data.values;
    if (!rows || rows.length < 2) {
      throw new Error('No artist data found');
    }

    const header = rows[0];
    if (header[0].trim() !== 'ARTIST') {
      throw new Error(`Expected 'ARTIST' as header in column B but found '${header[0]}'`);
    }

    const data = rows.slice(1).map(row => {
      const artist = row[0]?.trim();
      if (!artist) return null;

      const tracks = [];
      for (let i = 1; i <= 5; i++) {
        const name = row[i]?.trim();
        const url = row[i + 5]?.trim(); // H=6, I=7, etc
        if (name && url) {
          tracks.push({ name, url });
        }
      }

      return {
        artist,
        safe: safeKey(artist),
        tracks
      };
    }).filter(Boolean);

    return data;
  } catch (err) {
    console.error('❌ Google Sheet fetch error:', err);
    throw err;
  }
}

// 📝 Record votes and log to Google Sheets
app.post('/record-votes', async (req, res) => {
  try {
    const { artist: safeArtist, votes } = req.body;

    if (!safeArtist || !votes || typeof votes !== 'object') {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const timestamp = new Date().toISOString();
    const db = admin.database();

    const artistOrderSnap = await db.ref('artistOrder').once('value');
    const artistOrder = artistOrderSnap.val() || [];

    const originalArtist = await getOriginalArtistName(safeArtist, artistOrder);

    const [guestsSnap, hostSnap] = await Promise.all([
      db.ref('guests').once('value'),
      db.ref('host').once('value')
    ]);

    const guestList = guestsSnap.val() || {};
    const hostList = hostSnap.val() || {};
    const allUsers = Object.keys({ ...guestList, ...hostList }).sort();

    // Fill missing votes with "no"
    for (const user of allUsers) {
      if (!(user in votes)) {
        votes[user] = 'no';
      }
    }

    await db.ref(`votes/${safeArtist}`).set({
      originalName: originalArtist,
      votes,
      timestamp
    });

    const headers = ['TIMESTAMP', 'ARTIST', ...allUsers];
    const row = [timestamp, originalArtist, ...allUsers.map(name => votes[name])];

    // Check if headers already exist
    const getSheetData = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'VOTES!A1:Z1',
    });
    const hasHeaders = getSheetData.data.values && getSheetData.data.values.length > 0;

    if (!hasHeaders) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: 'VOTES!A1',
        valueInputOption: 'RAW',
        requestBody: {
          values: [headers],
        },
      });
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'VOTES!A2',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [row],
      },
    });

    console.log('✅ Vote recorded:', row);
    res.status(200).json({ success: true });

  } catch (err) {
    console.error('❌ Vote record failed:', err.response?.data || err.message || err);
    res.status(500).json({ error: 'Failed to record votes' });
  }
});

// 📤 Expose artist info: { order: [], names: {} }
app.get('/artist-info', async (req, res) => {
  try {
    const data = await fetchGoogleSheet();
    const artistNames = {};
    const artistList = [];
    const trackMap = {};

    for (const row of data) {
      artistNames[row.safe] = row.artist;
      artistList.push(row.safe);
      trackMap[row.safe] = row.tracks || [];
    }

    const db = admin.database();
    const artistOrderRef = db.ref('artistOrder');
    const orderSnap = await artistOrderRef.once('value');
    let artistOrder = orderSnap.val();

    if (!artistOrder || !Array.isArray(artistOrder) || artistOrder.length === 0) {
      artistOrder = [...artistList].sort(() => 0.5 - Math.random());
      await artistOrderRef.set(artistOrder);
      await db.ref('artistNames').set(artistNames);
      console.log('✅ Stored new artistOrder and artistNames');
    }

    res.json({
      order: artistOrder,
      names: artistNames,
      tracks: trackMap
    });

  } catch (err) {
    console.error('❌ Failed to return artist info:', err);
    res.status(500).json({ error: 'Failed to load artist info' });
  }
});

app.get('/throb-count', async (req, res) => {
  const host = req.query.host;
  if (!host) {
    return res.status(400).json({ error: 'Missing host parameter' });
  }

  try {
    // Read header + data for columns A to Z (you can expand this if you have more columns)
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'VOTES!A1:Z',
    });

    const rows = response.data.values || [];
    const headerRow = rows[0] || [];

    // Find the index of the host column (e.g., 'DANJ')
    const columnIndex = headerRow.indexOf(host);
    if (columnIndex === -1) {
      return res.status(404).json({ error: `Host '${host}' not found in sheet header` });
    }

    // Count 'yes' votes in that column (skip header row)
    const yesCount = rows.slice(1)
      .map(row => row[columnIndex])
      .filter(v => typeof v === 'string' && v.trim().toLowerCase() === 'yes')
      .length;

    res.json({ count: yesCount });
  } catch (err) {
    console.error('❌ Failed to get throb count:', err.message);
    res.status(500).json({ error: 'Failed to get throb count' });
  }
});

app.get('/extra-tracks', async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: '16qP3v4Q2QhdFyAmHA9VdevlJ_8SBtIikukgL5tUz6_g',
      range: 'LINK!E:K', // Columns E-K, we'll extract E, F, K
    });

    const rows = response.data.values || [];

    // Find header indexes
    const headers = rows[0];
    const trackIdx = headers.indexOf('TRACK'); // likely 0 (E)
    const artistIdx = headers.indexOf('ARTIST'); // likely 1 (F)
    const linkIdx = headers.indexOf('LINKS'); // likely 5 (K - counting E=0,F=1,...K=5)

    if (trackIdx === -1 || artistIdx === -1 || linkIdx === -1) {
      return res.status(500).json({ error: 'Headers missing in sheet' });
    }

    // Map rows to objects, skipping header row
    const extraTracks = rows.slice(1).map(row => ({
      artist: row[artistIdx] || '',
      track: row[trackIdx] || '',
      spotifyUrl: row[linkIdx] || '',
    })).filter(t => t.artist && t.track && t.spotifyUrl);

    console.log('✅ Sending extra tracks:', extraTracks.length);
res.json(extraTracks);
  } catch (err) {
    console.error('Failed to load extra tracks:', err);
    res.status(500).json({ error: 'Failed to load extra tracks' });
  }
});

// 🧹 Clear Google Sheet vote logs
app.post('/clear-sheet', async (req, res) => {
  try {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: 'VOTES!A1:Z',
    });

    res.status(200).json({ message: '✅ Google Sheet cleared.' });
  } catch (err) {
    console.error('❌ Failed to clear Google Sheet:', err);
    res.status(500).json({ message: 'Failed to clear Google Sheet.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});