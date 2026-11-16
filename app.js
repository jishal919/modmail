require('dotenv').config({ path: `${__dirname}/.env` });

const { Client, Intents, MessageActionRow, MessageSelectMenu, MessageEmbed, WebhookClient } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const THEME = '#16C9E8';
const client = new Client({
    intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MEMBERS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.DIRECT_MESSAGES],
    partials: ['CHANNEL', 'MESSAGE']
});
const db = new sqlite3.Database(path.join(__dirname, 'modmail.db'));
const webhookParts = process.env.WELCOME_WEBHOOK_URL?.match(/\/webhooks\/(\d+)\/([^/]+)/);
const welcomeWebhook = webhookParts ? new WebhookClient({ id: webhookParts[1], token: webhookParts[2] }) : null;

const products = {
    'terminal-lite-messenger': { label: 'Terminal Lite Messenger', channelId: '1272106705437589607' },
    'terminal-music-player': { label: 'Terminal Music Player', channelId: '1272838287354232852' },
    ipem: { label: 'IPEM', channelId: '1272106797242777650' },
    discord: { label: 'Discord', channelId: '1272107008371462204' },
    others: { label: 'Others', channelId: '1272107042588590092' }
};

db.run(`CREATE TABLE IF NOT EXISTS threads (
    user_id TEXT PRIMARY KEY, thread_channel_id TEXT, status TEXT NOT NULL,
    initial_message TEXT, last_interaction_time INTEGER, category TEXT
)`);

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

function supportEmbed(title, description) {
    return new MessageEmbed().setTitle(title).setDescription(description).setColor(THEME).setTimestamp();
}

function userMessageEmbed(author, content) {
    return new MessageEmbed().setAuthor(author.username, author.displayAvatarURL({ dynamic: true }))
        .setDescription(content || '*No text content*').setColor(THEME).setTimestamp();
}

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setActivity('Terminal support tickets', { type: 'WATCHING' });
    if (!welcomeWebhook) console.warn('WELCOME_WEBHOOK_URL is not configured; join messages are disabled.');
});

client.on('guildMemberAdd', async member => {
    if (!welcomeWebhook) return;
    const embed = new MessageEmbed().setColor(THEME).setTitle('Welcome to Terminal')
        .setDescription(`╭─ **Welcome, ${member}!**\n│ Your username: \`${member.user.username}\`\n╰─ We are glad you are here. Explore the community and reach out whenever you need support.`)
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true })).setFooter('Terminal Community').setTimestamp();
    await welcomeWebhook.send({ embeds: [embed] }).catch(error => console.error('Welcome webhook failed:', error));
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.guild) {
        const userId = message.author.id;
        db.get('SELECT * FROM threads WHERE user_id = ?', [userId], async (error, ticket) => {
            if (error) return console.error('Ticket lookup failed:', error);
            if (ticket?.status === 'blocked') return;
            if (ticket?.status === 'open') {
                const thread = await client.channels.fetch(ticket.thread_channel_id).catch(() => null);
                if (thread) {
                    await thread.send({ embeds: [userMessageEmbed(message.author, message.content)] });
                    db.run('UPDATE threads SET last_interaction_time = ? WHERE user_id = ?', [Date.now(), userId]);
                    return;
                }
                db.run('DELETE FROM threads WHERE user_id = ?', [userId]);
            }
            const initialMessage = ticket?.status === 'awaiting-product' ? `${ticket.initial_message}\n${message.content}` : message.content;
            db.run('INSERT OR REPLACE INTO threads (user_id, status, initial_message, last_interaction_time) VALUES (?, ?, ?, ?)',
                [userId, 'awaiting-product', initialMessage, Date.now()]);
            await message.author.send({
                embeds: [supportEmbed('Terminal Support', 'Thanks for contacting Terminal. Choose the product your request is about, then our team will create a private support ticket.')],
                components: [ticketMenu()]
            }).catch(error => console.error('Could not DM ticket menu:', error));
        });
        return;
    }
    if (!message.channel.isThread()) return;
    if (message.content.startsWith('!close')) {
        if (!message.member?.permissions.has('MANAGE_THREADS')) {
            await message.reply('You need the Manage Threads permission to close a support ticket.');
            return;
        }
        const reason = message.content.slice('!close'.length).trim() || 'Closed by support';
        db.get('SELECT * FROM threads WHERE thread_channel_id = ? AND status = ?', [message.channel.id, 'open'], async (error, ticket) => {
            if (error || !ticket) return;
            const user = await client.users.fetch(ticket.user_id).catch(() => null);
            if (user) await user.send({ embeds: [supportEmbed('Support ticket closed', reason)] }).catch(error => console.error('Could not notify ticket owner:', error));
            const { handleThreadClose } = require('./transcriptManager');
            handleThreadClose(db, message.channel, { reason, closedBy: message.author }, () => {
                db.run('DELETE FROM threads WHERE thread_channel_id = ?', [message.channel.id]);
                message.channel.delete(`Terminal support ticket closed: ${reason}`).catch(error => console.error('Could not delete support thread:', error));
            });
        });
        return;
    }
    if (message.content.startsWith('!')) return;
    db.get('SELECT * FROM threads WHERE thread_channel_id = ? AND status = ?', [message.channel.id, 'open'], async (error, ticket) => {
        if (error || !ticket) return;
        const user = await client.users.fetch(ticket.user_id).catch(() => null);
        if (user) await user.send({ embeds: [supportEmbed('Terminal Support', message.content || '*No text content*')
            .setAuthor(message.author.username, message.author.displayAvatarURL({ dynamic: true }))] }).catch(error => console.error('Could not forward staff reply:', error));
    });
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isSelectMenu() || interaction.customId !== 'select-product') return;
    const productKey = interaction.values[0];
    const product = products[productKey];
    if (!product) return interaction.reply({ content: 'That support product is unavailable. Please try again.', ephemeral: true });
    db.get('SELECT * FROM threads WHERE user_id = ?', [interaction.user.id], async (error, ticket) => {
        if (error) return console.error('Ticket lookup failed:', error);
        if (ticket?.status === 'open') return interaction.reply({ content: 'You already have an open support ticket.', ephemeral: true });
        if (ticket?.status !== 'awaiting-product') return interaction.reply({ content: 'Send a new DM to start a support ticket.', ephemeral: true });
        const parent = await client.channels.fetch(product.channelId).catch(() => null);
        if (!parent?.threads) return interaction.reply({ content: 'The support channel is unavailable. Please try again shortly.', ephemeral: true });
        const thread = await parent.threads.create({
            name: `${productKey}-${interaction.user.username}-${new Date().toISOString().slice(0, 10)}`.slice(0, 100),
            autoArchiveDuration: 1440, reason: `Terminal support ticket for ${product.label}`
        });
        db.run('UPDATE threads SET thread_channel_id = ?, status = ?, category = ?, last_interaction_time = ? WHERE user_id = ?',
            [thread.id, 'open', productKey, Date.now(), interaction.user.id]);
        await thread.send({ content: `<@${interaction.user.id}>`, embeds: [userMessageEmbed(interaction.user, ticket.initial_message).setTitle(`New ticket: ${product.label}`)] });
        await interaction.update({ embeds: [supportEmbed('Support ticket created', `Your request for **${product.label}** is now open. Reply in this DM to continue the conversation.`)], components: [] });
    });
});

client.login(process.env.TOKEN);
