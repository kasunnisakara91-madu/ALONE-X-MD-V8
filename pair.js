sconst express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const { MongoClient } = require('mongodb'); // MongoDB Driver

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent
} = require('dct-dula-baileys');

//  URL එකට ඔයාගේ MongoDB connection string එක දාන්න
const MONGO_URL = "mongodb+srv://dct-dula:dct-ninja-x-md@dctninja.gxfynay.mongodb.net/?appName=dctninja"; 
const mongoClient = new MongoClient(MONGO_URL);
let db;

async function connectToMongo() {
    try {
        await mongoClient.connect();
        db = mongoClient.db("whatsapp_bot_db"); // Database Name
        console.log("✅ MongoDB Connected Successfully!");
        
        
        setTimeout(autoReconnectFromDB, 5000);
    } catch (error) {
        console.error("❌ MongoDB Connection Error:", error);
    }
}
connectToMongo();

// ============================================
// ⚙️ CONFIGURATIONS
// ============================================

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: =  [
  '💖', '🩷', '💘', '💝', '💗', '💕', '💞', '🌸', '🎀', '🧸',
  '🐰', '🦋', '🩵', '🍓', '🧁', '🌷', '☁️', '🌈', '🍒', '🐝',
  '💫', '⭐', '🫶', '🦄', '🐥', '💐', '🪩', '🕊️', '💟', '🩰',
  '✨', '🎈', '🧃', '🐇', '🥹', '🌼', '🪻', '🫧', '🌹', '🦢'
],
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/I7eReF73VGu4EU9kF9w4uS?s',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: 'https://i.ibb.co/MyTyqgSW/dda37bc8f3e6.jpg',
    NEWSLETTER_JID: '120363423916773660@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,    
    OWNER_NUMBER: '94783731694',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029Vb7p3UCCHDyocfEGm23f'
};

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

// ============================================
// 🛠️ HELPER FUNCTIONS
// ============================================

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

async function restoreSessionFromDB(number, sessionPath) {
    try {
        if (!db) return false;
        const result = await db.collection('sessions').findOne({ id: number });
        if (result && result.creds) {
            fs.ensureDirSync(sessionPath);
            fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(result.creds, null, 2));
            return true;
        }
        return false;
    } catch (error) {
        console.error("Error restoring session:", error);
        return false;
    }
}

// 2. Session එක Mongo වලට
async function saveSessionToDB(number, sessionPath) {
    try {
        if (!db) return;
        const credsPath = path.join(sessionPath, 'creds.json');
        if (fs.existsSync(credsPath)) {
            const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
            await db.collection('sessions').updateOne(
                { id: number },
                { $set: { creds: creds, updatedAt: new Date() } },
                { upsert: true }
            );
        }
    } catch (error) {
        console.error("Error saving session to DB:", error);
    }
}

// 3. User Config එක DB එකෙන් ගන්න
async function loadUserConfig(number) {
    try {
        if (!db) return { ...config };
        const result = await db.collection('user_configs').findOne({ id: number });
        return result && result.config ? result.config : { ...config };
    } catch (error) {
        return { ...config };
    }
}

// 4. Config Update කරන්න
async function updateUserConfig(number, newConfig) {
    if (!db) return;
    await db.collection('user_configs').updateOne(
        { id: number },
        { $set: { config: newConfig } },
        { upsert: true }
    );
}


async function addActiveNumber(number) {
    if (!db) return;
    await db.collection('active_numbers').updateOne(
        { id: number },
        { $set: { status: 'active', connectedAt: new Date() } },
        { upsert: true }
    );
}


async function deleteDataFromDB(number) {
    if (!db) return;
    await db.collection('sessions').deleteOne({ id: number });
    await db.collection('active_numbers').deleteOne({ id: number });
    await db.collection('user_configs').deleteOne({ id: number });
}


async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) return { status: 'failed', error: 'Invalid group invite link' };
    const inviteCode = inviteCodeMatch[1];

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            return response?.gid ? { status: 'success', gid: response.gid } : { status: 'failed' };
        } catch (error) {
            retries--;
            await delay(2000);
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}
async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
        ? `Joined (ID: ${groupResult.gid})`
        : `Failed to join group: ${groupResult.error}`;
    const caption = formatMessage(
        '🧚‍♂️ALONE-X-MD 𝐌ɪɴɪ 𝐁ᴏᴛ🧚‍♂️',
        `📞 Number: ${number}\n🩵 Status: Connected`,
        '> 𝐏ᴏᴡᴇʀᴅ 𝐁ʏ ALONE-X-MD  ❗'
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
    for (const admin of admins) {
        try {
            await socket.sendMessage(`${admin}@s.whatsapp.net`, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage('Bot Connected', `Number: ${number}`, 'Powered By Riko')
            });
        } catch (e) {}
    }
}

// ... (Other helper functions like sendOTP, updateAboutStatus, etc. remain the same)
// I am keeping the logic concise to fit. Use your previous helper functions here.

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
   const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        '𝙰𝙻𝙾𝙽𝙴-𝚇-𝙼𝙳 𝙼𝙸𝙽𝙸 𝙱𝙾𝚃'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}
    
async function updateAboutStatus(socket) {
    const aboutStatus = 'ALONE-X-MD ᴍɪɴɪ ʙᴏᴛ ᴠ8 //  ᴀᴄᴛɪᴠᴇ 🚀';
    try {
        await socket.updateProfileStatus(aboutStatus);
        console.log(`Updated About status to: ${aboutStatus}`);
    } catch (error) {
        console.error('Failed to update About status:', error);
    }
}

async function updateStoryStatus(socket) {
    const statusMessage = `ALONE-X-MD ᴍɪɴɪ ʙᴏᴛ ᴠ8 ᴄᴏɴɴᴇᴄᴛᴇᴅ..! 🚀\nConnected at: ${getSriLankaTimestamp()}`;
    try {
        await socket.sendMessage('status@broadcast', { text: statusMessage });
        console.log(`Posted story status: ${statusMessage}`);
    } catch (error) {
        console.error('Failed to post story status:', error);
    }
}
            
function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== config.NEWSLETTER_JID) return;
        try {
            const emojis = [
    '💖', '❤️', '🩵', '💙', '💜', '💚', '🧡', '🤍', '🤎',
    '✨', '🔥', '🌸', '🌹', '💫', '⭐', '💎', '🎉', '😇',
     '😊', '🥰', '😍', '🤩', '😎', '💪', '🙌', '🙏', '😉'
     ],
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No valid newsletterServerId found:', message);
                return;
            }

            let retries = config.MAX_RETRIES;
            while (retries > 0) {
                try {
                    await socket.newsletterReactMessage(
                        config.NEWSLETTER_JID,
                        messageId.toString(),
                        randomEmoji
                    );
                    console.log(`Reacted to newsletter message ${messageId} with ${randomEmoji}`);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to react to newsletter message ${messageId}, retries left: ${retries}`, error.message);
                    if (retries === 0) throw error;
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
        } catch (error) {
            console.error('Newsletter reaction error:', error);
        }
    });
}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        
        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n🧚‍♂️ From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            '> 𝐏ᴏᴡᴇʀᴅ 𝐁ʏ ALONE-X-MD ❗'
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        let command = null;
        let args = [];
        let sender = msg.key.remoteJid;

        if (msg.message.conversation || msg.message.extendedTextMessage?.text) {
            const text = (msg.message.conversation || msg.message.extendedTextMessage.text || '').trim();
            if (text.startsWith(config.PREFIX)) {
                const parts = text.slice(config.PREFIX.length).trim().split(/\s+/);
                command = parts[0].toLowerCase();
                args = parts.slice(1);
            }
        }
        else if (msg.message.buttonsResponseMessage) {
            const buttonId = msg.message.buttonsResponseMessage.selectedButtonId;
            if (buttonId && buttonId.startsWith(config.PREFIX)) {
                const parts = buttonId.slice(config.PREFIX.length).trim().split(/\s+/);
                command = parts[0].toLowerCase();
                args = parts.slice(1);
            }
    }
//=======================================
async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
    ? `✅ Joined Successfully`
    : `❌ Failed to Join Group\n> ${groupResult.error}`;

const caption = formatMessage(
 `*╭─❏◦•◦•◦•◦•◦•◦❏─╮*
*💗╎* ✨ \`ㅤ𝑺𝑬𝑺𝑺𝑰𝑶𝑵 𝑺𝑻𝑨𝑹𝑻𝑬𝑫ㅤ\` ✨
*💗╎ ⭑ BOT:* 𝙰𝙻𝙾𝙽𝙴-𝚇-𝙼𝙳 ᴍɪɴɪ ʙᴏᴛ ᴠ8 💫
*💗╎ ⭑ STATUS:* ᴄᴏɴɴᴇᴄᴛᴇᴅ ✅
*💗╎ ⭑ NUMBER:* ${number}
*💗╎ ⭑ MODE:* ᴏɴʟɪɴᴇ 🩵
*💗╎ ⭑ GROUP:* ${groupStatus}
*💗╎ ⭑ HOSTING:* ʜᴇʀᴏᴋᴜ ☁️
  *╰─❏◦•◦•◦•◦•◦•◦❏─╯*

  *╭─❏◦•◦•◦•◦•◦•◦❏─╮*
*💗╎* 💖 \`ㅤ𝑰𝑵𝑭𝑶 𝑳𝑶𝑮ㅤ\` 💖
*💗╎ ⭑ SESSION:* ᴀᴄᴛɪᴠᴇ 🔥
*💗╎ ⭑ SECURITY:* ꜱᴀꜰᴇ & ᴠᴇʀɪꜰɪᴇᴅ 🛡️
*💗╎ ⭑ FOOTER:* © 𝙰𝙻𝙾𝙽𝙴 𝙱𝙾𝚈 ᴍɪɴɪ${config.BOT_FOOTER}
  *╰─❏◦•◦•◦•◦•◦•◦❏─╯*

> ᴍᴏꜱᴛ ᴄᴏᴍᴍᴀɴᴅ ꜱᴜᴘᴘᴏʀᴛ ᴏɴʟʏ ᴏɴᴇ ʙᴏᴛ 𝙰𝙻𝙾𝙽𝙴-𝚇-𝙼𝙳 ᴍɪɴɪ ʙᴏᴛ ᴠ8
> ᴏɴᴇ ᴠɪᴇᴡ ɪᴍᴀɢᴇ ɢᴇᴛ ɪɴʙᴏx ᴜꜱᴇ .ɴɪᴄᴇ ᴄᴏᴍᴍɴᴅ

  *╭─❏◦•◦•◦•◦•◦•◦❏─╮*
*💗╎* ⚙️ \`ㅤ𝑷𝑶𝑾𝑬𝑹𝑬𝑫 𝑩𝒀 𝘈𝘓𝘖𝘕𝘌-𝘟-𝘔𝘋ㅤ\` ⚙️
*💗╎ ⭑ 𝙰𝙻𝙾𝙽𝙴-𝚇-𝙼𝙳 ᴍɪɴɪ ʙᴏᴛ ᴠ8 ꜱʏꜱᴛᴇᴍ ⚡*
  *╰─❏◦•◦•◦•◦•◦•◦❏─╯*`
);

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: "https://i.ibb.co/MyTyqgSW/dda37bc8f3e6.jpg" },
                    caption
                }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}
//=======================================
        
       if (!command) return;

        try {
            switch (command) {
                case 'alive':
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const channelStatus = config.NEWSLETTER_JID ? '✅ Followed' : '❌ Not followed';
    
    const botInfo = `
╭─── 〘-𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝐌ɪɴɪ 𝐁ᴏᴛ-〙 ───
│   🌐 Version: 𝐯8
│
╭─── 〘 📊 SESSION INFO 〙 ───
│
│   ⏳ Uptime: ${hours}h ${minutes}m ${seconds}s
│   🟢 Active Sessions: ${activeSockets.size}
│   📞 Your Number: ${number}
│   📢 Channel: ${channelStatus}
│
╭─── 〘 🛠️ COMMANDS 〙 ───────
│
│   🎶 ${config.PREFIX}menu      - Watch all command
│   🗑️ ${config.PREFIX}deleteme  - Delete session
│   💬 ${config.PREFIX}ping      - Bot life testing
│   📰 ${config.PREFIX}status    - Latest updates
│   📈 ${config.PREFIX}owner     - Bot developed
│   ⏱️ ${config.PREFIX}runtime   - Total runtime
│   🏓 ${config.PREFIX}latency   - Ping test
│
╭─── 〘 🌐 𝐖𝐄𝐁 〙 ──────────
│
>❗𝐂𝐎𝐌𝐌𝐈𝐍𝐆 𝐒𝐎𝐎𝐍-
│
╰───────────────────────
> *🐇🌺𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝐌ɪɴɪ 𝐁ᴏᴛ 𝐕8 𝐀ʟɪᴠᴇ🌺🐇*
    `.trim();

    await socket.sendMessage(sender, {
        image: { url: config.RCD_IMAGE_PATH },
        caption: formatMessage(
            '🧚‍♂️𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝐌ɪɴɪ 𝐁ᴏᴛ🧚‍♂️',
            botInfo,
            '🧚‍♂️𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝐌ɪɴɪ 𝐁ᴏᴛ🧚‍♂️'
        ),
        contextInfo: {
            mentionedJid: ['94783731694@s.whatsapp.net'],
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363423916773660@newsletter',
                newsletterName: '𝐀𝐥𝐨𝐧𝐞-𝐗-𝐌𝐃 𝐌ɪɴɪ 𝐁ᴏᴛ🪻',
                serverMessageId: 143
            }
        },
        buttons: [
            { buttonId: `${config.PREFIX}dev`, buttonText: { displayText: '🥺🐇 ʙᴏᴛ ɪɴꜰᴏ 🥺🐇' }, type: 1 },
            { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: '🥺🐇 ᴛᴇꜱᴛ ʙᴏᴛ ᴀʟɪᴠᴇ 🥺🐇' }, type: 1 },
            { buttonId: `${config.PREFIX}donate`, buttonText: { displayText: '🥺🐇 ᴅᴏɴᴀᴛᴇ ʙᴏᴛ ᴏᴡɴᴇʀꜱ 🥺🐇' }, type: 1 }            
        ],
        headerType: 4
    }, { quoted: msg });

    await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });
    break;
            }            
                
        contextInfo: {
            mentionedJid: ['94783731694@s.whatsapp.net'],
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363423916773660@newsletter',
                newsletterName: '🧚‍♂️𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝐌ɪɴɪ 𝐁ᴏᴛ🧚‍♂️',
                serverMessageId: 143
            }
            
 switch (command) {
        
case 'menu':
    await socket.sendMessage(sender, {
        image: '{ https://i.ibb.co/MyTyqgSW/dda37bc8f3e6.jpg }',
        caption: formatMessage(
            '⛩️ 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐕8 𝐌𝐄𝐍𝐔 🪻',
            `*➤ Available Commands..!! 🌐💭*\n\n┏━━━━━━━━━━━ ◉◉➢
┋ • *BOT INFO*
┋ ⛩️ Name: ALONE-X-MD MINI BOT V8
┋ 🌐 Version: 2.0.0v
┋ 👨‍💻 Owner: MADUSANKA
┋ 🌥️ Host: Heroku
┋ 📞 Your Number: ${number}
┋
┋ *Total Commands: 26+* (More coming soon!)
┗━━━━━━━━━━━ ◉◉➢\n
┏━━━━━━━━━━━ ◉◉➢
┇ *${config.PREFIX}alive*
┋ • Show bot status
┋
┋ *${config.PREFIX}Song*
┋ • Download Songs
┋
┋ *${config.PREFIX}tiktok*
┋ • Download tiktok video
┋
┋ *${config.PREFIX}fb*
┋ • Download facebook video
┋
┋ *${config.PREFIX}ai*
┋ • New Ai Chat
┋
┋ *${config.PREFIX}news*
┋ • View latest news update
┋
┋ *${config.PREFIX}gossip*
┋ • View gossip news update
┋
┋ *${config.PREFIX}cricket*
┇ • Cricket news updates
┇
┇ *${config.PREFIX}deleteme*
┇ • Delete your session
┋
┋ *${config.PREFIX}status*
┋ • Check bot status
┋
┋ *${config.PREFIX}boom*
┋ • Boom effect
┋
┋ *${config.PREFIX}system*
┋ • View system info
┋
┋ *${config.PREFIX}weather*
┋ • Check weather
┋
┋ *${config.PREFIX}jid*
┋ • Get JID of user/chat
┋
┋ *${config.PREFIX}ping*
┋ • Check bot ping
┋
┋ *${config.PREFIX}google*
┋ • Google search
┋
┋ *${config.PREFIX}video*
┋ • Download videos
┋
┋ *${config.PREFIX}runtime*
┋ • Bot uptime info
┋
┋ *${config.PREFIX}dinu*
┋ • Dinu info
┋
┋ *${config.PREFIX}rukshan*
┋ • Rukshan info
┋
┋ *${config.PREFIX}getdp*
┋ • Get user profile picture
┋
┋ *${config.PREFIX}repo*
┋ • Bot repo link
┋
┋ *${config.PREFIX}openai*
┋ • OpenAI features
┋
┋ *${config.PREFIX}silumina*
┋ • Silumina news
┋
┋ *${config.PREFIX}owner*
┋ • Contact bot owner
┋
┋ *${config.PREFIX}now*
┋ • Show current time & date
┋
┗━━━━━━━━━━━ ◉◉➣\n
*⚠️ Note: More commands coming soon! Stay tuned! ⚠️*`,
 '𝘈𝘓𝘖𝘕𝘌-𝘟-𝘔𝘋 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛 𝘝8',
'> *🐇🌺𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝐌ɪɴɪ 𝐁ᴏᴛ 𝐕8 𝐌ᴇɴᴜ🌺🐇*'
    
            },
        buttons: [
            { buttonId: `${config.PREFIX}dev`, buttonText: { displayText: '🐇🥺 ʙᴏᴛ ɪɴꜰᴏ 🥺🐇' }, type: 1 },
            { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: '🐇🥺 ᴛᴇꜱᴛ ʙᴏᴛ ᴀʟɪᴠᴇ 🥺🐇' }, type: 1 },
            { buttonId: `${config.PREFIX}donate`, buttonText: { displayText: '🐇🥺 ᴅᴏɴᴀᴛᴇ ʙᴏᴛ ᴏᴡɴᴇʀꜱ 🥺🐇' }, type: 1 }            
        ],
        headerType: 4
    }, { quoted: msg });

    await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });
    break;
        }
if (!command) return;

        try {
            switch (command) {
            
case 'madu': {
  try {
    const desc = `
ABOUT ME – 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃

Name: 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃
Alias: 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃
Age: 18+
Location: Negombo , Sri Lanka
Languages: Sinhala, English, Currently Learning Japanese
Profession: Creative Technologist, Bot Developer, Digital Designer, logo disaing
Team: Blood corderift zone team
Dream Destinations: Japan & South Korea
Life Goal: Build a powerful future through tech and business — create Sri Lanka’s largest pawnshop network and the biggest vehicle yard, while giving my mother the life she deserves.

---

WHO I AM

I’m not just another face in the crowd — I’m CYBAR 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃, a self-made digital warrior. Born in the shadows of struggle, but trained in the light of purpose. I live not to follow trends, but to create legacies. I’ve made a vow: To rise, no matter how deep the fall.

---

WHAT I DO

Web Development:
I craft and code with HTML & JavaScript — from building websites to creating powerful panels and bot interfaces.

Bot Creator & DevOps:
I’m the mind behind 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 — a multi-functional WhatsApp bot featuring custom commands, automation, and system control. From .news to .apk, my bot does it all.

Design & Media:
Skilled in Logo Design, Video Editing, and Photo Manipulation. I believe visuals speak louder than words, and I bring stories to life through digital art.

Tech & AI Enthusiast:
I explore AI tools, automation systems, and even ethical hacking. I stay updated, learn fast, and adapt faster.

Purpose-Driven Learning:
Currently studying Japanese to prepare for my next journey — either to Japan or South Korea, where I plan to expand both my knowledge and my empire.

---

MY PHILOSOPHY

> “When the world turns dark, I don’t hide — I evolve. I am not afraid to walk alone in the shadows. I am the shadow. I am CYBAR LOKU RIKO.”

====================••••••••==========

*මමත් ආසයි...🙂*

*හැමදේම කියන්න කෙනෙක් හිටියා නම්,*
*හැමවෙලේම මැසේජ් කරන්න,*
*කරදර කර කර හොයල බලන්න කෙනෙක් හිටියා නම්,*
*පරිස්සමෙන් ඉන්න මේ දවස් වල*
*මට ඉන්නෙ ඔයා විතරනෙ කියන්න කෙනෙක් හිටියා නම්,*
*මට දැනෙන තරම් මාව දැනෙන කෙනෙක් හිටියා නම්,*

*ඔව් ආදරේ කියන්නෙ*
*පරිස්සම් කරන එකට තමයි,*
*පරිස්සම් කරන්නෙ ආදරේ හින්දා තමයි,*

*ඉතින් ආදරේ කියන්නෙම පරිස්සම් කරන එකට තමයි...!❤‍🩹🥺*

*ස්තූතිය....!*

> ㋛︎ 𝐏ᴏᴡᴇʀᴅ 𝐁ʏ 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 
> ® 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝐌ɪɴɪ 𝐁ᴏᴛ ᴠ8 ⛩️
`;

    const imageUrl = 'https://i.ibb.co/MyTyqgSW/dda37bc8f3e6.jpg';

    await socket.sendMessage(sender, {
      image: { url: imageUrl },
      caption: desc
    }, { quoted: msg });

  } catch (e) {
    console.error("Riko Command Error:", e);
    await socket.sendMessage(sender, { text: `❌ Error: ${e.message || e}` }, { quoted: msg });
  }
  break;
}  

 switch (command) {      
        
    case 'dula': {
  try {
    const desc = `

❰▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬❱

⛩️ ABOUT – The Future Owner of MADUSANKA  
⛩️ 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃  𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐕8

A young soul from Wellimada, just 18 years old, but already steps ahead in the world of Artificial Intelligence.  
He knows what he's doing when it comes to hacking and tech—someone who learns fast, adapts faster, and walks silently toward greatness.

"I like people…"

Who never get tired of listening,  
Who keep checking in just to see if you're okay,  
Who are there, even when words aren’t enough,  
Who remind you you’re not alone,  
Who feel your silence more than your words…

loku riko He’s that kind of person.  
The type who doesn't just understand code, but understands people.  
He’s the quiet force behind the screen—thoughtful, loyal, and real. isn’t just a group—it’s a movement.  
And he’s not just part of it—  
He’s the next one to lead it.

> ㋛︎ 𝐏ᴏᴡᴇʀᴅ 𝐁ʏ 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 
> ® 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝐌ɪɴɪ 𝐁ᴏᴛ ᴠ8 🐇♥️
`;

    const imageUrl = 'https://i.ibb.co/MyTyqgSW/dda37bc8f3e6.jpg';

    await socket.sendMessage(sender, {
      image: { url: imageUrl },
      caption: desc
    }, { quoted: msg });

  } catch (e) {
    console.error("sithuwa Command Error:",
    await socket.sendMessage(sender, {
      text: `❌ Error: ${e.message || e}`
    }, { quoted: msg });
  }
  break;
    }
         case 'system':
    await socket.sendMessage(sender, {
        image: { url: config.RCD_IMAGE_PATH },
        caption:
            `┏━━【 ✨ BOT STATUS DASHBOARD 】━━◉\n` +
            `┃\n` +
            `┣ 🏓 *PING:* PONG!\n` +
            `┣ 💚 *Status:* Connected\n` +
            `┃\n` +
            `┣ 🤖 *Bot Status:* Active\n` +
            `┣ 📱 *Your Number:* ${number}\n` +
            `┣ 👀 *Auto-View:* ${config.AUTO_VIEW_STATUS}\n` +
            `┣ ❤️ *Auto-Like:* ${config.AUTO_LIKE_STATUS}\n` +
            `┣ ⏺ *Auto-Recording:* ${config.AUTO_RECORDING}\n` +
            `┃\n` +
            `┣ 🔗 *Our Channels:*\n` +
            `┃     📱 WhatsApp: https://whatsapp.com/channel/0029VbBnQJYJJhzOvWQDwC0u\n` +
            `┃\n` +
            `┗━━━━━━━【𝐏ᴏᴡᴇʀᴅ 𝐁ʏ 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃】━━━━━━◉`
    });
    break;
            case 'fc': {
    if (args.length === 0) {
        return await socket.sendMessage(sender, {
            text: '❗ Please provide a channel JID.\n\nExample:\n.fcn 120363423916773660@newsletter'
        });
    }

    const jid = args[0];
    if (!jid.endsWith("@newsletter")) {
        return await socket.sendMessage(sender, {
            text: '❗ Invalid JID. Please provide a JID ending with `@newsletter`'
        });
    }

    try {
        const metadata = await socket.newsletterMetadata("jid", jid);
        if (metadata?.viewer_metadata === null) {
            await socket.newsletterFollow(jid);
            await socket.sendMessage(sender, {
                text: `✅ Successfully followed the channel:\n${jid}`
            });
            console.log(`FOLLOWED CHANNEL: ${jid}`);
        } else {
            await socket.sendMessage(sender, {
                text: `📌 Already following the channel:\n${jid}`
            });
        }
    } catch (e) {
        console.error('❌ Error in follow channel:', e.message);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${e.message}`
      });
   }
           break;
            }

switch (command) {
     
     case 'repo':
    try {
        let teksnya = `𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 MINI BOT V2 REPO`;

        let imageUrl = config.RCD_IMAGE_PATH;

        let vpsOptions = [
            { title: "🐇🥺 ᴍᴇɴᴜ ʟɪꜱᴛ ᴄᴏᴍᴍᴀɴᴅ 🥺🐇", description: "🐇🥺 alone ᴍɪɴɪ ʙʏ 𝚖𝚊𝚍𝚞𝚠𝚊 🥺🐇", id: `${config.PREFIX}menu` },
            { title: "🐇🥺 ᴘɪɴɢ ᴄᴏᴍᴍᴀɴᴅ 🥺🐇", description: "🐇🥺 𝚊𝚕𝚘𝚗𝚎-𝚡-𝚖𝚍 ᴍɪɴɪ ʙʏ ꜱɪᴛʜᴜᴡᴀ 🥺🐇", id: `${config.PREFIX}ping` }
        ];

        let buttonSections = [
            {
                title: "𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 MINI BOT V8 COMMAND",
                highlight_label: "𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 MINI BOT V8",
                rows: vpsOptions
            }
        ];

        let buttons = [
            {
                buttonId: "action",
                buttonText: { displayText: "Select Menu" },
                type: 4,
                nativeFlowInfo: {
                    name: "single_select",
                    paramsJson: JSON.stringify({
                        title: "Choose Menu Tab 📖",
                        sections: buttonSections
                    })
                }
            }
        ];

        await socket.sendMessage(sender, {
            buttons,
            headerType: 1,
            viewOnce: true,
            caption: teksnya,
            image: { url: imageUrl },
            contextInfo: {
                mentionedJid: [sender], 
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterName: `𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ ᴠ8 ʙʏ 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃`,
                    serverMessageId: 143
                }
            }
        }, { quoted: msg }); // Changed from 'mek' to 'msg'

    } catch (error) {
        console.error(`Error in 'repo' case: ${error.message}`);
        await socket.sendMessage(sender, {
            text: `❌ Menu Error: ${error.message}`
        });
    }
    break;
    }

switch (command) {
         
    case 'owner':
    await socket.sendMessage(sender, {
        image: { url: config.RCD_IMAGE_PATH },
        caption: formatMessage(
            '👑 OWNER DETAILS',
            `╭━━〔 *𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃* 〕━━┈⊷
┃◈╭─────────────·๏
┃◈┃• *Owner𝚂 Name*: 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 
┃◈┃• *Contact Number*: +94787940686/94783731694
┃◈└───────────┈⊷
╰──────────────┈⊷

> _CHENNEL FOLLOW 🚀_
> _ALL COMMAND WORKING 🚀_
> _WHATSAPP :- 'https://whatsapp.com/channel/0029Vb7p3UCCHDyocfEGm23f'
> © ᴘᴏᴡᴇʀᴇᴅ ʙʏ 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃`,
            '𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝐌ɪɴɪ 𝐁ᴏᴛ ᴠ8'
        ),
        contextInfo: {
            mentionedJid: ['94787940686@s.whatsapp.net'],
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363423916773660@newsletter',
                newsletterName: '𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝙼𝙸𝙽𝙸 𝙱𝙾𝚃 𝚅8',
                serverMessageId: 143
            }
        }
    });
    break;
        }
         case 'allmenu': {
    await socket.sendMessage(sender, { react: { text: '🇱🇰', key: msg.key } });

    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const caption = 
`*╭╌╌╌╌◯*
*╎* \` 🐼 𝑯𝑬𝑳𝑳𝑶 𝑼𝑺𝑬𝑹 🐼ㅤㅤ\`
*╎🇦🇱⭓ BOT :* 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ ᴍɪɴɪ ᴠ2 ⚡
*╎🇦🇱⭓ TYPE :* 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ
*╎🇦🇱⭓ PLATFORM :* ʜᴇʀᴏᴋᴜ
*╎🇦🇱⭓ STATUS :* ᴏɴʟɪɴᴇ 💫
*╎🇦🇱⭓ UPTIME :* ${hours}h ${minutes}m ${seconds}s
*╰╌┬╌╌◯*
*╭╌┴╌╌◯*
*╎* \` 🐼 𝑩𝑶𝑻 𝑴𝑬𝑵𝑼 🐼ㅤㅤ\`
*╰━━━━━━━━━━━━━━━━━╯

┏━━━━━━━━━━━━━━━━━┓
┃ *🎵 DOWNLOAD MENU*
┣━━━━━━━━━━━━━━━━━┫
┃ 💗✦ ${config.PREFIX}song <name>
┃    └─ Download mp3
┃
┃ 💗✦ ${config.PREFIX}tiktok <url>
┃    └─ TikTok no watermark
┃
┃ 💗✦ ${config.PREFIX}ts
┃    └─ TikTok no found
┃
┃ 💗✦ ${config.PREFIX}fb <url>
┃    └─ Facebook video
┃   
┃ 💗✦ ${config.PREFIX}ig <url>
┃    └─ instagram video
┃
┃ 💗✦ ${config.PREFIX}play
┃    └─ Get Song Youtube
┃
┗━━━━━━━━━━━━━━━━━┛

┏━━━━━━━━━━━━━━━━━┓
┃ *👥 GROUP MENU*
┣━━━━━━━━━━━━━━━━━┫
┃ 💗✦ ${config.PREFIX}kick @user
┃    └─ Remove member
┃
┃ 💗✦ ${config.PREFIX}add 94XXX
┃    └─ Add member
┃
┃ 💗✦ ${config.PREFIX}promote @user
┃    └─ Make admin
┃
┃ 💗✦ ${config.PREFIX}demote @user
┃    └─ Remove admin
┃
┃ 💗✦ ${config.PREFIX}mute / unmute
┃    └─ Group open/close
┃
┃ 💗✦ ${config.PREFIX}tagall <msg>
┃    └─ Tag all members
┃
┃ 💗✦ ${config.PREFIX}hidetag <msg>
┃    └─ Hidden tag
┃
┃ 💗✦ ${config.PREFIX}groupinfo
┃    └─ Group details
┃
┃ 💗✦ ${config.PREFIX}getdp
┃    └─ Get group display picture
┃
┃ 💗✦ ${config.PREFIX}uinfo
┃    └─ Get user info
┃
┃ 💗✦ ${config.PREFIX}left <text>
┃    └─ Left Group
┃
┃ 💗✦ ${config.PREFIX}setname/setdec
┃    └─ Group
┗━━━━━━━━━━━━━━━━━┛

┏━━━━━━━━━━━━━━━━━┓
┃ *✨ OWNER MENU*
┣━━━━━━━━━━━━━━━━━┫
┃ 💗✦ ${config.PREFIX}vv
┃    └─ Unlock oneview
┃
┃ 💗✦ ${config.PREFIX}spam 
┃    └─ Spam number
┃
┃ 💗✦ ${config.PREFIX}getdp
┃    └─ Save Dp
┃
┃ 💗✦ ${config.PREFIX}uinfo
┃    └─ get info numbrr
┃
┃ 💗✦ ${config.PREFIX}getabout
┃    └─ Get user about
┃
┃ 💗✦ ${config.PREFIX}dev
┃    └─ Info Owner
┃
┃ 💗✦ ${config.PREFIX}owner
┃    └─ Contact Owner
┃
┃ 💗✦ ${config.PREFIX}hidetag <msg>
┃    └─ Hidden tag
┃
┃ 💗✦ ${config.PREFIX}groupinfo
┃    └─ Group details
┃
┃ 💗✦ ${config.PREFIX}getdp
┃    └─ Get group display picture
┃
┃ 💗✦ ${config.PREFIX}alldp
┃    └─ get group member all dp
┃
┃ 💗✦ ${config.PREFIX}uinfo
┃    └─ Get user info
┃
┃ 💗✦ ${config.PREFIX}spam <text>
┃    └─ Spam message
│
┃ 💗✦ ${config.PREFIX}send
┃    └─ save statuse
│
┃ 💗✦ ${config.PREFIX}tourl
┃    └─ Get url
┗━━━━━━━━━━━━━━━━━┛

┏━━━━━━━━━━━━━━━━━┓
┃ *🌸 LOGO MENU*
┣━━━━━━━━━━━━━━━━━┫
┃ 💗✦ ${config.PREFIX}3dcomic <text>
┃    └─ 3D Comic Text Style
┃
┃ 💗✦ ${config.PREFIX}blackpink <text>
┃    └─ Pink Aesthetic Font
┃
┃ 💗✦ ${config.PREFIX}neonlight <text>
┃    └─ Bright Neon Glow Effect
┃
┃ 💗✦ ${config.PREFIX}naruto <text>
┃    └─ Anime Inspired Logo
┃
┃ 💗✦ ${config.PREFIX}hacker <text>
┃    └─ Matrix Digital Style
┃
┗━━━━━━━━━━━━━━━━━┛

┏━━━━━━━━━━━━━━━━━┓
┃ *🧠 AI & INFO MENU*
┣━━━━━━━━━━━━━━━━━┫
┃ 💗✦ ${config.PREFIX}gf <Talk With Saduni>
┃    └─ Use AI
┃
┃ 💗✦ ${config.PREFIX}bro <Talk With Neno>
┃    └─ Use AI
┃
┃ 💗✦ ${config.PREFIX}dev
┃    └─ Show bot info
┃
┃ 💗✦ ${config.PREFIX}ping
┃    └─ Check speed
┃
┃ 💗✦ ${config.PREFIX}system
┃    └─ Show CPU & memory
┗━━━━━━━━━━━━━━━━━┛

> ᴄᴏɴᴇᴄᴛ ʙᴏᴛ ʏᴏᴜʀ ɴᴜᴍʙᴇʀ ᴜꜱᴇ .ᴘᴀɪʀ <ɴᴜᴍʙᴇʀ>
> ᴏɴᴇ ᴠɪᴇᴡ ɪᴍᴀɢᴇ ɢᴇᴛ ɪɴʙᴏx ᴜꜱᴇ .ɴɪᴄᴇ ᴄᴏᴍᴍɴᴅ

*𖹭 deploy .ᐟ _𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ ᴠ8 ᴏᴡɴᴇʀꜱ/_*
╰──────────────────────────────╯`;

    const footer = `*© 2026 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ ᴠ2 ⚙️*\n${config.BOT_FOOTER}`;

    await socket.sendMessage(sender, {
        image: { url: 'https://i.ibb.co/MyTyqgSW/dda37bc8f3e6.jpg' },
        caption: caption,
        contextInfo: {
            forwardingScore: 1000,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363423916773660@newsletter',
                newsletterName: 'ALONE-X-MD ᴍɪɴɪ ʙᴏᴛ ᴠ8',
                serverMessageId: 1
            }
        },
        buttons: [
            { buttonId: `${config.PREFIX}dev`, buttonText: { displayText: '💤 ʙᴏᴛ ɪɴꜰᴏ' }, type: 1 },
            { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: '💫 ᴛᴇꜱᴛ ʙᴏᴛ ᴀʟɪᴠᴇ' }, type: 1 },
            { buttonId: `${config.PREFIX}donate`, buttonText: { displayText: '✨ ᴅᴏɴᴀᴛᴇ ʙᴏᴛ ᴏᴡɴᴇʀꜱ' }, type: 1 }            
        ],
        headerType: 4
    }, { quoted: msg });

    await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });
    break;
            }

switch (command) {
         
        case 'runtime': {
    try {
        const startTime = socketCreationTime.get(number) || Date.now();
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        
        // Format time beautifully (e.g., "1h 5m 3s" or "5m 3s" if hours=0)
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = uptime % 60;
        
        let formattedTime = '';
        if (hours > 0) formattedTime += `${hours}h `;
        if (minutes > 0 || hours > 0) formattedTime += `${minutes}m `;
        formattedTime += `${seconds}s`;

        // Get memory usage (optional)
        const memoryUsage = (process.memoryUsage().rss / (1024 * 1024)).toFixed(2) + " MB";

        await socket.sendMessage(sender, {
            image: { url: config.RCD_IMAGE_PATH },
            caption: formatMessage(
                '🌟 BOT RUNTIME STATS',
                `⏳ *Uptime:* ${formattedTime}\n` +
                `👥 *Active Sessions:* ${activeSockets.size}\n` +
                `📱 *Your Number:* ${number}\n` +
                `💾 *Memory Usage:* ${memoryUsage}\n\n` +
                `_𝐏ᴏᴡᴇʀᴅ 𝐁ʏ 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃_`,
                '𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝐌ɪɴɪ 𝐁ᴏᴛ ᴠ8'
            ),
            contextInfo: { forwardingScore: 999, isForwarded: true }
        });
    } catch (error) {
        console.error("❌ Runtime command error:", error);
        await socket.sendMessage(sender, { 
            text: "⚠️ Failed to fetch runtime stats. Please try again later."
        });
    }
    break;
        }
        switch (command) {
            case 'getdp':
            case 'getpp':
            case 'getprofile':
    try {
        if (!args[0]) {
            return await socket.sendMessage(sender, {
                text: "🔥𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 mini bot v8 Please provide a phone number\n\nExample: .getdp 94787940686"
            });
        }

        // Clean the phone number and create JID
        let targetJid = args[0].replace(/[^0-9]/g, "") + "@s.whatsapp.net";

        // Send loading message
        await socket.sendMessage(sender, {
            text: "𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 mini bot v8 🔍 Fetching profile picture..."
        });

        let ppUrl;
        try {
            ppUrl = await socket.profilePictureUrl(targetJid, "image");
        } catch (e) {
            return await socket.sendMessage(sender, {
                text: "𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃𝚗mini bot v8 🖼️ This user has no profile picture or it cannot be accessed!"
            });
        }

        // Get user name
        let userName = targetJid.split("@")[0]; 
        try {
            const contact = await socket.getContact(targetJid);
            userName = contact.notify || contact.vname || contact.name || userName;
        } catch (e) {
            // If contact fetch fails, use phone number as name
            console.log("Could not fetch contact info:", e.message);
        }

        // Send the profile picture
        await socket.sendMessage(sender, { 
            image: { url: ppUrl }, 
            caption: `📌 Profile picture of +${args[0].replace(/[^0-9]/g, "")}\n👤 Name: ${userName}`,
            contextInfo: {
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: '120363423916773660@newsletter',
                    newsletterName: '𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ ᴠ8',
                    serverMessageId: 143
                }
            }
        });

        // React with success emoji
        try {
            await socket.sendMessage(sender, { 
                react: { text: "✅", key: messageInfo.key } 
            });
        } catch (e) {
            console.log("Could not react to message:", e.message);
        }

    } catch (e) {
        console.error('Error in getdp case:', e);
        await socket.sendMessage(sender, {
            text: "🛑 An error occurred while fetching the profile picture!\n\nPlease try again later or check if the phone number is correct."
        });
    }
    break;
        }
        switch (command) {
        case 'channelreact':
        case 'creact':
        case 'chr':
        case 'react':
    try {
        // Get the message object that's available in your scope
        let currentMessage;
        
        // Try to get the message object from available variables
        if (typeof mek !== 'undefined') {
            currentMessage = mek;
        } else if (typeof m !== 'undefined') {
            currentMessage = m;
        } else if (typeof msg !== 'undefined') {
            currentMessage = msg;
        } else if (typeof message !== 'undefined') {
            currentMessage = message;
        } else {
            return await socket.sendMessage(sender, {
                text: "❌ Message object not found. Please try again."
            });
        }
        
        // Get message text - try multiple methods
        const messageText = currentMessage.message?.conversation || 
                           currentMessage.message?.extendedTextMessage?.text || 
                           body || "";
        
        const args = messageText.split(' ');
        const q = args.slice(1).join(' '); 

        if (!q) {
            await socket.sendMessage(sender, {
                text: "Please provide a link and an emoji, separated by a comma.\n\nUsage: .channelreact <channel_link>,<emoji>\n\nExample: .channelreact https://whatsapp.com/channel/0029Vb7p3UCCHDyocfEGm23f,❤️"
            });
            break;
        }

        let [linkPart, emoji] = q.split(",");
        if (!linkPart || !emoji) {
            await socket.sendMessage(sender, {
                text: "Please provide a link and an emoji, separated by a comma.\n\nUsage: .channelreact <channel_link>,<emoji>\n\nExample: .channelreact https://whatsapp.com/channel/0029Vb7p3UCCHDyocfEGm23f,❤️"
            });
            break;
        }

        linkPart = linkPart.trim();
        emoji = emoji.trim();

        // Better URL validation
        if (!linkPart.includes('whatsapp.com/channel/')) {
            await socket.sendMessage(sender, {
                text: "❌ Invalid channel link format. Please provide a valid WhatsApp channel link.\n\nExample: https://whatsapp.com/channel/0029Vb7p3UCCHDyocfEGm23f"
            });
            break;
        }
        switch (command) {
        case 'status':
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '⚙️ STATUS SETTINGS',
                            `⚙️  Auto-View: ${config.AUTO_VIEW_STATUS}\n🏮  Auto-Like: ${config.AUTO_LIKE_STATUS}\n🎥  Auto-Recording: ${config.AUTO_RECORDING}\n🐉 Like Emojis: ${config.AUTO_LIKE_EMOJI.join(', ')}`,
                            '𝙿𝙾𝚆𝙴𝚁𝙴𝙳 𝙱𝚈 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝙼𝙸𝙽𝙸 𝙱𝙾𝚃 𝚅8'
                        )
                    });
             break;
                case 'deleteme':
                    const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                    if (fs.existsSync(sessionPath)) {
                        fs.removeSync(sessionPath);
                    }
                    await deleteSessionFromGitHub(number);
                    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                        activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close();
                        activeSockets.delete(number.replace(/[^0-9]/g, ''));
                        socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                    }
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been successfully deleted.',
                            '𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝘉𝘖𝘛 𝘝8'
                        )
                    });
                    break;
                 }
switch (command) {
        
case 'cfn': {
  const sanitized = (number || '').replace(/[^0-9]/g, '');
  const cfg = await loadUserConfigFromMongo(sanitized) || {};
  const botName = cfg.botName || BOT_NAME_FANCY;
  const logo = cfg.logo || config.RCD_IMAGE_PATH;

  const full = body.slice(config.PREFIX.length + command.length).trim();
  if (!full) {
    await socket.sendMessage(sender, { text: `❗ Provide input: .cfn <jid@newsletter> | emoji1,emoji2\nExample: .cfn 120363423916773660@newsletter | 🔥,❤️` }, { quoted: msg });
    break;
  }

  const admins = await loadAdminsFromMongo();
  const normalizedAdmins = (admins || []).map(a => (a || '').toString());
  const senderIdSimple = (nowsender || '').includes('@') ? nowsender.split('@')[0] : (nowsender || '');
  const isAdmin = normalizedAdmins.includes(nowsender) || normalizedAdmins.includes(senderNumber) || normalizedAdmins.includes(senderIdSimple);
  if (!(isOwner || isAdmin)) {
    await socket.sendMessage(sender, { text: '❌ Permission denied. Only owner or configured admins can add follow channels.' }, { quoted: msg });
    break;
  }

  let jidPart = full;
  let emojisPart = '';
  if (full.includes('|')) {
    const split = full.split('|');
    jidPart = split[0].trim();
    emojisPart = split.slice(1).join('|').trim();
  } else {
    const parts = full.split(/\s+/);
    if (parts.length > 1 && parts[0].includes('@newsletter')) {
      jidPart = parts.shift().trim();
      emojisPart = parts.join(' ').trim();
    } else {
      jidPart = full.trim();
      emojisPart = '';
    }
  }

  const jid = jidPart;
  if (!jid || !jid.endsWith('@newsletter')) {
    await socket.sendMessage(sender, { text: '❗ Invalid JID. Example: 120363423916773660@newsletter' }, { quoted: msg });
    break;
  }

  let emojis = [];
  if (emojisPart) {
    emojis = emojisPart.includes(',') ? emojisPart.split(',').map(e => e.trim()) : emojisPart.split(/\s+/).map(e => e.trim());
    if (emojis.length > 20) emojis = emojis.slice(0, 20);
  }

  try {
    if (typeof socket.newsletterFollow === 'function') {
      await socket.newsletterFollow(jid);
    }

    await addNewsletterToMongo(jid, emojis);

    const emojiText = emojis.length ? emojis.join(' ') : '(default set)';

    // Meta mention for botName
    const metaQuote = {
      key: { remoteJid: "status@broadcast", participant: "0@s.whatsapp.net", fromMe: false, id: "META_AI_CFN" },
      message: { contactMessage: { displayName: botName, vcard: `BEGIN:VCARD\nVERSION:2.0\nN:${botName};;;;\nFN:${botName}\nORG:Meta Platforms\nTEL;type=CELL;type=VOICE;waid=13135550002:+1 313 555 0002\nEND:VCARD` } }
    };

    let imagePayload = String(logo).startsWith('http') ? { url: logo } : fs.readFileSync(logo);

    await socket.sendMessage(sender, {
      image: imagePayload,
      caption: `✅ Channel followed and saved!\n\nJID: ${jid}\nEmojis: ${emojiText}\nSaved by: @${senderIdSimple}`,
      footer: `📌 ${botName} FOLLOW CHANNEL`,
      mentions: [nowsender], // user mention
      buttons: [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "🐇🥺 𝙰𝙻𝙾𝙽𝙴 ᴍᴇɴᴜ 🥺🐇" }, type: 1 }],
      headerType: 4
    }, { quoted: metaQuote }); // <-- botName meta mention

  } catch (e) {
    console.error('cfn error', e);
    await socket.sendMessage(sender, { text: `❌ Failed to save/follow channel: ${e.message || e}` }, { quoted: msg });
  }
  break;
}

switch (command) {        
case 'aiimg': 
case 'aiimg2': {
    const axios = require('axios');

    const q =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption || '';

    const prompt = q.trim();

    if (!prompt) {
        return await socket.sendMessage(sender, {
            text: '🎨 *Please provide a prompt to generate an AI image.*'
        }, { quoted: msg });
    }

    try {
        // 🔹 Load bot name dynamically
        const sanitized = (number || '').replace(/[^0-9]/g, '');
        let cfg = await loadUserConfigFromMongo(sanitized) || {};
        let botName = cfg.botName || 'LOKU RIKO MINI BOT AI';

        // 🔹 Fake contact with dynamic bot name
        const shonux = {
            key: {
                remoteJid: "status@broadcast",
                participant: "0@s.whatsapp.net",
                fromMe: false,
                id: "META_AI_FAKE_ID_AIIMG"
            },
            message: {
                contactMessage: {
                    displayName: botName,
                    vcard: `BEGIN:VCARD
VERSION:2.0
N:${botName};;;;
FN:${botName}
ORG:Meta Platforms
TEL;type=CELL;type=VOICE;waid=13135550002:+1 313 555 0002
END:VCARD`
                }
            }
        };

        // Notify user
        await socket.sendMessage(sender, { text: '🧠 *Creating your AI image...*' });

        // Determine API URL based on command
        let apiUrl = '';
        if (command === 'aiimg') {
            apiUrl = `https://api.siputzx.my.id/api/ai/flux?prompt=${encodeURIComponent(prompt)}`;
        } else if (command === 'aiimg2') {
            apiUrl = `https://api.siputzx.my.id/api/ai/magicstudio?prompt=${encodeURIComponent(prompt)}`;
        }

        // Call AI API
        const response = await axios.get(apiUrl, { responseType: 'arraybuffer' });

        if (!response || !response.data) {
            return await socket.sendMessage(sender, {
                text: '❌ *API did not return a valid image. Please try again later.*'
            }, { quoted: shonux });
        }

        const imageBuffer = Buffer.from(response.data, 'binary');

        // Send AI Image with bot name in caption
        await socket.sendMessage(sender, {
            image: imageBuffer,
            caption: `🧠 *${botName} AI IMAGE*\n\n📌 Prompt: ${prompt}`
        }, { quoted: shonux });

    } catch (err) {
        console.error('AI Image Error:', err);

        await socket.sendMessage(sender, {
            text: `❗ *An error occurred:* ${err.response?.data?.message || err.message || 'Unknown error'}`
        }, { quoted: msg });
    }
    break;
}
switch (command) {
        
case 'xv':
case 'xvsearch':
case 'xvdl': {
    try {
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const query = text.split(" ").slice(1).join(" ").trim();

        // ✅ Load bot name dynamically
        const sanitized = (number || '').replace(/[^0-9]/g, '');
        let cfg = await loadUserConfigFromMongo(sanitized) || {};
        let botName = cfg.botName || 'LOKU RIKO MINI BOT AI';

        // ✅ Fake Meta contact message
        const shonux = {
            key: {
                remoteJid: "status@broadcast",
                participant: "0@s.whatsapp.net",
                fromMe: false,
                id: "META_AI_FAKE_ID_XV"
            },
            message: {
                contactMessage: {
                    displayName: botName,
                    vcard: `BEGIN:VCARD
VERSION:2.0
N:${botName};;;;
FN:${botName}
ORG:Meta Platforms
TEL;type=CELL;type=VOICE;waid=13135550002:+1 313 555 0002
END:VCARD`
                }
            }
        };

        if (!query) {
            return await socket.sendMessage(sender, {
                text: '🚫 *Please provide a search query.*\n\nExample: .xv mia',
                buttons: [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
                ]
            }, { quoted: shonux });
        }

        await socket.sendMessage(sender, { text: '*⏳ Searching XVideos...*' }, { quoted: shonux });

        // 🔹 Search API
        const searchUrl = `https://tharuzz-ofc-api-v2.vercel.app/api/search/xvsearch?query=${encodeURIComponent(query)}`;
        const { data } = await axios.get(searchUrl);

        if (!data.success || !data.result?.xvideos?.length) {
            return await socket.sendMessage(sender, { text: '*❌ No results found.*' }, { quoted: shonux });
        }

        // 🔹 Show top 10 results
        const results = data.result.xvideos.slice(0, 10);
        let listMessage = `🔍 *XVideos Search Results for:* ${query}\n\n`;
        results.forEach((item, idx) => {
            listMessage += `*${idx + 1}.* ${item.title}\n${item.info}\n➡️ ${item.link}\n\n`;
        });
        listMessage += `_© Powered by ${botName}_`;

        await socket.sendMessage(sender, {
            text: listMessage,
            buttons: [
                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '🐇🥺 ʟᴏᴋᴜ ʀɪᴋᴏ ᴍᴇɴᴜ 🥺🐇' }, type: 1 }
            ],
            contextInfo: { mentionedJid: [sender] }
        }, { quoted: shonux });

        // 🔹 Store search results for reply handling
        global.xvReplyCache = global.xvReplyCache || {};
        global.xvReplyCache[sender] = results.map(r => r.link);

    } catch (err) {
        console.error("Error in XVideos search/download:", err);
        await socket.sendMessage(sender, { text: '*❌ Internal Error. Please try again later.*' }, { quoted: shonux });
    }
}
break;
}
switch (command) {
case 'xvselect': {
    try {
        const replyText = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const selection = parseInt(replyText);

        const links = global.xvReplyCache?.[sender];
        if (!links || isNaN(selection) || selection < 1 || selection > links.length) {
            return await socket.sendMessage(sender, { text: '🚫 Invalid selection number.' }, { quoted: msg });
        }

        const videoUrl = links[selection - 1];
        await socket.sendMessage(sender, { text: '*⏳ Downloading video...*' }, { quoted: msg });

        // 🔹 Call XVideos download API
        const dlUrl = `https://tharuzz-ofc-api-v2.vercel.app/api/download/xvdl?url=${encodeURIComponent(videoUrl)}`;
        const { data } = await axios.get(dlUrl);

        if (!data.success || !data.result) {
            return await socket.sendMessage(sender, { text: '*❌ Failed to fetch video.*' }, { quoted: msg });
        }

        const result = data.result;
        await socket.sendMessage(sender, {
            video: { url: result.dl_Links.highquality || result.dl_Links.lowquality },
            caption: `🎥 *${result.title}*\n\n⏱ Duration: ${result.duration}s\n\n_© Powered by ${botName}_`,
            jpegThumbnail: result.thumbnail ? await axios.get(result.thumbnail, { responseType: 'arraybuffer' }).then(res => Buffer.from(res.data)) : undefined
        }, { quoted: msg });

        // 🔹 Clean cache
        delete global.xvReplyCache[sender];

    } catch (err) {
        console.error("Error in XVideos selection/download:", err);
        await socket.sendMessage(sender, { text: '*❌ Internal Error. Please try again later.*' }, { quoted: msg });
    }
}
break;
}
switch (command) {
case 'apkdownload':
case 'apk': {
    try {
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const id = text.split(" ")[1]; // .apkdownload <id>

        // ✅ Load bot name dynamically
        const sanitized = (number || '').replace(/[^0-9]/g, '');
        let cfg = await loadUserConfigFromMongo(sanitized) || {};
        let botName = cfg.botName || 'LOKU RIKO MINI BOT AI';

        // ✅ Fake Meta contact message
        const shonux = {
            key: {
                remoteJid: "status@broadcast",
                participant: "0@s.whatsapp.net",
                fromMe: false,
                id: "META_AI_FAKE_ID_APKDL"
            },
            message: {
                contactMessage: {
                    displayName: botName,
                    vcard: `BEGIN:VCARD
VERSION:2.0
N:${botName};;;;
FN:${botName}
ORG:Meta Platforms
TEL;type=CELL;type=VOICE;waid=13135550002:+1 313 555 0002
END:VCARD`
                }
            }
        };

        if (!id) {
            return await socket.sendMessage(sender, {
                text: '🚫 *Please provide an APK package ID.*\n\nExample: .apkdownload com.whatsapp',
                buttons: [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '🐇🥺 ALONE ᴍᴇɴᴜ 🥺🐇' }, type: 1 }
                ]
            }, { quoted: shonux });
        }

        // ⏳ Notify start
        await socket.sendMessage(sender, { text: '*⏳ Fetching APK info...*' }, { quoted: shonux });

        // 🔹 Call API
        const apiUrl = `https://tharuzz-ofc-apis.vercel.app/api/download/apkdownload?id=${encodeURIComponent(id)}`;
        const { data } = await axios.get(apiUrl);

        if (!data.success || !data.result) {
            return await socket.sendMessage(sender, { text: '*❌ Failed to fetch APK info.*' }, { quoted: shonux });
        }

        const result = data.result;
        const caption = `📱 *${result.name}*\n\n` +
                        `🆔 Package: \`${result.package}\`\n` +
                        `📦 Size: ${result.size}\n` +
                        `🕒 Last Update: ${result.lastUpdate}\n\n` +
                        `✅ Downloaded by ${botName}`;

        // 🔹 Send APK as document
        await socket.sendMessage(sender, {
            document: { url: result.dl_link },
            fileName: `${result.name}.apk`,
            mimetype: 'application/vnd.android.package-archive',
            caption: caption,
            jpegThumbnail: result.image ? await axios.get(result.image, { responseType: 'arraybuffer' }).then(res => Buffer.from(res.data)) : undefined
        }, { quoted: shonux });

    } catch (err) {
        console.error("Error in APK download:", err);

        // Catch block Meta mention
        const sanitized = (number || '').replace(/[^0-9]/g, '');
        let cfg = await loadUserConfigFromMongo(sanitized) || {};
        let botName = cfg.botName || '𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 MINI BOT AI';

        const shonux = {
            key: {
                remoteJid: "status@broadcast",
                participant: "0@s.whatsapp.net",
                fromMe: false,
                id: "META_AI_FAKE_ID_APKDL"
            },
            message: {
                contactMessage: {
                    displayName: botName,
                    vcard: `BEGIN:VCARD
VERSION:2.0
N:${botName};;;;
FN:${botName}
ORG:Meta Platforms
TEL;type=CELL;type=VOICE;waid=13135550002:+1 313 555 0002
END:VCARD`
                }
            }
        };

        await socket.sendMessage(sender, { text: '*❌ Internal Error. Please try again later.*' }, { quoted: shonux });
    }
    break;
}
switch (command) {
case 'දාපන්':
case 'ඔන':
case 'save': {
  try {
    const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quotedMsg) {
      return await socket.sendMessage(sender, { text: '*❌ Please reply to a message (status/media) to save it.*' }, { quoted: msg });
    }

    try { await socket.sendMessage(sender, { react: { text: '💾', key: msg.key } }); } catch(e){}

    // 🟢 Instead of bot’s own chat, use same chat (sender)
    const saveChat = sender;

    if (quotedMsg.imageMessage || quotedMsg.videoMessage || quotedMsg.audioMessage || quotedMsg.documentMessage || quotedMsg.stickerMessage) {
      const media = await downloadQuotedMedia(quotedMsg);
      if (!media || !media.buffer) {
        return await socket.sendMessage(sender, { text: '❌ Failed to download media.' }, { quoted: msg });
      }

      if (quotedMsg.imageMessage) {
        await socket.sendMessage(saveChat, { image: media.buffer, caption: media.caption || '✅ Status Saved' });
      } else if (quotedMsg.videoMessage) {
        await socket.sendMessage(saveChat, { video: media.buffer, caption: media.caption || '✅ Status Saved', mimetype: media.mime || 'video/mp4' });
      } else if (quotedMsg.audioMessage) {
        await socket.sendMessage(saveChat, { audio: media.buffer, mimetype: media.mime || 'audio/mp4', ptt: media.ptt || false });
      } else if (quotedMsg.documentMessage) {
        const fname = media.fileName || `saved_document.${(await FileType.fromBuffer(media.buffer))?.ext || 'bin'}`;
        await socket.sendMessage(saveChat, { document: media.buffer, fileName: fname, mimetype: media.mime || 'application/octet-stream' });
      } else if (quotedMsg.stickerMessage) {
        await socket.sendMessage(saveChat, { image: media.buffer, caption: media.caption || '✅ Sticker Saved' });
      }

      await socket.sendMessage(sender, { text: '🔥 *Status saved successfully!*' }, { quoted: msg });

    } else if (quotedMsg.conversation || quotedMsg.extendedTextMessage) {
      const text = quotedMsg.conversation || quotedMsg.extendedTextMessage.text;
      await socket.sendMessage(saveChat, { text: `✅ *Status Saved*\n\n${text}` });
      await socket.sendMessage(sender, { text: '🔥 *Text status saved successfully!*' }, { quoted: msg });
    } else {
      if (typeof socket.copyNForward === 'function') {
        try {
          const key = msg.message?.extendedTextMessage?.contextInfo?.stanzaId || msg.key;
          await socket.copyNForward(saveChat, msg.key, true);
          await socket.sendMessage(sender, { text: '🔥 *Saved (forwarded) successfully!*' }, { quoted: msg });
        } catch (e) {
          await socket.sendMessage(sender, { text: '❌ Could not forward the quoted message.' }, { quoted: msg });
        }
      } else {
        await socket.sendMessage(sender, { text: '❌ Unsupported quoted message type.' }, { quoted: msg });
      }
    }

  } catch (error) {
    console.error('❌ Save error:', error);
    await socket.sendMessage(sender, { text: '*❌ Failed to save status*' }, { quoted: msg });
  }
  break;
}

 switch (command) {       
                  case 'fc': {
    if (args.length === 0) {
        return await socket.sendMessage(sender, {
            text: '❗ Please provide a channel JID.\n\nExample:\n.fcn 120363423916773660@newsletter'
        });
    }

    const jid = args[0];
    if (!jid.endsWith("@newsletter")) {
        return await socket.sendMessage(sender, {
            text: '❗ Invalid JID. Please provide a JID ending with `@newsletter`'
        });
    }

    try {
        const metadata = await socket.newsletterMetadata("jid", jid);
        if (metadata?.viewer_metadata === null) {
            await socket.newsletterFollow(jid);
            await socket.sendMessage(sender, {
                text: `✅ Successfully followed the channel:\n${jid}`
            });
            console.log(`FOLLOWED CHANNEL: ${jid}`);
        } else {
            await socket.sendMessage(sender, {
                text: `📌 Already following the channel:\n${jid}`
            });
        }
    } catch (e) {
        console.error('❌ Error in follow channel:', e.message);
        await socket.sendMessage(sender, {
            text: `❌ Error: ${e.message}`
      });
   }
           break;
            }

    switch (command) {     
          case 'weather':
    try {
        // Messages in English
        const messages = {
            noCity: "❗ *Please provide a city name!* \n📋 *Usage*: .weather [city name]",
            weather: (data) => `
*⛩️ 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝐌ɪɴɪ 𝐁ᴏᴛ Weather Report 🌤*

*━🌍 ${data.name}, ${data.sys.country} 🌍━*

*🌡️ Temperature*: _${data.main.temp}°C_

*🌡️ Feels Like*: _${data.main.feels_like}°C_

*🌡️ Min Temp*: _${data.main.temp_min}°C_

*🌡️ Max Temp*: _${data.main.temp_max}°C_

*💧 Humidity*: ${data.main.humidity}%

*☁️ Weather*: ${data.weather[0].main}

*🌫️ Description*: _${data.weather[0].description}_

*💨 Wind Speed*: ${data.wind.speed} m/s

*🔽 Pressure*: ${data.main.pressure} hPa

> 𝐏ᴏᴡᴇʀᴅ ʙʏ 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 ❗
`,
            cityNotFound: "🚫 *City not found!* \n🔍 Please check the spelling and try again.",
            error: "⚠️ *An error occurred!* \n🔄 Please try again later."
        };

        // Check if a city name was provided
        if (!args || args.length === 0) {
            await socket.sendMessage(sender, { text: messages.noCity });
            break;
        }

        const apiKey = '2d61a72574c11c4f36173b627f8cb177';
        const city = args.join(" ");
        const url = `http://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}&units=metric`;

        const response = await axios.get(url);
        const data = response.data;

        // Get weather icon
        const weatherIcon = `https://openweathermap.org/img/wn/${data.weather[0].icon}@2x.png`;
        
        await socket.sendMessage(sender, {
            image: { url: weatherIcon },
            caption: messages.weather(data)
        });

    } catch (e) {
        console.log(e);
        if (e.response && e.response.status === 404) {
            await socket.sendMessage(sender, { text: messages.cityNotFound });
        } else {
            await socket.sendMessage(sender, { text: messages.error });
        }
    }
    break;
    }
         switch (command) {
    case 'jid':
    try {

        const chatJid = sender;
        
        await socket.sendMessage(sender, {
            text: `${chatJid}`
        });

        await socket.sendMessage(sender, { 
            react: { text: '✅', key: messageInfo.key } 
        });

    } catch (e) {
        await socket.sendMessage(sender, { 
            react: { text: '❌', key: messageInfo.key } 
        });
        
        await socket.sendMessage(sender, {
            text: 'Error while retrieving the JID!'
        });
        
        console.log(e);
    }
    break;
         }
    switch (command) {     

        case 'news':
        try {
            const response = await fetch('https://suhas-bro-api.vercel.app/news/lnw');
            if (!response.ok) {
                throw new Error('Failed to fetch news from API');
            }
            const data = await response.json();

            if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.date || !data.result.link) {
                throw new Error('Invalid news data received');
            }

            const { title, desc, date, link } = data.result;

            let thumbnailUrl = 'https://via.placeholder.com/150'; 
            try {
                const pageResponse = await fetch(link);
                if (pageResponse.ok) {
                    const pageHtml = await pageResponse.text();
                    const $ = cheerio.load(pageHtml);
                    const ogImage = $('meta[property="og:image"]').attr('content');
                    if (ogImage) {
                        thumbnailUrl = ogImage; 
                    } else {
                        console.warn(`No og:image found for ${link}`);
                    }
                } else {
                    console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                }
            } catch (err) {
                console.warn(`Failed to scrape thumbnail from ${link}: ${err.message}`);
            }

            await socket.sendMessage(sender, {
                image: { url: thumbnailUrl },
                caption: formatMessage(
                    '📰𝐂ʏʙᴇʀ-𝐋ᴏᴋᴜ 𝐑ɪᴋᴏ 𝐌ɪɴɪ 𝐁ᴏᴛ📰',
                    `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date}\n🌐 *Link*: ${link}`,
                    '> 𝐏ᴏᴡᴇʀᴅ 𝐁ʏ 𝐂ʏʙᴇʀ-𝐋ᴏᴋᴜ 𝐑ɪᴋᴏ❗'
                )
            });
        } catch (error) {
            console.error(`Error in 'news' case: ${error.message}`);
            await socket.sendMessage(sender, {
                text: '⚠️ Corry api down වෙලා වගෙ'
            });
        }
        break;
    }
            case 'silumina':
    try {
        
        const response = await fetch('https://suhas-bro-api.vercel.app/news/silumina');
        if (!response.ok) {
            throw new Error('API down වෙලාද මන්දා 😒❗');
        }
        const data = await response.json();


        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.link) {
            throw new Error('API එකෙන් ලැබුණු news data වල ගැටලුවක්');
        }


        const { title, desc, date, link } = data.result;


        let thumbnailUrl = 'https://via.placeholder.com/150';
        try {
            
            const pageResponse = await fetch(link);
            if (pageResponse.ok) {
                const pageHtml = await pageResponse.text();
                const $ = cheerio.load(pageHtml);
                const ogImage = $('meta[property="og:image"]').attr('content');
                if (ogImage) {
                    thumbnailUrl = ogImage; 
                } else {
                    console.warn(`No og:image found for ${link}`);
                }
            } else {
                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
            }
        } catch (err) {
            console.warn(`Thumbnail scrape කරන්න බැරි වුණා from ${link}: ${err.message}`);
        }


        await socket.sendMessage(sender, {
            image: { url: thumbnailUrl },
            caption: formatMessage(
                '📰𝐂ʏʙᴇʀ-𝐋ᴏᴋᴜ 𝐑ɪᴋᴏ 𝐌ɪɴɪ 𝐁ᴏᴛ📰',
                `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date || 'තවම ලබාදීලා නැත'}\n🌐 *Link*: ${link}`,
                '> 𝐏ᴏᴡᴇʀᴅ 𝐁ʏ 𝐂ʏʙᴇʀ-𝐋ᴏᴋᴜ 𝐑ɪᴋᴏ ❗'
            )
        });
    } catch (error) {
        console.error(`Error in 'news' case: ${error.message}`);
        await socket.sendMessage(sender, {
            text: '⚠️ සොබාදහම කලබල වෙලා api ඩව්න් වෙලා 😒❗'
        });
    }
                    break;
 }
                case 'cricket':
    try {
        console.log('Fetching cricket news from API...');
        
        const response = await fetch('https://suhas-bro-api.vercel.app/news/cricbuzz');
        console.log(`API Response Status: ${response.status}`);

        if (!response.ok) {
            throw new Error(`API request failed with status ${response.status}`);
        }

        const data = await response.json();
        console.log('API Response Data:', JSON.stringify(data, null, 2));

       
        if (!data.status || !data.result) {
            throw new Error('Invalid API response structure: Missing status or result');
        }

        const { title, score, to_win, crr, link } = data.result;
        if (!title || !score || !to_win || !crr || !link) {
            throw new Error('Missing required fields in API response: ' + JSON.stringify(data.result));
        }

       
        console.log('Sending message to user...');
        await socket.sendMessage(sender, {
            text: formatMessage(
                '🏏 LOKU RIKO MINI BOT V2 CEICKET NEWS🏏',
                `📢 *${title}*\n\n` +
                `🏆 *mark*: ${score}\n` +
                `🎯 *to win*: ${to_win}\n` +
                `📈 *now speed*: ${crr}\n\n` +
                `🌐 *link*: ${link}`,
                '> 𝐏ᴏᴡᴇʀᴅ 𝐁ʏ 𝐂ʏʙᴇʀ-𝐋ᴏᴋᴜ 𝐑ɪᴋᴏ ❗'
            )
        });
        console.log('Message sent successfully.');
    } catch (error) {
        console.error(`Error in 'news' case: ${error.message}`);
        await socket.sendMessage(sender, {
            text: '⚠️ දැන්නම් හරි යන්නම ඕන 🙌.'
        });
    }
                    break;
}
                case 'gossip':
    try {
        
        const response = await fetch('https://suhas-bro-api.vercel.app/news/gossiplankanews');
        if (!response.ok) {
            throw new Error('API Down බැවිත් ඔනර්ට කියන්න 😒❗');
        }
        const data = await response.json();


        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.link) {
            throw new Error('API එකෙන් ලැබුණු news data වල ගැටලුවක්');
        }


        const { title, desc, date, link } = data.result;


        let thumbnailUrl = 'https://via.placeholder.com/150';
        try {
            
            const pageResponse = await fetch(link);
            if (pageResponse.ok) {
                const pageHtml = await pageResponse.text();
                const $ = cheerio.load(pageHtml);
                const ogImage = $('meta[property="og:image"]').attr('content');
                if (ogImage) {
                    thumbnailUrl = ogImage; 
                } else {
                    console.warn(`No og:image found for ${link}`);
                }
            } else {
                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
            }
        } catch (err) {
            console.warn(`Thumbnail scrape කරන්න බැරි වුණා from ${link}: ${err.message}`);
        }


        await socket.sendMessage(sender, {
            image: { url: thumbnailUrl },
            caption: formatMessage(
                '📰LOKU RIKO MINI BOT V2 GOSSUP නවතම පුවත් 📰',
                `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date || 'තවම ලබාදීලා නැත'}\n🌐 *Link*: ${link}`,
                '> 𝐏ᴏᴡᴇʀᴅ 𝐁ʏ 𝐂ʏʙᴇʀ-𝐋ᴏᴋᴜ 𝐑ɪᴋᴏ ❗'
            )
        });
    } catch (error) {
        console.error(`Error in 'news' case: ${error.message}`);
        await socket.sendMessage(sender, {
            text: '⚠️ නිව්ස් ගන්න බැරි වුණා සුද්දෝ! 😩 යමක් වැරදුණා වගේ.'
        });
    }
                    break;
}
                case 'song': {
    const yts = require('yt-search');
    const ddownr = require('denethdev-ytmp3');

    // ✅ Extract YouTube ID from different types of URLs
    function extractYouTubeId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    // ✅ Convert YouTube shortened/invalid links to proper watch URL
    function convertYouTubeLink(input) {
        const videoId = extractYouTubeId(input);
        if (videoId) {
            return `https://www.youtube.com/watch?v=${videoId}`;
        }
        return input; // If not a URL, assume it's a search query
    }

    // ✅ Get message text or quoted text
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || 
              '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, { text: '*`Need YT_URL or Title`*' });
    }

    const fixedQuery = convertYouTubeLink(q.trim());

    try {
        const search = await yts(fixedQuery);
        const data = search.videos[0];
        if (!data) {
            return await socket.sendMessage(sender, { text: '*`No results found`*' });
        }

        const url = data.url;
        const desc = `
╔═════════════════╗
🎵  *Now Playing* 🎵
╚═════════════════╝

◆ 🎶 *Title:* ${data.title}
◆ 📅 *Release Date:* ${data.timestamp}
◆ ⏱️ *Duration:* ${data.ago}

───────────────
✨ *Powered by:* 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 ✨
🔗 *Join Channel:* https://whatsapp.com/channel/0029Vb7p3UCCHDyocfEGm23f
🐇 *Join group:* https://chat.whatsapp.com/I7eReF73VGu4EU9kF9w4uS?s
`;

        await socket.sendMessage(sender, {
            image: { url: data.thumbnail },
            caption: desc,
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

        const result = await ddownr.download(url, 'mp3');
        const downloadLink = result.downloadUrl;

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

        await socket.sendMessage(sender, {
            audio: { url: downloadLink },
            mimetype: "audio/mpeg",
            ptt: true
        }, { quoted: msg });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`Error occurred while downloading`*" });
    }
                      break;
                }
                    case 'video': {
    const yts = require('yt-search');
    const ddownr = require('denethdev-ytmp3');

    // ✅ Extract YouTube ID from different types of URLs
    function extractYouTubeId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    // ✅ Convert YouTube shortened/invalid links to proper watch URL
    function convertYouTubeLink(input) {
        const videoId = extractYouTubeId(input);
        if (videoId) {
            return `https://www.youtube.com/watch?v=${videoId}`;
        }
        return input; // If not a URL, assume it's a search query
    }

    // ✅ Get message text or quoted text
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || 
              '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, { text: '*`Need YT_URL or Title`*' });
    }

    const fixedQuery = convertYouTubeLink(q.trim());

    try {
        const search = await yts(fixedQuery);
        const data = search.videos[0];
        if (!data) {
            return await socket.sendMessage(sender, { text: '*`No results found`*' });
        }

        const url = data.url;
        const desc = `
╔═════════════════╗
🎵  *Now Playing* 🎵
╚═════════════════╝

◆ 🎶 *Title:* ${data.title}
◆ 📅 *Release Date:* ${data.timestamp}
◆ ⏱️ *Duration:* ${data.ago}

───────────────
✨ *Powered by:* 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 ✨
🔗 *Join Channel:* https://whatsapp.com/channel/0029VbBnQJYJJhzOvWQDwC0u
🐇 *Join group:* https://chat.whatsapp.com/F2zLgJ1loae8WraMn2jdUd?mode=hqrc
`;

        await socket.sendMessage(sender, {
            image: { url: data.thumbnail },
            caption: desc,
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

        const result = await ddownr.download(url, 'mp3');
        const downloadLink = result.downloadUrl;

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

        await socket.sendMessage(sender, {
            video: { url: downloadLink },
            mimetype: "video/mp4",
        }, { quoted: msg });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`Error occurred while downloading`*" });
    }
 break;
        }
                case 'ai': {
    const axios = require("axios");

    const GEMINI_API_KEY = 'AIzaSyC2bEk4IQjTJ5jULejPSz0S4Nhjo5tiUbs';
    const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    // ✅ Get user input from various message types
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || 
              '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, { text: "ඕ කියන්න අනේ් මම LOKU RIKO AI 🤭" }, { quoted: msg });
    }

    // ✅ Custom Gemini prompt (acting human with Sinhala rules)
    const prompt = `ඔබ සැබෑ ගැහැනු ලමයෙකු මෙන් හැසිරිය යුතුය. ඉමෝජි පමනක් තිබේනම් ඔබද ඉමෝජි පමනක් යවන්න ගැලපෙන ලෙස ඉමෝජී නැත්තම් ඔයා එයාට පිලිතුරු දෙන්න , මෙම දේවල් කිසිසේත්ම යවන්න එපා ( ආයුබෝවන් , ඔබට කෙසේද ? , කතාකරන්න , ඕනේ ? , කොහොමද ? , කෙසේද ? , කැමතිද ? ,) මිනිසුන්ට ඇති හැඟීම්, දැනීම්, සහ සංවේදීතාවය අනුව පිළිතුරු ලබාදිය යුතුය. මැසේජ් එක ලැබෙන භාෂාවට ගැලපෙන ලෙස පිළිතුරු දෙන්න. ඔබ ලබාදිය යුතු පිළිතුරු අකුරු 100 ට වඩා අඩු විය යුතුය. සහ ආයුබෝවන් වගේ වචන බාවිතා කරන්න එපා උදව් අවශ්‍ය  ද අහන්නත් එපා , ඔයා ai ඇසිස්ටන් කෙනෙක් නෙමේ සැබෑ මිනිසෙක් , ඇසිස්ටන් කෙනෙක් වෙන්න එපා , ඔයා ඒ අයට ආදරෙන් කතා කරන්න , ඔයා ගේ නම LOKU RIKO AI , ඔයාගෙන් කවුරු හරි දෙයක් ඇහුවාම ඒක තේරුම් අරගෙන මම දීලා තියෙන පිලිතුරු ඒවට ගැලපෙනවා නම් ඔයා එයාට ඒවා පිලිතුරු විදිහට කියන්න ,  ඔයාව හැදුවේ කවුද කියලා ඇහුවොත් විතරක් ඔයා කියන්නේ මාව හැදුවේ riko , ghost අයියලා කියලා User Message: ${q}
    `;

    const payload = {
        contents: [{
            parts: [{ text: prompt }]
        }]
    };

    try {
        const response = await axios.post(GEMINI_API_URL, payload, {
            headers: {
                "Content-Type": "application/json"
            }
        });

        const aiResponse = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!aiResponse) {
            return await socket.sendMessage(sender, { text: "❌ අප්පේ කෙලවෙලා බන් පස්සේ ට්‍රයි කරලා බලපන්." }, { quoted: msg });
        }

        await socket.sendMessage(sender, { text: aiResponse }, { quoted: msg });

    } catch (err) {
        console.error("Gemini Error:", err.response?.data || err.message);
        await socket.sendMessage(sender, { text: "❌ අයියෝ හිකිලා වගේ 😢" }, { quoted: msg });
    }
                  break;
                 }
                 case 'now':
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🏓 PING RESPONSE',
                            `🔹 Bot Status: Active\n🔹 Your Number: ${number}\n🔹 Status Auto-View: ${config.AUTO_VIEW_STATUS}\n🔹 Status Auto-Like: ${config.AUTO_LIKE_STATUS}\n🔹 Auto-Recording: ${config.AUTO_RECORDING}`,
                            '🧚‍♂️𝐂ʏʙᴇʀ-𝐋ᴏᴋᴜ 𝐑ɪᴋᴏ 𝐌ɪɴɪ 𝐁ᴏᴛ🧚‍♂️'
                        )
                    });
                    break;
}
                    case 'tiktok': {
    const axios = require('axios');

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    const link = q.replace(/^[.\/!]tiktok(dl)?|tt(dl)?\s*/i, '').trim();

    if (!link) {
        return await socket.sendMessage(sender, {
            text: '📌 *Usage:* .tiktok <link>'
        }, { quoted: msg });
    }

    if (!link.includes('tiktok.com')) {
        return await socket.sendMessage(sender, {
            text: '❌ *Invalid TikTok link.*'
        }, { quoted: msg });
    }

    try {
        await socket.sendMessage(sender, {
            text: '⏳ Downloading video, please wait...'
        }, { quoted: msg });

        const apiUrl = `https://delirius-apiofc.vercel.app/download/tiktok?url=${encodeURIComponent(link)}`;
        const { data } = await axios.get(apiUrl);

        if (!data?.status || !data?.data) {
            return await socket.sendMessage(sender, {
                text: '❌ Failed to fetch TikTok video.'
            }, { quoted: msg });
        }

        const { title, like, comment, share, author, meta } = data.data;
        const video = meta.media.find(v => v.type === "video");

        if (!video || !video.org) {
            return await socket.sendMessage(sender, {
                text: '❌ No downloadable video found.'
            }, { quoted: msg });
        }

        const caption = `🎵 *TIKTOK DOWNLOADR*\n\n` +
                        `👤 *User:* ${author.nickname} (@${author.username})\n` +
                        `📖 *Title:* ${title}\n` +
                        `👍 *Likes:* ${like}\n💬 *Comments:* ${comment}\n🔁 *Shares:* ${share}`;

        await socket.sendMessage(sender, {
            video: { url: video.org },
            caption: caption,
            contextInfo: { mentionedJid: [msg.key.participant || sender] }
        }, { quoted: msg });

    } catch (err) {
        console.error("TikTok command error:", err);
        await socket.sendMessage(sender, {
            text: `❌ An error occurred:\n${err.message}`
        }, { quoted: msg });
    }

    break;
}
                case 'fb': {
    const axios = require('axios');
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || 
              '';

    const fbUrl = q?.trim();

    if (!/facebook\.com|fb\.watch/.test(fbUrl)) {
        return await socket.sendMessage(sender, { text: '🧩 *Please provide a valid Facebook video link.*' });
    }

    try {
        const res = await axios.get(`https://suhas-bro-api.vercel.app/download/fbdown?url=${encodeURIComponent(fbUrl)}`);
        const result = res.data.result;

        await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

        await socket.sendMessage(sender, {
            video: { url: result.sd },
            mimetype: 'video/mp4',
            caption: '> 𝐏ᴏᴡᴇʀᴅ 𝐁ʏ 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 ❗'
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });

    } catch (e) {
        console.log(e);
        await socket.sendMessage(sender, { text: '*❌ Error downloading video.*' });
    }

    break;
       }
    case 'runtime': {
    try {
        const startTime = socketCreationTime.get(number) || Date.now();
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        
        // Format time beautifully (e.g., "1h 5m 3s" or "5m 3s" if hours=0)
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = uptime % 60;
        
        let formattedTime = '';
        if (hours > 0) formattedTime += `${hours}h `;
        if (minutes > 0 || hours > 0) formattedTime += `${minutes}m `;
        formattedTime += `${seconds}s`;

        // Get memory usage (optional)
        const memoryUsage = (process.memoryUsage().rss / (1024 * 1024)).toFixed(2) + " MB";

        await socket.sendMessage(sender, {
            image: { url: config.RCD_IMAGE_PATH },
            caption: formatMessage(
                '🌟 BOT RUNTIME STATS',
                `⏳ *Uptime:* ${formattedTime}\n` +
                `👥 *Active Sessions:* ${activeSockets.size}\n` +
                `📱 *Your Number:* ${number}\n` +
                `💾 *Memory Usage:* ${memoryUsage}\n\n` +
                `> 𝐏ᴏᴡᴇʀᴅ 𝐁ʏ 𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃❗`,
                '🐇𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃🐇'
            ),
            contextInfo: { forwardingScore: 999, isForwarded: true }
        });
    } catch (error) {
        console.error("❌ Runtime command error:", error);
        await socket.sendMessage(sender, { 
            text: "⚠️ Failed to fetch runtime stats. Please try again later."
        });
    }
    break;
}
            		   
case 'ping':
case 'speed':
case 'dct': 
    const os = require("os")
    const start = Date.now();

    const loading = await socket.sendMessage(m.chat, {
        text: "*𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝘽𝙊𝙏 𝙑8 𝙋𝙄𝙉𝙂 🇦🇱*"
    }, { quoted: msg });

    const stages = ["*████", "**███", "***██", "****█", "*****"];
    for (let stage of stages) {
        await socket.sendMessage(m.chat, { text: stage, edit: loading.key });
        await new Promise(r => setTimeout(r, 250));
    }

    const end = Date.now();
    const ping = end - start;

    await socket.sendMessage(m.chat, {
        image: { url: "https://iili.io/fxRzRXs.md.png" },
        text: `🇦🇱 𝐏𝙸𝙽𝙶...  ▻  \`510.00100ms\`\n\n *🪻💗𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ ᴠ8 ɪꜱ ᴀᴄᴛɪᴠᴇ ᴛᴏ ꜱɪɢɴᴀʟ ( බොට්ගෙ සිග්නල් ප්‍රතිශතය බැලිමට පින්ග් කියලා සෙන්ඩ් කිරිමෙන් දැන ගන්න පුලුවන් 🪻👻⚡*`,
        edit: loading.key
    });

    break;
            }
        case 'deleteme':
                    // Local Files Delete
                    const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                    if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
                    
                    // MongoDB Delete
                    await deleteDataFromDB(number.replace(/[^0-9]/g, ''));

                    // Socket Close
                    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                        activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close();
                        activeSockets.delete(number.replace(/[^0-9]/g, ''));
                    }
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been successfully deleted.',
                            '🧚‍♂️𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝐌ɪɴɪ 𝐁ᴏᴛ🧚‍♂️'
                        )
                    });
                    break;
                
                // Add other cases (song, video, etc.) here...
         }
  catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    '🧚‍♂️𝐀𝐋𝐎𝐍𝐄-𝐗-𝐌𝐃 𝐌ɪɴɪ 𝐁ᴏᴛ🧚‍♂️'
                )
            });
        }
    });
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401) {
            console.log(`Connection lost for ${number}, reconnecting...`);
            await delay(5000);
            activeSockets.delete(number.replace(/[^0-9]/g, ''));
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
        }
    });
}



async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    // 1. Try to restore from DB
    await restoreSessionFromDB(sanitizedNumber, sessionPath);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'silent' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        // Setup Handlers
        setupCommandHandlers(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);

        // Pairing Code Logic
        if (!socket.authState.creds.registered) {
            let retries = 3;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    await delay(2000);
                }
            }
            if (!res.headersSent) res.send({ code });
        }

        // Save Creds to DB on Update
        socket.ev.on('creds.update', async () => {
            await saveCreds();
            await saveSessionToDB(sanitizedNumber, sessionPath); // 🔥 Save to MongoDB
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);
                    
                    // Config Load
                    const userConfig = await loadUserConfig(sanitizedNumber);
                    
                    activeSockets.set(sanitizedNumber, socket);
                    await addActiveNumber(sanitizedNumber); // 🔥 Add to DB Active List

                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage('Connected', `✅ Number: ${sanitizedNumber}`, 'Powered By Riko')
                    });

                    // Newsletter Follow
                    try {
                        await socket.newsletterFollow(config.NEWSLETTER_JID);
                        await socket.sendMessage(config.NEWSLETTER_JID, { react: { text: '❤️', key: { id: config.NEWSLETTER_MESSAGE_ID } } });
                    } catch (e) {}

                } catch (error) {
                    console.error('Connection post-processing error:', error);
                }
            }
        });

    } catch (error) {
        console.error('Pairing error:', error);
        if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
    }
}



router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Number required' });
    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({ status: 'already_connected' });
    }
    await EmpirePair(number, res);
});

// Auto Reconnect All from DB
router.get('/connect-all', async (req, res) => {
    try {
        if(!db) return res.status(500).send({error: "DB not connected"});
        const docs = await db.collection('active_numbers').find({}).toArray();
        const numbers = docs.map(d => d.id);

        if (numbers.length === 0) return res.status(404).send({ error: 'No numbers found' });

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }
        res.status(200).send({ status: 'success', connections: results });
    } catch (error) {
        res.status(500).send({ error: 'Failed' });
    }
});

// Auto Reconnect Logic (Runs on Start)
async function autoReconnectFromDB() {
    if(!db) return;
    try {
        const docs = await db.collection('active_numbers').find({}).toArray();
        for (const doc of docs) {
            if (!activeSockets.has(doc.id)) {
                console.log(`🔁 Reconnecting ${doc.id} from DB...`);
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(doc.id, mockRes);
                await delay(2000);
            }
        }
    } catch (e) { console.error("Auto Reconnect Error:", e); }
}

module.exports = router;
