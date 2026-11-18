require('dotenv').config({ path: `${__dirname}/.env` });

const { Client, Intents, MessageActionRow, MessageSelectMenu, MessageEmbed, WebhookClient } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const THEME = '#16C9E8';
const LOG_CHANNEL_ID = '1572640189489348699';
const INITIAL_TICKET_ID = 54367;
const WARNING_DELAY = 5 * 60 * 1000;
const CLOSE_DELAY = 10 * 60 * 1000;
const client = new Client({
    intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MEMBERS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.DIRECT_MESSAGES],
    partials: ['CHANNEL', 'MESSAGE']
});
const db = new sqlite3.Database(path.join(__dirname, 'modmail.db'));
const webhookParts = process.env.WELCOME_WEBHOOK_URL?.match(/\/webhooks\/(\d+)\/([^/]+)/);
const welcomeWebhook = webhookParts ? new WebhookClient({ id: webhookParts[1], token: webhookParts[2] }) : null;
const inactivityTimers = new Map();

const products = {
    'terminal-lite-messenger': { label: 'Terminal Lite Messenger', channelId: '1272106705437589607' },
    'terminal-music-player': { label: 'Terminal Music Player', channelId: '1272838287354232852' },
    ipem: { label: 'IPEM', channelId: '1272106797242777650' },
    discord: { label: 'Discord', channelId: '1272107008371462204' },
    others: { label: 'Others', channelId: '1272107042588590092' }
};

function run(sql, values = []) {
    return new Promise((resolve, reject) => db.run(sql, values, function (error) {
        if (error) reject(error); else resolve(this);
    }));
}
function get(sql, values = []) {
    return new Promise((resolve, reject) => db.get(sql, values, (error, row) => error ? reject(error) : resolve(row)));
}
function all(sql, values = []) {
    return new Promise((resolve, reject) => db.all(sql, values, (error, rows) => error ? reject(error) : resolve(rows)));
}

async function migrateDatabase() {
    await run(`CREATE TABLE IF NOT EXISTS threads (
        user_id TEXT PRIMARY KEY, thread_channel_id TEXT, status TEXT NOT NULL,
        initial_message TEXT, last_interaction_time INTEGER, category TEXT
    )`);
    const columns = await all('PRAGMA table_info(threads)');
    const names = new Set(columns.map(column => column.name));
    const additions = {
        ticket_id: 'TEXT', created_at: 'INTEGER', closed_at: 'INTEGER',
        closure_reason: 'TEXT', closed_by: 'TEXT', last_moderator_message_at: 'INTEGER', inactivity_warning_sent_at: 'INTEGER'
    };
    for (const [name, type] of Object.entries(additions)) {
        if (!names.has(name)) await run(`ALTER TABLE threads ADD COLUMN ${name} ${type}`);
    }
    await run('CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}

function supportEmbed(title, description, color = THEME) {
    return new MessageEmbed().setTitle(title).setDescription(description).setColor(color).setTimestamp();
}
function userMessageEmbed(author, content) {
    return new MessageEmbed().setAuthor(author.username, author.displayAvatarURL({ dynamic: true }))
        .setDescription(content || '*No text content*').setColor(THEME).setTimestamp();
}
function ticketMenu() {
    return new MessageActionRow().addComponents(
        new MessageSelectMenu().setCustomId('select-product').setPlaceholder('Choose the product you need help with').addOptions([
            { label: 'Terminal Lite Messenger', description: 'Support for Terminal Lite Messenger', value: 'terminal-lite-messenger', emoji: '💬' },
            { label: 'Terminal Music Player', description: 'Support for Terminal Music Player', value: 'terminal-music-player', emoji: '🎵' },
            { label: 'IPEM', description: 'Intelligent Program Environment Maintainer', value: 'ipem', emoji: '🧠' },
            { label: 'Discord', description: 'Discord community support', value: 'discord', emoji: '💠' },
            { label: 'Others', description: 'Anything else related to Terminal', value: 'others', emoji: '🔧' }
        ])
    );
}

async function logActivity(type, details = {}, color = THEME) {
    try {
        const channel = await client.channels.fetch(LOG_CHANNEL_ID);
        if (!channel?.send) throw new Error('Logging channel is unavailable');
        const fields = Object.entries(details).filter(([, value]) => value !== undefined && value !== null)
            .map(([name, value]) => ({ name, value: String(value).slice(0, 1024), inline: false }));
        await channel.send({ embeds: [new MessageEmbed().setColor(color).setTitle(`Terminal Support • ${type}`).addFields(fields).setTimestamp()] });
    } catch (error) {
        console.error(`[Activity log] ${type}:`, error.message);
    }
}

function clearInactivityTimer(ticketId) {
    const timers = inactivityTimers.get(ticketId);
    if (timers) {
        clearTimeout(timers.warning);
        clearTimeout(timers.close);
        inactivityTimers.delete(ticketId);
    }
}

async function closeTicket(ticket, reason, closedBy = 'System') {
    clearInactivityTimer(ticket.ticket_id);
    const current = await get('SELECT * FROM threads WHERE user_id = ?', [ticket.user_id]);
    if (!current || current.status !== 'open') return;
    const thread = await client.channels.fetch(current.thread_channel_id).catch(() => null);
    const now = Date.now();
    await run('UPDATE threads SET status = ?, closed_at = ?, closure_reason = ?, closed_by = ? WHERE user_id = ?',
        ['closed', now, reason, closedBy, current.user_id]);
    const user = await client.users.fetch(current.user_id).catch(() => null);
    if (user) {
        const title = reason === 'inactivity' ? 'Ticket Closed – Inactivity' : 'Support ticket closed';
        const description = reason === 'inactivity'
            ? "This support ticket has been automatically closed because we didn't receive a response within the requested time.\n\nYou're always welcome to create a new support ticket if you need further assistance."
            : `Your ticket **#${current.ticket_id}** has been closed.\n\nReason: ${reason}`;
        await user.send({ embeds: [supportEmbed(title, description, reason === 'inactivity' ? '#5B6B7A' : THEME)] }).catch(error => logActivity('DM error', { ticket: current.ticket_id, error: error.message }, '#E74C3C'));
    }
    if (thread) {
        try {
            const { handleThreadClose } = require('./transcriptManager');
            await handleThreadClose(thread, current, { reason, closedBy, closedAt: now, ticketOwner: user });
            await thread.setArchived(true, `Terminal support ticket closed: ${reason}`);
        } catch (error) {
            await logActivity('Ticket closure error', { ticket: current.ticket_id, error: error.message }, '#E74C3C');
        }
    }
    await logActivity(reason === 'inactivity' ? 'Automatic ticket closure' : 'Manual ticket closure', {
        ticket: current.ticket_id, product: products[current.category]?.label || current.category,
        user: user ? `${user.tag} (${user.id})` : current.user_id, closedBy, reason
    }, reason === 'inactivity' ? '#5B6B7A' : '#16C9E8');
}

function scheduleInactivity(ticket, lastModeratorMessageAt = ticket.last_moderator_message_at) {
    clearInactivityTimer(ticket.ticket_id);
    if (!lastModeratorMessageAt || ticket.status !== 'open') return;
    const elapsed = Date.now() - Number(lastModeratorMessageAt);
    const warningDelay = Math.max(0, WARNING_DELAY - elapsed);
    const closeDelay = Math.max(0, CLOSE_DELAY - elapsed);
    const warning = setTimeout(async () => {
        const current = await get('SELECT * FROM threads WHERE user_id = ?', [ticket.user_id]);
        if (!current || current.status !== 'open' || current.inactivity_warning_sent_at || Number(current.last_moderator_message_at) !== Number(lastModeratorMessageAt) || Date.now() - Number(lastModeratorMessageAt) >= CLOSE_DELAY) return;
        const user = await client.users.fetch(ticket.user_id).catch(() => null);
        if (user) await user.send({ embeds: [supportEmbed('Ticket Inactivity Warning', "We haven't received a response from you yet.\n\nPlease reply within the next **5 minutes**, or this support ticket will automatically close due to inactivity.", '#5B6B7A')] }).catch(() => null);
        await run('UPDATE threads SET inactivity_warning_sent_at = ? WHERE user_id = ?', [Date.now(), ticket.user_id]);
        await logActivity('Inactivity warning', { ticket: current.ticket_id, user: ticket.user_id });
    }, warningDelay);
    const close = setTimeout(async () => {
        const current = await get('SELECT * FROM threads WHERE user_id = ?', [ticket.user_id]);
        if (!current || current.status !== 'open' || Number(current.last_moderator_message_at) !== Number(lastModeratorMessageAt)) return;
        await closeTicket(current, 'inactivity', 'System').catch(error => console.error('Auto-close failed:', error));
    }, closeDelay);
    inactivityTimers.set(ticket.ticket_id, { warning, close });
}

async function allocateTicket(userId, productKey, initialMessage) {
    await run('BEGIN IMMEDIATE TRANSACTION');
    try {
        const setting = await get("SELECT value FROM bot_settings WHERE key = 'last_ticket_id'");
        let candidate = setting ? Number(setting.value) + 15 + Math.floor(Math.random() * 41) : INITIAL_TICKET_ID;
        let attempts = 0;
        while (attempts++ < 4000) {
            const used = await get('SELECT user_id FROM threads WHERE ticket_id = ? AND status = ?', [String(candidate), 'open']);
            if (!used) break;
            candidate += 15 + Math.floor(Math.random() * 41);
        }
        if (attempts >= 4000) throw new Error('No ticket ID is available');
        const ticketId = String(candidate).padStart(5, '0');
        const now = Date.now();
        await run("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('last_ticket_id', ?)", [ticketId]);
        await run(`UPDATE threads SET ticket_id = ?, status = ?, category = ?, initial_message = ?, created_at = ?,
            thread_channel_id = NULL, closed_at = NULL, closure_reason = NULL, closed_by = NULL, last_moderator_message_at = NULL, inactivity_warning_sent_at = NULL, last_interaction_time = ? WHERE user_id = ?`,
            [ticketId, 'creating', productKey, initialMessage, now, now, userId]);
        await run('COMMIT');
        return { ticketId, createdAt: now };
    } catch (error) {
        await run('ROLLBACK').catch(() => null);
        throw error;
    }
}

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setActivity('Terminal support tickets', { type: 'WATCHING' });
    await migrateDatabase();
    const openTickets = await all("SELECT * FROM threads WHERE status = 'open' AND last_moderator_message_at IS NOT NULL");
    for (const ticket of openTickets) scheduleInactivity(ticket);
    await logActivity('Bot startup', { restoredInactivityTimers: openTickets.length, bot: client.user.tag });
});

client.on('guildMemberAdd', async member => {
    if (!welcomeWebhook) return;
    const embed = new MessageEmbed().setColor(THEME).setTitle('Welcome to Terminal')
        .setDescription(`╭─ **Welcome, ${member}!**\n│ Your username: \`${member.user.username}\`\n╰─ We are glad you are here. Explore the community and reach out whenever you need support.`)
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true })).setFooter('Terminal Community').setTimestamp();
    await welcomeWebhook.send({ embeds: [embed] }).catch(error => logActivity('Welcome webhook error', { user: member.user.id, error: error.message }, '#E74C3C'));
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.guild) {
        const ticket = await get('SELECT * FROM threads WHERE user_id = ?', [message.author.id]).catch(error => { console.error(error); return null; });
        if (ticket?.status === 'blocked') return;
        if (ticket?.status === 'open') {
            const thread = await client.channels.fetch(ticket.thread_channel_id).catch(() => null);
            if (thread) {
                clearInactivityTimer(ticket.ticket_id);
                await run('UPDATE threads SET last_interaction_time = ?, last_moderator_message_at = NULL, inactivity_warning_sent_at = NULL WHERE user_id = ?', [Date.now(), ticket.user_id]);
                await thread.send({ embeds: [userMessageEmbed(message.author, message.content)] });
                await logActivity('User reply', { ticket: ticket.ticket_id, user: `${message.author.tag} (${message.author.id})`, product: products[ticket.category]?.label });
                return;
            }
            await run('UPDATE threads SET status = ? WHERE user_id = ?', ['closed', ticket.user_id]);
        }
        const initialMessage = ticket?.status === 'awaiting-product' ? `${ticket.initial_message}\n${message.content}` : message.content;
        await run('INSERT OR REPLACE INTO threads (user_id, status, initial_message, last_interaction_time) VALUES (?, ?, ?, ?)', [message.author.id, 'awaiting-product', initialMessage, Date.now()]);
        await message.author.send({ embeds: [supportEmbed('Terminal Support', 'Thanks for contacting Terminal. Choose the product your request is about, then our team will create a private support ticket.')], components: [ticketMenu()] });
        return;
    }
    if (!message.channel.isThread()) return;
    const ticket = await get("SELECT * FROM threads WHERE thread_channel_id = ? AND status = 'open'", [message.channel.id]).catch(() => null);
    if (!ticket) return;
    if (message.content.startsWith('!close')) {
        if (!message.member?.permissions.has('MANAGE_THREADS')) return message.reply('You need the Manage Threads permission to close a support ticket.');
        const reason = message.content.slice('!close'.length).trim() || 'Manually closed';
        await closeTicket(ticket, reason, `${message.author.tag} (${message.author.id})`);
        return;
    }
    if (message.content.startsWith('!')) return;
    const user = await client.users.fetch(ticket.user_id).catch(() => null);
    if (!user) return;
    await user.send({ embeds: [supportEmbed('Support Team', message.content || '*No text content*').setAuthor('Support Team')] }).catch(error => logActivity('Message synchronization error', { ticket: ticket.ticket_id, error: error.message }, '#E74C3C'));
    const now = Date.now();
    await run('UPDATE threads SET last_moderator_message_at = ?, inactivity_warning_sent_at = NULL, last_interaction_time = ? WHERE user_id = ?', [now, now, ticket.user_id]);
    scheduleInactivity({ ...ticket, last_moderator_message_at: now });
    await logActivity('Moderator reply', { ticket: ticket.ticket_id, moderator: `${message.author.tag} (${message.author.id})`, product: products[ticket.category]?.label });
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isSelectMenu() || interaction.customId !== 'select-product') return;
    const productKey = interaction.values[0];
    const product = products[productKey];
    if (!product) return interaction.reply({ content: 'That support product is unavailable. Please try again.', ephemeral: true });
    const ticket = await get('SELECT * FROM threads WHERE user_id = ?', [interaction.user.id]);
    if (ticket?.status === 'open' || ticket?.status === 'creating') return interaction.reply({ content: 'You already have an open support ticket.', ephemeral: true });
    if (ticket?.status !== 'awaiting-product') return interaction.reply({ content: 'Send a new DM to start a support ticket.', ephemeral: true });
    await interaction.deferUpdate();
    try {
        const allocation = await allocateTicket(interaction.user.id, productKey, ticket.initial_message);
        await logActivity('Product selected', { ticket: allocation.ticketId, product: product.label, user: `${interaction.user.tag} (${interaction.user.id})` });
        const parent = await client.channels.fetch(product.channelId);
        if (!parent?.threads) throw new Error('The configured product channel does not support threads');
        const thread = await parent.threads.create({ name: allocation.ticketId, autoArchiveDuration: 1440, reason: `Terminal support ticket #${allocation.ticketId}` });
        await run('UPDATE threads SET thread_channel_id = ?, status = ? WHERE user_id = ?', [thread.id, 'open', interaction.user.id]);
        await thread.send({ content: `<@${interaction.user.id}>`, embeds: [userMessageEmbed(interaction.user, ticket.initial_message).setTitle(`New ticket: #${allocation.ticketId} • ${product.label}`)] });
        await interaction.editReply({ embeds: [
            supportEmbed('Support ticket created', `Your request for **${product.label}** is now open.\n\nTicket ID: \`${allocation.ticketId}\``),
            supportEmbed('Conversation instructions', 'Reply in this DM to continue the conversation. Our support team will respond here shortly.', '#5B6B7A')
        ], components: [] });
        await logActivity('Ticket created', { ticket: allocation.ticketId, product: product.label, user: `${interaction.user.tag} (${interaction.user.id})`, thread: `<#${thread.id}>` });
    } catch (error) {
        await run('UPDATE threads SET status = ?, closure_reason = ? WHERE user_id = ?', ['closed', `Creation failed: ${error.message}`, interaction.user.id]).catch(() => null);
        await interaction.editReply({ content: 'The support ticket could not be created. Please send a new DM and try again.', embeds: [], components: [] });
        await logActivity('Ticket creation error', { user: `${interaction.user.tag} (${interaction.user.id})`, product: product.label, error: error.message }, '#E74C3C');
    }
});

process.on('SIGINT', async () => { await logActivity('Bot shutdown', { reason: 'SIGINT' }); client.destroy(); process.exit(0); });
process.on('SIGTERM', async () => { await logActivity('Bot shutdown', { reason: 'SIGTERM' }); client.destroy(); process.exit(0); });
client.login(process.env.TOKEN);
