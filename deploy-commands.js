require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('track')
    .setDescription("Start tracking an AniList user's activity feed")
    .addStringOption((opt) =>
      opt.setName('username').setDescription('AniList username').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('untrack')
    .setDescription('Stop tracking an AniList user')
    .addStringOption((opt) =>
      opt.setName('username').setDescription('AniList username').setRequired(true)
    ),
  new SlashCommandBuilder().setName('list').setDescription('List AniList users currently tracked in this server'),
  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('Set the channel where AniList updates get posted')
    .addChannelOption((opt) =>
      opt.setName('channel').setDescription('Target text channel').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('watchlater')
    .setDescription('Show your personal watch later list (private, only you see it)'),
  new SlashCommandBuilder()
    .setName('recommendanimes')
    .setDescription('Show the most-recommended anime/manga in this server, ranked highest to lowest'),
  new SlashCommandBuilder()
    .setName('favorites')
    .setDescription("Show a user's AniList favorites")
    .addStringOption((opt) =>
      opt.setName('username').setDescription('AniList username').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('whostracking')
    .setDescription('List who is being tracked and by whom, without pinging anyone'),
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
      console.error('Missing DISCORD_TOKEN or CLIENT_ID in your .env file.');
      process.exit(1);
    }

    const route = process.env.GUILD_ID
      ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
      : Routes.applicationCommands(process.env.CLIENT_ID);

    await rest.put(route, { body: commands });

    console.log(
      'Slash commands registered' +
        (process.env.GUILD_ID ? ' to your test server (instant).' : ' globally (can take up to ~1hr to show up).')
    );
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
})();
