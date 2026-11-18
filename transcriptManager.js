const fs = require('fs');
const path = require('path');
const { MessageAttachment, MessageEmbed } = require('discord.js');

const tempDir = path.join(__dirname, 'temp_transcripts');
const productNames = {
    'terminal-lite-messenger': 'Terminal Lite Messenger',
    'terminal-music-player': 'Terminal Music Player',
    ipem: 'IPEM', discord: 'Discord', others: 'Others'
};

if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

async function fetchAllMessages(thread) {
    const messages = [];
    let before;
    do {
        const page = await thread.messages.fetch({ limit: 100, ...(before && { before }) });
        messages.push(...page.values());
        before = page.lastKey();
        if (page.size < 100) break;
    } while (before);
    return messages.reverse();
}

function buildTranscript(thread, messages, ticket) {
    const lines = ['TERMINAL SUPPORT TICKET', `Ticket ID: ${ticket.ticket_id}`, `Thread: ${thread.name}`, `Product: ${productNames[ticket.category] || 'Others'}`, ''];
    for (const message of messages) {
        const time = message.createdAt.toISOString().slice(11, 19);
        const embeddedAuthor = message.embeds[0]?.author?.name;
        const sender = message.author.id === ticket.user_id || (message.author.bot && embeddedAuthor) ? 'User' : (message.author.bot ? 'Bot' : 'MOD');
        const authorName = sender === 'User' && embeddedAuthor ? embeddedAuthor : message.author.username;
        const content = message.content || message.embeds.map(embed => embed.description || embed.title || '').filter(Boolean).join('\n') || '*No text content*';
        lines.push(`[${time}] [${sender}]`);
        lines.push(`Author: ${authorName}`);
        lines.push(`Message: ${content}`);
        lines.push('');
    }
    return lines.join('\n');
}

async function handleThreadClose(thread, ticket, closureInfo) {
    const filename = `terminal-ticket-${ticket.ticket_id}.txt`;
    const filepath = path.join(tempDir, filename);
    try {
        fs.writeFileSync(filepath, buildTranscript(thread, await fetchAllMessages(thread), ticket), 'utf8');
        const parent = thread.parent || await thread.client.channels.fetch(thread.parentId);
        if (!parent?.send) throw new Error('Product logging channel is unavailable');
        const guildId = thread.guildId || thread.guild?.id;
        const threadUrl = guildId ? `https://discord.com/channels/${guildId}/${thread.id}` : `<#${thread.id}>`;
        const owner = closureInfo.ticketOwner;
        const createdAt = ticket.created_at ? `<t:${Math.floor(Number(ticket.created_at) / 1000)}:F>` : 'Unknown';
        const closedAt = `<t:${Math.floor(Number(closureInfo.closedAt) / 1000)}:F>`;
        const logEmbed = new MessageEmbed().setColor('#16C9E8').setTitle('Support Ticket Closed').addFields(
            { name: 'Ticket ID', value: `\`${ticket.ticket_id}\``, inline: true },
            { name: 'Product', value: productNames[ticket.category] || 'Others', inline: true },
            { name: 'Ticket Owner', value: owner ? `${owner.tag} (${owner.id})` : ticket.user_id, inline: false },
            { name: 'Discord Channel', value: `<#${thread.parentId}>`, inline: true },
            { name: 'Thread', value: `[Open ticket thread](${threadUrl})`, inline: true },
            { name: 'Created At', value: createdAt, inline: true },
            { name: 'Closed At', value: closedAt, inline: true },
            { name: 'Closure Reason', value: closureInfo.reason, inline: true },
            { name: 'Closed By', value: closureInfo.closedBy, inline: true }
        ).setFooter('Full conversation logs are attached above.').setTimestamp();
        await parent.send({ embeds: [logEmbed], files: [new MessageAttachment(filepath, filename)] });
    } finally {
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    }
}

module.exports = { handleThreadClose };
