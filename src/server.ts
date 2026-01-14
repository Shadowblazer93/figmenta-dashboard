import express from 'express';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import cors from 'cors';
import pdf from 'pdf-parse';
import dotenv from 'dotenv';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Load env from root
dotenv.config({ path: path.join(__dirname, '../.env') });

const app = express();
const port = 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key-change-this';

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

if (!supabaseUrl || !supabaseKey) {
    console.warn('SUPABASE_URL or SUPABASE_KEY/SUPABASE_SERVICE_ROLE_KEY missing. Database operations will fail.');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Middleware
app.use(cors());
app.use(express.json());
// Serve static files from 'public' (which might be empty now, but ready for frontend)
app.use(express.static(path.join(__dirname, 'public')));


// Database setup (pg removed)

// Discord REST Client
const discordToken = process.env.DISCORD_TOKEN;
let discordRest: REST | null = null;
if (discordToken) {
    discordRest = new REST({ version: '10' }).setToken(discordToken);
    console.log('Discord REST client initialized');
} else {
    console.warn('DISCORD_TOKEN not found in environment variables. Channel name resolution will not work.');
}

// Ensure tables exist - Skipped for Vercel/Supabase JS (Use SQL Editor)
/*
async function initTables() {
    // ... use Supabase Dashboard SQL Editor to create tables
}
*/

// Upload setup
const upload = multer({ storage: multer.memoryStorage() });

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
        const { data: user, error: dbError } = await supabase
            .from('users')
            .select('*')
            .eq('email', email)
            .single();

        if (dbError || !user) {
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
            const { data } = await supabase
                .from('channel_instructions')
                .select('instructions')
                .eq('channel_id', channelId)
                .single();
            instructions = data?.instructions || '';
        }

        if (!instructions && !channelId) {
             const { data } = await supabase
                .from('config')
                .select('value')
                .eq('key', 'system_instructions')
                .single();
             instructions = data?.value || '';
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
                await supabase
                    .from('channel_instructions')
                    .upsert({ channel_id: channelId, instructions });
            } else {
                 await supabase
                    .from('channel_instructions')
                    .delete()
                    .eq('channel_id', channelId);
            }
        } else {
            await supabase
                .from('config')
                .upsert({ key: 'system_instructions', value: instructions });
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// 2. Allowed Channels
app.get('/api/channels', authenticateToken, async (req, res) => {
    try {
        const { data } = await supabase
            .from('allowed_channels')
            .select('channel_id');

        const channels = (data || []).map((r: any) => r.channel_id);
        
        const channelsWithNames = await Promise.all(channels.map(async (id: string) => {
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

        await supabase
            .from('allowed_channels')
            .upsert({ channel_id: channelId }); // on conflict do nothing semantics tricky with upsert but ok for this simple case or ignoreDuplicates
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

app.delete('/api/channels/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        await supabase.from('allowed_channels').delete().eq('channel_id', id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// 3. Memory
app.get('/api/memory/:channelId', authenticateToken, async (req, res) => {
    try {
        const { channelId } = req.params;

        const { data } = await supabase
            .from('channel_memory')
            .select('summary')
            .eq('channel_id', channelId)
            .single();

        res.json({ summary: data?.summary || '' });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

app.delete('/api/memory/:channelId', authenticateToken, async (req, res) => {
    try {
        const { channelId } = req.params;

        await supabase.from('channel_memory').delete().eq('channel_id', channelId);
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
        
        const dataBuffer = req.file.buffer;
        const data = await pdf(dataBuffer);
        
        // Using Supabase client to insert extracted text content
        const { error } = await supabase
            .from('knowledge_base')
            .insert({
                filename: req.file.originalname,
                content: data.text,
                upload_date: Date.now()
            });

        if (error) throw new Error(error.message);

        res.json({ success: true, textLength: data.text.length });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: (error as Error).message });
    }
});

app.get('/api/knowledge', authenticateToken, async (req, res) => {
    try {
        const { data } = await supabase
            .from('knowledge_base')
            .select('id, filename, upload_date')
            .order('upload_date', { ascending: false });

        res.json({ files: data || [] });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

app.delete('/api/knowledge/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        await supabase.from('knowledge_base').delete().eq('id', id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// For Vercel, we need to export the app
export default app;

// Only listen if running locally (not imported as a module)
if (require.main === module) {
    app.listen(port, () => {
        console.log(`Admin dashboard running at http://localhost:${port}`);
    });
}

