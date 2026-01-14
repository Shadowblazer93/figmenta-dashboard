import express from 'express';
import multer from 'multer';
import pg from 'pg';
import path from 'path';
import cors from 'cors';
import fs from 'fs';
import pdf from 'pdf-parse';
import dotenv from 'dotenv';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Load env from root
dotenv.config({ path: path.join(__dirname, '../.env') });

const { Pool } = pg;
const app = express();
const port = 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key-change-this';

// Middleware
app.use(cors());
app.use(express.json());
// Serve static files from 'public' (which might be empty now, but ready for frontend)
app.use(express.static(path.join(__dirname, 'public')));


// Database setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Discord REST Client
const discordToken = process.env.DISCORD_TOKEN;
let discordRest: REST | null = null;
if (discordToken) {
    discordRest = new REST({ version: '10' }).setToken(discordToken);
    console.log('Discord REST client initialized');
} else {
    console.warn('DISCORD_TOKEN not found in environment variables. Channel name resolution will not work.');
}

// Ensure tables exist
async function initTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS knowledge_base (
            id SERIAL PRIMARY KEY,
            filename TEXT,
            content TEXT,
            upload_date BIGINT
        );
        CREATE TABLE IF NOT EXISTS channel_instructions (
            channel_id TEXT PRIMARY KEY,
            instructions TEXT
        );
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,

            value TEXT
        );
        CREATE TABLE IF NOT EXISTS allowed_channels (
            channel_id TEXT PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS channel_memory (
            channel_id TEXT PRIMARY KEY,
            summary TEXT,
            last_updated BIGINT
        );
    `);
}
initTables();

// Upload setup
const upload = multer({ dest: 'uploads/' });

// Auth Middleware
const authenticateToken = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
        if (err) return res.sendStatus(403);
        (req as any).user = user;
        next();
    });
};

// API Routes

// 0. Auth
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ token });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// 1. System Instructions
app.get('/api/status', authenticateToken, async (req, res) => {
    if (!discordRest) {
        return res.json({ status: 'offline', message: 'No token configured' });
    }
    try {
        await discordRest.get(Routes.user('@me'));
        res.json({ status: 'online' });
    } catch (error) {
        console.error('Bot status check failed:', error);
        res.json({ status: 'offline', error: 'Unreachable' });
    }
});

app.get('/api/config/instructions', authenticateToken, async (req, res) => {

    try {
        const { channelId } = req.query;
        
        let instructions = '';
        
        if (channelId && typeof channelId === 'string') {
            const result = await pool.query('SELECT instructions FROM channel_instructions WHERE channel_id = $1', [channelId]);
            instructions = result.rows[0]?.instructions || '';
        }

        if (!instructions && !channelId) {
             const result = await pool.query('SELECT value FROM config WHERE key = $1', ['system_instructions']);
             instructions = result.rows[0]?.value || '';
        }

        res.json({ instructions });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

app.post('/api/config/instructions', authenticateToken, async (req, res) => {
    try {
        const { instructions, channelId } = req.body;

        
        if (channelId) {
            if (instructions) {
                await pool.query(
                    'INSERT INTO channel_instructions (channel_id, instructions) VALUES ($1, $2) ON CONFLICT (channel_id) DO UPDATE SET instructions = EXCLUDED.instructions',
                    [channelId, instructions]
                );
            } else {
                 await pool.query('DELETE FROM channel_instructions WHERE channel_id = $1', [channelId]);
            }
        } else {
            await pool.query(
                'INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
                ['system_instructions', instructions]
            );
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// 2. Allowed Channels
app.get('/api/channels', authenticateToken, async (req, res) => {
    try {
        const results = await pool.query('SELECT channel_id FROM allowed_channels');

        const channels = results.rows.map(r => r.channel_id);
        
        const channelsWithNames = await Promise.all(channels.map(async (id) => {
            let name = 'Unknown Channel';
            if (discordRest) {
                try {
                    const channel = await discordRest.get(Routes.channel(id)) as any;
                    name = channel.name || name;
                } catch (e) {
                    console.warn(`Could not fetch channel ${id}`, e);
                }
            }
            return { id, name };
        }));

        res.json({ channels: channelsWithNames });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

app.post('/api/channels', authenticateToken, async (req, res) => {
    try {
        const { channelId } = req.body;

        if (!channelId) throw new Error('Channel ID required');
        
        if (discordRest) {
             try {
                 await discordRest.get(Routes.channel(channelId));
             } catch (e) {
                 // Warn or fail?
             }
        }

        await pool.query('INSERT INTO allowed_channels (channel_id) VALUES ($1) ON CONFLICT (channel_id) DO NOTHING', [channelId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

app.delete('/api/channels/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        await pool.query('DELETE FROM allowed_channels WHERE channel_id = $1', [id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// 3. Memory
app.get('/api/memory/:channelId', authenticateToken, async (req, res) => {
    try {
        const { channelId } = req.params;

        const result = await pool.query('SELECT summary FROM channel_memory WHERE channel_id = $1', [channelId]);
        res.json({ summary: result.rows[0]?.summary || '' });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

app.delete('/api/memory/:channelId', authenticateToken, async (req, res) => {
    try {
        const { channelId } = req.params;

        await pool.query('DELETE FROM channel_memory WHERE channel_id = $1', [channelId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// 4. Knowledge / Upload
app.post('/api/upload', authenticateToken, upload.single('file'), async (req, res) => {
    /* 
       Basic implementation:

       1. Read PDF text
       2. Store in DB (Future: Vector DB)
    */
    try {
        if (!req.file) throw new Error('No file uploaded');
        
        const dataBuffer = fs.readFileSync(req.file.path);
        const data = await pdf(dataBuffer);
        
        await pool.query(
            'INSERT INTO knowledge_base (filename, content, upload_date) VALUES ($1, $2, $3)',
            [req.file.originalname, data.text, Date.now()]
        );

        // Cleanup temp file
        fs.unlinkSync(req.file.path);

        res.json({ success: true, textLength: data.text.length });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: (error as Error).message });
    }
});

app.get('/api/knowledge', authenticateToken, async (req, res) => {
    try {
        const results = await pool.query('SELECT id, filename, upload_date FROM knowledge_base ORDER BY upload_date DESC');

        res.json({ files: results.rows });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

app.delete('/api/knowledge/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        await pool.query('DELETE FROM knowledge_base WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

app.listen(port, () => {
    console.log(`Admin dashboard running at http://localhost:${port}`);
});

