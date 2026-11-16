const fs = require('fs');
const path = require('path');
const { MessageAttachment, MessageEmbed } = require('discord.js');

const tempDir = path.join(__dirname, 'temp_transcripts');
const counterFilePath = path.join(__dirname, 'ticket_counter.json');
const productNames = {
    'terminal-lite-messenger': 'Terminal Lite Messenger',
    'terminal-music-player': 'Terminal Music Player',
    ipem: 'IPEM', discord: 'Discord', others: 'Others'
};

if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

function getNextTicketNumber() {
    let count = 0;
    try { count = JSON.parse(fs.readFileSync(counterFilePath, 'utf8')).count || 0; } catch (_) { /* first ticket */ }
    count += 1;
    fs.writeFileSync(counterFilePath, JSON.stringify({ count }));
    return String(count).padStart(4, '0');
}

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
    const lines = ['TERMINAL SUPPORT TICKET', `Thread: ${thread.name}`, `Product: ${productNames[ticket?.category] || 'Others'}`, ''];
    for (const message of messages) {
        const time = message.createdAt.toISOString().slice(11, 19);
        const embeddedAuthor = message.embeds[0]?.author?.name;
        const sender = message.author.id === ticket?.user_id || (message.author.bot && embeddedAuthor) ? 'User' : (message.author.bot ? 'Bot' : 'MOD');
        const authorName = sender === 'User' && embeddedAuthor ? embeddedAuthor : message.author.username;
        const content = message.content || message.embeds.map(embed => embed.description || embed.title || '').filter(Boolean).join('\n') || '*No text content*';
        lines.push(`[${time}] [${sender}]`);
        lines.push(`Author: ${authorName}`);
        lines.push(`Message: ${content}`);
        lines.push('');
    }
    return lines.join('\n');
}

async function handleThreadClose(db, thread, closureInfo, done) {
    db.get('SELECT * FROM threads WHERE thread_channel_id = ?', [thread.id], async (error, ticket) => {
        if (error) return console.error('Transcript ticket lookup failed:', error);
        try {
            const number = getNextTicketNumber();
            const filename = `terminal-ticket-${number}.txt`;
            const filepath = path.join(tempDir, filename);
            fs.writeFileSync(filepath, buildTranscript(thread, await fetchAllMessages(thread), ticket), 'utf8');
            const parent = thread.parent || await thread.client.channels.fetch(thread.parentId);
            const embed = new MessageEmbed().setColor('#16C9E8').setTitle('Support Ticket Closed')
                .setDescription(`**Ticket:** \`${thread.name}\`\n**Product:** ${productNames[ticket?.category] || 'Others'}\n**Reason:** ${closureInfo.reason || 'Closed by support'}\n\n📄 Full conversation logs are attached above.`)
                .setTimestamp();
            await parent.send({ embeds: [embed], files: [new MessageAttachment(filepath, filename)] });
            fs.unlinkSync(filepath);
            done();
        } catch (failure) {
            console.error('Transcript upload failed:', failure);
        }
    });
}

module.exports = { handleThreadClose };
