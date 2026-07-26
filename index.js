import { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder, 
    REST, 
    Routes, 
    EmbedBuilder, 
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} from 'discord.js';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// File path for storing user tokens and credit data
const DB_FILE = path.join(process.cwd(), 'user_credits.json');

function loadUserCredits() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf-8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('Error reading user_credits.json:', e);
    }
    return {};
}

function saveUserCredits(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.error('Error writing user_credits.json:', e);
    }
}

const userStore = loadUserCredits();
const pendingRequests = new Map();

// Temporary store for modal form titles before image attachment step
// Key: `${userId}_draft` -> Value: { title, token }
const userDrafts = new Map();

const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const tgBot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// -------------------------------------------------------------
// 1. SLASH COMMANDS
// -------------------------------------------------------------
const commands = [
    new SlashCommandBuilder()
        .setName('thumbnail')
        .setDescription('Request a custom video thumbnail!')
        .addStringOption(option => 
            option.setName('title').setDescription('The title of your YouTube video').setRequired(true)
        )
        .addAttachmentOption(option =>
            option.setName('face_image').setDescription('Upload your face / reaction image').setRequired(true)
        )
        .addStringOption(option =>
            option.setName('token').setDescription('Enter your secret Token to unlock 20 Credits').setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('balance')
        .setDescription('Check your current Thumbnail credits'),
    new SlashCommandBuilder()
        .setName('setup_button')
        .setDescription('Post the interactive Thumbnail Request button in this channel (Admin only)'),
];

async function registerDiscordCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
    try {
        console.log('Registering Discord slash commands...');
        await rest.put(
            Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
            { body: commands }
        );
        console.log('Slash commands registered successfully!');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
}

// -------------------------------------------------------------
// 2. DISCORD INTERACTION LISTENER
// -------------------------------------------------------------
discordClient.on('interactionCreate', async interaction => {
    const userId = interaction.user.id;
    const userTag = interaction.user.tag;

    if (!userStore[userId]) {
        userStore[userId] = {
            hasUsedFreeTrial: false,
            credits: 0,
            userTag: userTag,
            usedTokens: []
        };
        saveUserCredits(userStore);
    }
    const userData = userStore[userId];

    // --- COMMAND: /setup_button ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup_button') {
        const embed = new EmbedBuilder()
            .setTitle('🎨 YouTube Thumbnail Generator')
            .setDescription('Need a high-converting, professional YouTube thumbnail for your video?\n\nClick the button below to get started!')
            .addFields(
                { name: '🎁 Free Trial', value: '1st Thumbnail is 100% FREE!', inline: true },
                { name: '💳 Token Credits', value: 'Paste Token for 20 Credits!', inline: true }
            )
            .setColor(0x5865F2);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('btn_request_thumbnail')
                .setLabel('🎨 Create Thumbnail')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('btn_redeem_token')
                .setLabel('🔑 Redeem Token (+20 Credits)')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('btn_check_balance')
                .setLabel('💳 Balance')
                .setStyle(ButtonStyle.Secondary)
        );

        await interaction.reply({ embeds: [embed], components: [row] });
        return;
    }

    // --- BUTTON: Check Balance ---
    if (interaction.isButton() && interaction.customId === 'btn_check_balance') {
        const embed = new EmbedBuilder()
            .setTitle('💳 Your Thumbnail Credits')
            .setColor(userData.credits > 0 ? 0x57F287 : 0xED4245)
            .addFields(
                { name: 'Remaining Credits', value: `**${userData.credits}**`, inline: true },
                { name: 'Free Trial Status', value: userData.hasUsedFreeTrial ? 'Used' : 'Available (1 Free Thumbnail)', inline: true }
            )
            .setFooter({ text: `User: ${userTag}` });

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // --- BUTTON: Redeem Token ---
    if (interaction.isButton() && interaction.customId === 'btn_redeem_token') {
        const modal = new ModalBuilder()
            .setCustomId('modal_redeem_token')
            .setTitle('🔑 Redeem Token');

        const tokenInput = new TextInputBuilder()
            .setCustomId('token_value')
            .setLabel('Paste your Token code here:')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Paste your Token code')
            .setRequired(true);

        const row = new ActionRowBuilder().addComponents(tokenInput);
        modal.addComponents(row);

        await interaction.showModal(modal);
        return;
    }

    // --- SUBMIT MODAL: Redeem Token ---
    if (interaction.isModalSubmit() && interaction.customId === 'modal_redeem_token') {
        const tokenVal = interaction.fields.getTextInputValue('token_value').trim();

        if (!userData.usedTokens) userData.usedTokens = [];
        userData.credits += 20;
        userData.usedTokens.push(tokenVal);
        saveUserCredits(userStore);

        // Forward to Telegram
        tgBot.telegram.sendMessage(
            process.env.TELEGRAM_ADMIN_CHAT_ID,
            `🎉 **USER REDEEMED TOKEN VIA BUTTON!**\n\n👤 **User:** ${userTag} (<@${userId}>)\n🔑 **Token:** \`${tokenVal}\`\n💳 **New Balance:** ${userData.credits} credits`,
            { parse_mode: 'Markdown' }
        ).catch(console.error);

        return interaction.reply({ 
            content: `🎉 **Token Accepted!** 20 Credits added to your account! Total Balance: **${userData.credits} Credits**. You can now click **🎨 Create Thumbnail**!`, 
            ephemeral: true 
        });
    }

    // --- BUTTON: Create Thumbnail ---
    if (interaction.isButton() && interaction.customId === 'btn_request_thumbnail') {
        // Check credits before opening modal
        if (userData.hasUsedFreeTrial && userData.credits <= 0) {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_redeem_token')
                    .setLabel('🔑 Redeem Token Now')
                    .setStyle(ButtonStyle.Success)
            );

            return interaction.reply({
                content: '⚠️ **You have 0 Credits left!** Click the button below to paste your **Token** and get **20 Credits**!',
                components: [row],
                ephemeral: true
            });
        }

        const modal = new ModalBuilder()
            .setCustomId('modal_create_thumbnail')
            .setTitle('🎨 Create Video Thumbnail');

        const titleInput = new TextInputBuilder()
            .setCustomId('video_title')
            .setLabel('YouTube Video Title:')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g. I Spent 100 Days in Minecraft!')
            .setRequired(true);

        const tokenInput = new TextInputBuilder()
            .setCustomId('opt_token')
            .setLabel('Token (Optional - paste if you have one):')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Paste Token here')
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder().addComponents(titleInput),
            new ActionRowBuilder().addComponents(tokenInput)
        );

        await interaction.showModal(modal);
        return;
    }

    // --- SUBMIT MODAL: Create Thumbnail ---
    if (interaction.isModalSubmit() && interaction.customId === 'modal_create_thumbnail') {
        const title = interaction.fields.getTextInputValue('video_title');
        const tokenVal = interaction.fields.getTextInputValue('opt_token')?.trim();

        // Process token if entered inside form
        let tokenMsg = '';
        if (tokenVal && tokenVal.length > 0) {
            if (!userData.usedTokens) userData.usedTokens = [];
            userData.credits += 20;
            userData.usedTokens.push(tokenVal);
            saveUserCredits(userStore);

            tokenMsg = `\n🎟️ **Token Redeemed:** \`${tokenVal}\` (+20 Credits!)`;

            tgBot.telegram.sendMessage(
                process.env.TELEGRAM_ADMIN_CHAT_ID,
                `🔑 **USER SUBMITTED TOKEN IN FORM!**\n\n👤 **User:** ${userTag} (<@${userId}>)\n🎟️ **Token:** \`${tokenVal}\`\n💳 **New Balance:** ${userData.credits} credits`,
                { parse_mode: 'Markdown' }
            ).catch(console.error);
        }

        // Save draft and prompt for image upload
        userDrafts.set(userId, { title, token: tokenVal });

        return interaction.reply({
            content: `📌 **Title:** "${title}"${tokenMsg}\n\n📸 **Final Step:** Please reply to this message with your **Face Reaction Image** (attach PNG/JPG image file)!`,
            ephemeral: true
        });
    }

    // --- SLASH COMMANDS HANDLER (/thumbnail & /balance) ---
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'balance') {
            const embed = new EmbedBuilder()
                .setTitle('💳 Your Thumbnail Credits')
                .setColor(userData.credits > 0 ? 0x57F287 : 0xED4245)
                .addFields(
                    { name: 'Remaining Credits', value: `**${userData.credits}**`, inline: true },
                    { name: 'Free Trial Used', value: userData.hasUsedFreeTrial ? 'Yes' : 'No (1 Free Thumbnail available!)', inline: true }
                )
                .setFooter({ text: `User: ${userTag}` });

            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (interaction.commandName === 'thumbnail') {
            await interaction.deferReply();

            const title = interaction.options.getString('title');
            const faceImage = interaction.options.getAttachment('face_image');
            const providedToken = interaction.options.getString('token');

            let tokenRedeemedNotice = '';
            if (providedToken && providedToken.trim().length > 0) {
                const cleanToken = providedToken.trim();
                if (!userData.usedTokens) userData.usedTokens = [];
                userData.credits += 20;
                userData.usedTokens.push(cleanToken);
                saveUserCredits(userStore);

                tokenRedeemedNotice = `\n🎟️ **Token Redeemed:** \`${cleanToken}\` (+20 Credits added!)`;

                tgBot.telegram.sendMessage(
                    process.env.TELEGRAM_ADMIN_CHAT_ID,
                    `🔑 **USER SUBMITTED A TOKEN!**\n\n👤 **User:** ${userTag} (<@${userId}>)\n🆔 **User ID:** \`${userId}\`\n🎟️ **Token:** \`${cleanToken}\`\n💳 **New Balance:** ${userData.credits} credits`,
                    { parse_mode: 'Markdown' }
                ).catch(console.error);
            }

            let isFreeTrialUse = false;
            if (!userData.hasUsedFreeTrial) {
                isFreeTrialUse = true;
            } else if (userData.credits <= 0) {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('btn_redeem_token')
                        .setLabel('🔑 Redeem Token Now')
                        .setStyle(ButtonStyle.Success)
                );

                const errorEmbed = new EmbedBuilder()
                    .setTitle('⚠️ Free Trial Completed - Token Required')
                    .setDescription('You have already used your **1 Free Thumbnail**!\n\nClick the button below to paste your **Token** and get **20 Credits**!')
                    .setColor(0xED4245);

                return interaction.editReply({ embeds: [errorEmbed], components: [row] });
            }

            if (!faceImage.contentType?.startsWith('image/')) {
                return interaction.editReply({ content: '❌ Please upload a valid image file (PNG, JPG, WEBP).' });
            }

            try {
                if (isFreeTrialUse) {
                    userData.hasUsedFreeTrial = true;
                } else {
                    userData.credits -= 1;
                }
                saveUserCredits(userStore);

                const remainingText = isFreeTrialUse ? '🎁 (Free Trial Used)' : `💳 (${userData.credits} Credits remaining)`;
                const tokenLogTelegram = providedToken ? `\n🔑 **Token Used:** \`${providedToken.trim()}\`` : '';

                const caption = 
                    `🎨 **New Thumbnail Request!** ${remainingText}\n\n` +
                    `👤 **Discord User:** ${userTag} (<@${userId}>)\n` +
                    `📌 **Video Title:** "${title}"${tokenLogTelegram}\n` +
                    `⏳ **Estimated Delivery:** ~3 minutes\n\n` +
                    `👉 **Reply to THIS photo message with the finished thumbnail image!**`;

                const tgMessage = await tgBot.telegram.sendPhoto(
                    process.env.TELEGRAM_ADMIN_CHAT_ID,
                    faceImage.url,
                    { caption, parse_mode: 'Markdown' }
                );

                pendingRequests.set(tgMessage.message_id.toString(), {
                    discordChannelId: interaction.channelId,
                    discordUserId: userId,
                    userTag: userTag,
                    title: title,
                    startTime: Date.now()
                });

                const embed = new EmbedBuilder()
                    .setTitle('🚀 Thumbnail Generation Started!')
                    .setDescription(
                        `Your thumbnail request for **"${title}"** is being created.\n` +
                        `Our designer will deliver it in **~3 minutes**!\n` +
                        `${tokenRedeemedNotice}\n\n` +
                        `Status: ${isFreeTrialUse ? '🎁 **Free Trial Used**' : `💳 **1 Credit Used** (${userData.credits} remaining)`}`
                    )
                    .setThumbnail(faceImage.url)
                    .setColor(0x5865F2)
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed] });

            } catch (error) {
                console.error('Error forwarding request to Telegram:', error);
                await interaction.editReply('❌ Failed to submit request to designer. Please try again.');
            }
        }
    }
});

// -------------------------------------------------------------
// 3. LISTEN FOR ATTACHMENT AFTER MODAL SUBMISSION
// -------------------------------------------------------------
discordClient.on('messageCreate', async message => {
    if (message.author.bot) return;

    const userId = message.author.id;
    const userTag = message.author.tag;
    const draft = userDrafts.get(userId);

    if (draft && message.attachments.size > 0) {
        const attachment = message.attachments.first();
        if (attachment.contentType?.startsWith('image/')) {
            const userData = userStore[userId];
            let isFreeTrialUse = false;

            if (!userData.hasUsedFreeTrial) {
                isFreeTrialUse = true;
                userData.hasUsedFreeTrial = true;
            } else if (userData.credits > 0) {
                userData.credits -= 1;
            } else {
                return message.reply('⚠️ You have 0 Credits left! Use `/thumbnail` or click **Redeem Token**!');
            }
            saveUserCredits(userStore);

            userDrafts.delete(userId);

            const remainingText = isFreeTrialUse ? '🎁 (Free Trial Used)' : `💳 (${userData.credits} Credits remaining)`;
            const caption = 
                `🎨 **New Thumbnail Request!** ${remainingText}\n\n` +
                `👤 **Discord User:** ${userTag} (<@${userId}>)\n` +
                `📌 **Video Title:** "${draft.title}"\n` +
                `⏳ **Estimated Delivery:** ~3 minutes\n\n` +
                `👉 **Reply to THIS photo message with the finished thumbnail image!**`;

            try {
                const tgMessage = await tgBot.telegram.sendPhoto(
                    process.env.TELEGRAM_ADMIN_CHAT_ID,
                    attachment.url,
                    { caption, parse_mode: 'Markdown' }
                );

                pendingRequests.set(tgMessage.message_id.toString(), {
                    discordChannelId: message.channelId,
                    discordUserId: userId,
                    userTag: userTag,
                    title: draft.title,
                    startTime: Date.now()
                });

                const embed = new EmbedBuilder()
                    .setTitle('🚀 Thumbnail Generation Started!')
                    .setDescription(`Your thumbnail request for **"${draft.title}"** is being created.\nOur designer will deliver it in **~3 minutes**!`)
                    .setThumbnail(attachment.url)
                    .setColor(0x5865F2)
                    .setTimestamp();

                await message.reply({ embeds: [embed] });

            } catch (err) {
                console.error('Error forwarding image to Telegram:', err);
                await message.reply('❌ Error forwarding request to Telegram.');
            }
        }
    }
});

// -------------------------------------------------------------
// 4. TELEGRAM BOT REPLY LISTENER (ADMIN DELIVERS THUMBNAIL)
// -------------------------------------------------------------
tgBot.on('message', async (ctx) => {
    const replyToMsg = ctx.message.reply_to_message;
    if (!replyToMsg) return;

    const reqId = replyToMsg.message_id.toString();
    const requestData = pendingRequests.get(reqId);

    if (!requestData) return;

    if (!ctx.message.photo || ctx.message.photo.length === 0) {
        return ctx.reply('⚠️ Please reply with a **photo/image** file for the thumbnail!');
    }

    try {
        const highestResPhoto = ctx.message.photo[ctx.message.photo.length - 1];
        const fileUrl = await tgBot.telegram.getFileLink(highestResPhoto.file_id);

        const channel = await discordClient.channels.fetch(requestData.discordChannelId);
        if (!channel) {
            return ctx.reply('❌ Could not find the original Discord channel.');
        }

        const elapsedSecs = Math.round((Date.now() - requestData.startTime) / 1000);
        const timeText = elapsedSecs < 60 ? `${elapsedSecs}s` : `${Math.floor(elapsedSecs / 60)}m ${elapsedSecs % 60}s`;

        const attachment = new AttachmentBuilder(fileUrl.href, { name: 'thumbnail.jpg' });
        const embed = new EmbedBuilder()
            .setTitle('✨ Your Thumbnail is Ready!')
            .setDescription(`Here is your custom thumbnail for **"${requestData.title}"**!\n\n⚡ Delivered in **${timeText}**.`)
            .setImage('attachment://thumbnail.jpg')
            .setColor(0x57F287)
            .setFooter({ text: `Requested by ${requestData.userTag}` })
            .setTimestamp();

        await channel.send({
            content: `<@${requestData.discordUserId}>`,
            embeds: [embed],
            files: [attachment]
        });

        pendingRequests.delete(reqId);
        await ctx.reply(`✅ Thumbnail successfully delivered to ${requestData.userTag} on Discord in ${timeText}!`);

    } catch (error) {
        console.error('Error delivering thumbnail to Discord:', error);
        await ctx.reply('❌ Error sending thumbnail to Discord: ' + error.message);
    }
});

async function start() {
    await registerDiscordCommands();
    await discordClient.login(process.env.DISCORD_BOT_TOKEN);
    console.log('🤖 Discord Bot logged in as ' + discordClient.user.tag);
    tgBot.launch().then(() => {
        console.log('✈️ Telegram Bot launched and ready for Admin replies!');
    });
}



start().catch(console.error);

process.once('SIGINT', () => tgBot.stop('SIGINT'));
process.once('SIGTERM', () => tgBot.stop('SIGTERM'));
