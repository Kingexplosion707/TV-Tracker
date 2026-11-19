const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, InteractionContextType, ApplicationIntegrationType } = require('discord.js');

// Single source of truth for the slash commands. The bot registers these
// itself on startup (index.js), so a deploy is all it takes — running
// `npm run deploy-commands` by hand is only needed for a GUILD_ID test server.
// Every command is server-only (no DMs) and installed with the bot to a server.
const base = (name, description) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

const commands = [
  base('track', "Start posting an AniList user's activity in this server").addStringOption((opt) =>
    opt.setName('username').setDescription('AniList username').setRequired(true).setMaxLength(50)
  ),
  base('untrack', 'Stop tracking an AniList user in this server').addStringOption((opt) =>
    opt.setName('username').setDescription('AniList username').setRequired(true).setMaxLength(50)
  ),
  base('list', 'List the AniList profiles tracked in this server'),
  base('whostracking', 'Who is being tracked and by whom (never pings anyone)'),
  base('setchannel', 'Choose the channel where AniList updates get posted')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Text channel for activity posts')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    ),
  base('watchlater', 'Your private watch later list'),
  base('myfavorites', 'Your private favorites list (saved with the 🤍 Favorite button)'),
  base('recommendanimes', 'The most-recommended anime — this server or global'),
  base('favorites', "Show someone's AniList favourites").addStringOption((opt) =>
    opt.setName('username').setDescription('AniList username').setRequired(true).setMaxLength(50)
  ),
  base('signin', 'Link your AniList account so only you control your profile'),
  base('signout', 'Unlink your AniList account from AniTracker'),
  base('tracking', 'Turn your live AniList activity posts on or off (everywhere)').addStringOption((opt) =>
    opt
      .setName('status')
      .setDescription('Leave empty to see your current setting')
      .setRequired(false)
      .addChoices({ name: 'On — post my activity', value: 'on' }, { name: 'Off — stop posting my activity', value: 'off' })
  ),
  base('update', 'Post an update notice in this server silently (no notifications)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt.setName('message').setDescription('Custom message — leave empty to post the latest AniTracker changelog').setRequired(false).setMaxLength(1800)
    )
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Where to post (defaults to the AniTracker channel)')
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    ),
  base('feedback', 'Rate AniTracker and send feedback to the developer'),
  base('help', 'All AniTracker commands and buttons'),
].map((c) => c.toJSON());

module.exports = { commands };
